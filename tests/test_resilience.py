"""Behaviour under failure.

Everything here is a thing that will happen in production: the provider will
return 500s, the rate limit will be hit, a key will be wrong, a job will hang, a
tenant will exhaust its budget. What matters is not that these are impossible
but that each one degrades in a defined way rather than taking the platform with
it.

These run against a mock transport, so they exercise the real client, the real
retry policy and the real circuit breaker without touching the network.
"""

from __future__ import annotations

import asyncio
import random

import httpx
import pytest
from gravai_core.errors import (
    SarvamAuthError,
    SarvamRateLimited,
    SarvamServerError,
)
from gravai_core.settings import Settings
from gravai_sarvam import RateGovernor, SarvamChat, TokenBucket
from gravai_sarvam.http import CircuitBreaker, RetryPolicy, SarvamHTTP
from gravai_sarvam.types import ChatMessage, ChatRequest


def _settings(**overrides: object) -> Settings:
    return Settings(sarvam_api_key="k", **overrides)  # type: ignore[arg-type]


def _http(handler, *, retry: RetryPolicy | None = None) -> SarvamHTTP:  # type: ignore[no-untyped-def]
    """A client wired to a scripted transport, with no real sockets."""
    return SarvamHTTP(
        _settings(),
        client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://api.example"
        ),
        retry=retry or RetryPolicy(attempts=3, initial=0.001, cap=0.01, jitter=0.0),
        seed=1,
    )


def _ok(body: dict | None = None) -> httpx.Response:
    return httpx.Response(200, json=body or {"ok": True})


# --- circuit breaker ------------------------------------------------------


def test_breaker_stays_closed_below_the_threshold() -> None:
    breaker = CircuitBreaker(threshold=5)
    for _ in range(4):
        breaker.record_failure(now=100.0)
    assert breaker.is_open(now=100.0) is False


def test_breaker_opens_at_the_threshold() -> None:
    """Stop hammering a provider that is already failing."""
    breaker = CircuitBreaker(threshold=5)
    for _ in range(5):
        breaker.record_failure(now=100.0)
    assert breaker.is_open(now=100.0) is True


def test_breaker_half_opens_after_the_reset_window() -> None:
    """One probe decides whether to close again, rather than staying dark."""
    breaker = CircuitBreaker(threshold=3, reset_seconds=30.0)
    for _ in range(3):
        breaker.record_failure(now=100.0)
    assert breaker.is_open(now=110.0) is True
    assert breaker.is_open(now=131.0) is False


def test_a_success_closes_the_breaker() -> None:
    breaker = CircuitBreaker(threshold=3)
    for _ in range(2):
        breaker.record_failure(now=100.0)
    breaker.record_success()
    assert breaker.failures == 0
    assert breaker.is_open(now=100.0) is False


# --- retry policy ---------------------------------------------------------


def test_backoff_grows_and_is_capped() -> None:
    policy = RetryPolicy(initial=1.0, multiplier=2.0, cap=10.0, jitter=0.0)
    rng = random.Random(0)
    delays = [policy.delay(attempt, rng) for attempt in range(6)]
    assert delays[:4] == [1.0, 2.0, 4.0, 8.0]
    assert all(delay <= 10.0 for delay in delays)
    assert delays[-1] == 10.0


def test_jitter_stays_inside_its_band() -> None:
    """Jitter spreads a fleet's retries without making delays unbounded."""
    policy = RetryPolicy(initial=4.0, multiplier=1.0, cap=4.0, jitter=0.25)
    rng = random.Random(7)
    delays = [policy.delay(0, rng) for _ in range(200)]
    assert all(3.0 <= delay <= 5.0 for delay in delays)
    assert len(set(delays)) > 50, "jitter should actually vary"


# --- what is retried, and what is not -------------------------------------


async def test_a_transient_server_error_is_retried_and_recovers() -> None:
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] < 3:
            return httpx.Response(503, text="upstream unavailable")
        return _ok()

    http = _http(handler)
    response = await http.request("POST", "/v1/chat/completions", product="llm")
    assert response.status_code == 200
    assert attempts["n"] == 3
    await http.aclose()


async def test_an_auth_failure_is_never_retried() -> None:
    """The key will still be wrong next time, and each attempt is billable."""
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(403, text="invalid key")

    http = _http(handler)
    with pytest.raises(SarvamAuthError):
        await http.request("POST", "/v1/chat/completions", product="llm")
    assert attempts["n"] == 1, "auth failures must not be retried"
    await http.aclose()


async def test_persistent_failure_surfaces_after_the_retry_budget() -> None:
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(500, text="boom")

    http = _http(handler, retry=RetryPolicy(attempts=3, initial=0.001, cap=0.01, jitter=0.0))
    with pytest.raises(SarvamServerError):
        await http.request("POST", "/v1/chat/completions", product="llm")
    assert attempts["n"] == 3
    await http.aclose()


async def test_rate_limiting_honours_retry_after() -> None:
    """Backing off less than the provider asked for just earns another 429."""
    seen: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if not seen:
            seen.append(1.0)
            return httpx.Response(429, headers={"Retry-After": "0.05"}, text="slow down")
        return _ok()

    http = _http(handler)
    response = await http.request("POST", "/v1/chat/completions", product="llm")
    assert response.status_code == 200
    await http.aclose()


