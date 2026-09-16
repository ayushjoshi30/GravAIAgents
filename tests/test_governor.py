"""The Sarvam rate governor.

Sarvam Document Intelligence allows 10 requests a minute, uniformly across plan
tiers, and extract and digitise share the bucket. Adding workers does not move
that ceiling, so it has to be enforced in one place — and shared fairly, because
one tenant is 48% of the fleet's applications.
"""

from __future__ import annotations

import asyncio

import pytest
from gravai_sarvam.governor import RateGovernor, TokenBucket

DOCAI_RPM = 10.0


def test_bucket_starts_full() -> None:
    bucket = TokenBucket(capacity=DOCAI_RPM, refill_per_second=DOCAI_RPM / 60.0)
    assert bucket.tokens == DOCAI_RPM


def test_bucket_allows_exactly_the_minute_allowance() -> None:
    """Ten calls go through; the eleventh does not."""
    bucket = TokenBucket(capacity=DOCAI_RPM, refill_per_second=DOCAI_RPM / 60.0, last_refill=0.0)
    assert all(bucket.try_consume(0.0) for _ in range(10))
    assert bucket.try_consume(0.0) is False


def test_bucket_reports_the_wait_for_the_next_token() -> None:
    """At 10/min a token arrives every 6 seconds."""
    bucket = TokenBucket(capacity=DOCAI_RPM, refill_per_second=DOCAI_RPM / 60.0, last_refill=0.0)
    for _ in range(10):
        bucket.try_consume(0.0)
    assert bucket.wait_time(0.0) == pytest.approx(6.0)


def test_bucket_refills_continuously_not_in_steps() -> None:
    """Continuous refill avoids the stampede a fixed window causes each minute."""
    bucket = TokenBucket(capacity=DOCAI_RPM, refill_per_second=DOCAI_RPM / 60.0, last_refill=0.0)
    for _ in range(10):
        bucket.try_consume(0.0)
    assert bucket.try_consume(6.0) is True
    assert bucket.try_consume(6.0) is False


def test_bucket_never_exceeds_capacity() -> None:
    bucket = TokenBucket(capacity=DOCAI_RPM, refill_per_second=DOCAI_RPM / 60.0, last_refill=0.0)
    bucket.try_consume(0.0)
    bucket._refill(3600.0)
    assert bucket.tokens == DOCAI_RPM


async def test_governor_holds_the_ten_per_minute_ceiling() -> None:
    """Ten acquisitions succeed immediately; the eleventh has to wait."""
    governor = RateGovernor(limits={"docai": DOCAI_RPM})
    try:
        for _ in range(10):
            await governor.acquire("docai", "acme")

        assert governor.try_acquire("docai", "acme") is False

        stats = governor.stats("docai")
        assert stats.capacity == DOCAI_RPM
        assert stats.available < 1.0

        # The eleventh call must not complete promptly - at 10/min the next
        # token is six seconds away.
        pending = asyncio.create_task(governor.acquire("docai", "acme"))
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(pending), timeout=0.25)
        pending.cancel()
    finally:
        await governor.aclose()


async def test_governor_reports_queue_depth_for_the_console() -> None:
    governor = RateGovernor(limits={"docai": DOCAI_RPM})
    try:
        for _ in range(10):
            await governor.acquire("docai", "acme")

        waiters = [asyncio.create_task(governor.acquire("docai", "acme")) for _ in range(3)]
        await asyncio.sleep(0.05)

        stats = governor.stats("docai")
        assert stats.queue_depth == 3
        assert stats.tenants_waiting == 1
        assert stats.estimated_wait_seconds > 0

        for task in waiters:
            task.cancel()
        await asyncio.gather(*waiters, return_exceptions=True)
    finally:
        await governor.aclose()


async def test_one_tenants_batch_cannot_starve_another() -> None:
    """Fair share, not arrival order.

    The modelled fleet has one tenant at 48% of applications and 62% of documents.
    A FIFO queue would let its month-end batch block every other tenant, so the
    governor serves tenants round-robin: the small tenant's single request is
    answered before the large tenant's backlog drains.
    """
    governor = RateGovernor(limits={"docai": 600.0})  # 10/s, so the test is quick
    try:
        while governor.try_acquire("docai", "drain"):
            pass

        completed: list[str] = []

        async def request(tenant: str, label: str) -> None:
            await governor.acquire("docai", tenant)
            completed.append(label)

        tasks = [
            asyncio.create_task(request("lodestar", f"lodestar-{index}")) for index in (1, 2, 3)
        ]
        await asyncio.sleep(0.02)
        tasks.append(asyncio.create_task(request("acme", "acme-1")))
        await asyncio.sleep(0.02)

        # Both tenants must be queued before any release, or the assertion below
        # would be testing arrival order rather than fairness.
        queued = governor.stats("docai")
        assert queued.tenants_waiting == 2, "both tenants should be waiting"
        assert queued.queue_depth == 4

        await asyncio.wait_for(asyncio.gather(*tasks), timeout=10.0)

        assert completed.index("acme-1") < completed.index("lodestar-3")
    finally:
        await governor.aclose()
