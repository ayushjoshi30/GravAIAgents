"""HTTP transport for Sarvam.

Centralises the things every call needs and none should re-implement: the auth
header, timeouts, retry with jitter, a circuit breaker per product, and
translation of vendor errors into the platform's taxonomy.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass
from typing import Any

import httpx
from gravai_core.errors import (
    SarvamAuthError,
    SarvamError,
    SarvamRateLimited,
    SarvamServerError,
)
from gravai_core.settings import Settings, get_settings
from gravai_core.telemetry import get_logger

log = get_logger("gravai.sarvam.http")

#: Header Sarvam uses for API keys. Configurable because it is one of the
#: details to confirm against the dashboard (DECISIONS.md D-004).
AUTH_HEADER = "api-subscription-key"


@dataclass(slots=True)
class CircuitBreaker:
    """Stop hammering a provider that is already failing.

    Opens after ``threshold`` consecutive failures and half-opens after
    ``reset_seconds``, so one probe decides whether to close again.
    """

    threshold: int = 5
    reset_seconds: float = 30.0
    failures: int = 0
    opened_at: float | None = None

    def record_success(self) -> None:
        self.failures = 0
        self.opened_at = None

    def record_failure(self, now: float) -> None:
        self.failures += 1
        if self.failures >= self.threshold and self.opened_at is None:
            self.opened_at = now

    def is_open(self, now: float) -> bool:
        if self.opened_at is None:
            return False
        if now - self.opened_at >= self.reset_seconds:
            # Half-open: let one request through to test the water.
            self.opened_at = None
            self.failures = self.threshold - 1
            return False
        return True


@dataclass(slots=True)
class RetryPolicy:
    attempts: int = 5
    initial: float = 1.0
    multiplier: float = 2.0
    cap: float = 30.0
    jitter: float = 0.25

    def delay(self, attempt: int, rng: random.Random) -> float:
        base = min(self.initial * (self.multiplier**attempt), self.cap)
        return base * (1.0 + rng.uniform(-self.jitter, self.jitter))


class SarvamHTTP:
    """Thin async HTTP client with the platform's error taxonomy."""

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        client: httpx.AsyncClient | None = None,
        retry: RetryPolicy | None = None,
        seed: int | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.retry = retry or RetryPolicy()
        self._client = client
        self._owned = client is None
        self._breakers: dict[str, CircuitBreaker] = {}
        self._rng = random.Random(seed)

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.settings.sarvam_base_url,
                headers={
                    AUTH_HEADER: self.settings.sarvam_api_key,
                    "Accept": "application/json",
                },
                timeout=httpx.Timeout(connect=5.0, read=60.0, write=30.0, pool=5.0),
            )
        return self._client

    def _breaker(self, product: str) -> CircuitBreaker:
        if product not in self._breakers:
            self._breakers[product] = CircuitBreaker()
        return self._breakers[product]

    @staticmethod
    def _raise_for(response: httpx.Response) -> None:
        """Translate a vendor response into the platform's error taxonomy."""
        status = response.status_code
        if status < 400:
            return
        body = response.text[:500]
        if status in (401, 403):
            raise SarvamAuthError("Sarvam rejected the API key", status=status, body=body)
        if status == 429:
            retry_after = response.headers.get("Retry-After")
            raise SarvamRateLimited(
                "Sarvam rate limit hit",
                retry_after=float(retry_after) if retry_after else None,
                body=body,
            )
        if status >= 500:
            raise SarvamServerError("Sarvam server error", status=status, body=body)
        raise SarvamError("Sarvam request failed", status=status, body=body)

    async def request(
        self,
        method: str,
        path: str,
        *,
        product: str,
        json: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> httpx.Response:
        """Perform a request, retrying transient failures.

        Auth failures are never retried: the key will still be wrong next time,
        and each attempt is a billable round trip.
        """
        loop = asyncio.get_running_loop()
        breaker = self._breaker(product)
        if breaker.is_open(loop.time()):
            raise SarvamServerError(
                "Sarvam circuit breaker is open; refusing to send", product=product
            )

        last: Exception | None = None
        for attempt in range(self.retry.attempts):
            try:
                response = await self.client.request(
                    method,
                    path,
                    json=json,
                    files=files,
                    data=data,
                    params=params,
                    timeout=timeout,
                )
                self._raise_for(response)
                breaker.record_success()
                return response
            except SarvamAuthError:
                breaker.record_failure(loop.time())
                raise
            except (SarvamRateLimited, SarvamServerError, httpx.TransportError) as exc:
                last = exc
                breaker.record_failure(loop.time())
                if attempt == self.retry.attempts - 1:
                    break
                delay = self.retry.delay(attempt, self._rng)
                if isinstance(exc, SarvamRateLimited) and exc.retry_after:
                    delay = max(delay, exc.retry_after)
                log.warning(
                    "sarvam_retry",
                    product=product,
                    attempt=attempt + 1,
                    delay=round(delay, 2),
                    error=type(exc).__name__,
                )
                await asyncio.sleep(delay)

        if isinstance(last, SarvamError):
            raise last
        raise SarvamServerError(f"Sarvam request failed after retries: {last}")

    async def aclose(self) -> None:
        if self._client is not None and self._owned:
            await self._client.aclose()
        self._client = None