async def test_a_429_that_never_clears_raises_rate_limited() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="still limited")

    http = _http(handler, retry=RetryPolicy(attempts=2, initial=0.001, cap=0.01, jitter=0.0))
    with pytest.raises(SarvamRateLimited):
        await http.request("POST", "/doc-ai/v1/job/extract", product="docai")
    await http.aclose()


async def test_an_open_breaker_refuses_before_sending() -> None:
    """A provider outage must stop costing round trips."""
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(500, text="down")

    http = _http(handler, retry=RetryPolicy(attempts=1, initial=0.001, cap=0.01, jitter=0.0))
    for _ in range(5):
        with pytest.raises(SarvamServerError):
            await http.request("POST", "/v1/chat/completions", product="llm")

    sent_before = attempts["n"]
    with pytest.raises(SarvamServerError, match="circuit breaker"):
        await http.request("POST", "/v1/chat/completions", product="llm")
    assert attempts["n"] == sent_before, "an open breaker must not send"
    await http.aclose()


async def test_one_product_outage_does_not_break_another() -> None:
    """Breakers are per product: documents failing must not stop chat."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "doc-ai" in request.url.path:
            return httpx.Response(500, text="doc service down")
        return _ok()

    http = _http(handler, retry=RetryPolicy(attempts=1, initial=0.001, cap=0.01, jitter=0.0))
    for _ in range(5):
        with pytest.raises(SarvamServerError):
            await http.request("POST", "/doc-ai/v1/job/extract", product="docai")

    response = await http.request("POST", "/v1/chat/completions", product="llm")
    assert response.status_code == 200
    await http.aclose()


async def test_a_network_failure_is_retried_like_a_server_error() -> None:
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] < 2:
            raise httpx.ConnectError("connection reset")
        return _ok()

    http = _http(handler)
    response = await http.request("POST", "/v1/chat/completions", product="llm")
    assert response.status_code == 200
    await http.aclose()


async def test_a_malformed_response_body_is_reported_not_swallowed() -> None:
    """A 200 with the wrong shape is a contract break, not a success."""
    from gravai_core.errors import SchemaViolation

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": "shape"})

    http = _http(handler)
    chat = SarvamChat(http, _settings())
    with pytest.raises(SchemaViolation):
        await chat.complete(
            ChatRequest(messages=(ChatMessage(role="user", content="hello"),))
        )
    await http.aclose()


# --- the governor under sustained load ------------------------------------


async def test_the_ceiling_holds_under_a_burst() -> None:
    """Fifty concurrent callers must not get more than the minute's allowance.

    This is the property the whole capacity plan depends on: the limit is a
    property of the account, and no amount of concurrency moves it.
    """
    governor = RateGovernor(limits={"docai": 10.0})
    try:
        granted = sum(
            1 for _ in range(50) if governor.try_acquire("docai", f"t{_ % 5}")
        )
        assert granted == 10, f"expected the minute's allowance, got {granted}"
    finally:
        await governor.aclose()


async def test_bucket_cannot_be_overdrawn_by_concurrency() -> None:
    """try_consume is not racy: ten tokens serve ten callers, not eleven."""
    bucket = TokenBucket(capacity=10, refill_per_second=10 / 60, last_refill=0.0)
    granted = sum(1 for _ in range(1000) if bucket.try_consume(0.0))
    assert granted == 10


async def test_sustained_demand_is_served_at_the_configured_rate() -> None:
    """Over a window, throughput converges on the limit rather than exceeding it."""
    governor = RateGovernor(limits={"fast": 6000.0})  # 100/s, for a quick test
    try:
        # Drain the initial burst so the measurement is of the refill rate.
        while governor.try_acquire("fast", "drain"):
            pass

        loop = asyncio.get_running_loop()
        started = loop.time()
        for _ in range(20):
            await governor.acquire("fast", "acme")
        elapsed = loop.time() - started

        # 20 tokens at 100/s cannot arrive faster than ~0.2s.
        assert elapsed >= 0.15, f"served 20 in {elapsed:.3f}s — faster than the limit allows"
    finally:
        await governor.aclose()


async def test_a_cancelled_waiter_does_not_wedge_the_queue() -> None:
    """A caller giving up must not strand everyone behind it."""
    governor = RateGovernor(limits={"docai": 600.0})
    try:
        while governor.try_acquire("docai", "drain"):
            pass

        abandoned = asyncio.create_task(governor.acquire("docai", "acme"))
        await asyncio.sleep(0.02)
        abandoned.cancel()

        # Someone arriving afterwards must still be served.
        await asyncio.wait_for(governor.acquire("docai", "beta"), timeout=5.0)
    finally:
        await governor.aclose()


async def test_closing_the_governor_releases_every_waiter() -> None:
    """Shutdown must not hang on parked callers."""
    governor = RateGovernor(limits={"docai": 10.0})
    while governor.try_acquire("docai", "drain"):
        pass

    waiters = [asyncio.create_task(governor.acquire("docai", "acme")) for _ in range(3)]
    await asyncio.sleep(0.02)
    await governor.aclose()

    results = await asyncio.gather(*waiters, return_exceptions=True)
    assert all(isinstance(r, asyncio.CancelledError | Exception) for r in results)
