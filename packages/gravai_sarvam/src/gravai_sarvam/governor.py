"""Rate governor for Sarvam products.

Sarvam Document Intelligence is capped at 10 requests per minute, uniformly
across Starter, Pro and Business — it is not a limit you can buy your way out
of, and adding workers does not move it. Extract and digitise draw on the same
bucket. This module is the single place that ceiling is enforced.

Fair share matters here, because tenant volume is never even. The fleet this is
sized for is modelled on one tenant holding 48% of applications and 62% of
documents. A naive FIFO queue would let that one tenant's month-end batch starve
the other seventeen, so waiters are served by weighted round-robin across tenants
rather than in arrival order.

The implementation is in-memory (single process). Phase 1 swaps the same
interface for a Redis token bucket shared across workers.
"""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Literal

Product = Literal["docai", "llm", "stt", "tts", "translate"]


@dataclass(slots=True)
class TokenBucket:
    """A leaky token bucket refilled continuously rather than in steps.

    Continuous refill avoids the thundering herd a fixed window produces at the
    top of each minute.
    """

    capacity: float
    refill_per_second: float
    #: Negative means "start full"; a token count can never legitimately be < 0.
    tokens: float = field(default=-1.0)
    #: None means "never refilled". A sentinel of 0.0 would be ambiguous, since
    #: an event loop's clock legitimately starts near zero — which silently
    #: disabled refilling whenever the first call happened at time 0.0.
    last_refill: float | None = field(default=None)

    def __post_init__(self) -> None:
        if self.tokens < 0:
            self.tokens = self.capacity

    def _refill(self, now: float) -> None:
        if self.last_refill is None:
            self.last_refill = now
            return
        elapsed = max(0.0, now - self.last_refill)
        self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_per_second)
        self.last_refill = now

    def try_consume(self, now: float, weight: float = 1.0) -> bool:
        """Take ``weight`` tokens if available."""
        self._refill(now)
        if self.tokens >= weight:
            self.tokens -= weight
            return True
        return False

    def wait_time(self, now: float, weight: float = 1.0) -> float:
        """Seconds until ``weight`` tokens would be available."""
        self._refill(now)
        if self.tokens >= weight:
            return 0.0
        if self.refill_per_second <= 0:
            return float("inf")
        return (weight - self.tokens) / self.refill_per_second


@dataclass(frozen=True, slots=True)
class GovernorStats:
    """What the console's throughput panel renders."""

    product: str
    capacity: float
    available: float
    queue_depth: int
    tenants_waiting: int
    estimated_wait_seconds: float
    #: Total units granted for this product since start, and the per-tenant
    #: split. This is what the console's throughput panel charts, and what makes
    #: "who is consuming the quota" answerable.
    served: int = 0
    served_by_tenant: dict[str, int] = field(default_factory=dict)


class RateGovernor:
    """Enforces per-product rate limits with fair sharing across tenants."""

    def __init__(
        self,
        *,
        limits: dict[str, float] | None = None,
        clock: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        #: Requests per minute, per product.
        self._limits: dict[str, float] = limits or {"docai": 10.0}
        self._buckets: dict[str, TokenBucket] = {}
        self._queues: dict[str, dict[str, deque[asyncio.Future[None]]]] = defaultdict(
            lambda: defaultdict(deque)
        )
        self._order: dict[str, deque[str]] = defaultdict(deque)
        self._lock = asyncio.Lock()
        self._pump_tasks: dict[str, asyncio.Task[None]] = {}
        self._loop = clock
        self._served: dict[str, int] = defaultdict(int)
        self._served_by_tenant: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    def _record_served(self, product: str, tenant_id: str, weight: float) -> None:
        self._served[product] += int(weight)
        self._served_by_tenant[product][tenant_id] += int(weight)

    # --- internals --------------------------------------------------------

    def _now(self) -> float:
        """Current monotonic time.

        Falls back to ``time.monotonic()`` outside an event loop so that
        read-only calls like ``stats()`` work from synchronous contexts — a
        health check or a CLI — instead of raising. Both clocks are monotonic,
        so mixing them cannot make time run backwards.
        """
        if self._loop is not None:
            return self._loop.time()
        try:
            return asyncio.get_running_loop().time()
        except RuntimeError:
            return time.monotonic()

    def _bucket(self, product: str) -> TokenBucket:
        if product not in self._buckets:
            rpm = self._limits.get(product, 60.0)
            self._buckets[product] = TokenBucket(
                capacity=rpm, refill_per_second=rpm / 60.0, last_refill=self._now()
            )
        return self._buckets[product]

    def _total_waiting(self, product: str) -> int:
        return sum(len(q) for q in self._queues[product].values())

    async def _pump(self, product: str) -> None:
        """Release waiters in weighted round-robin order as tokens appear."""
        while True:
            async with self._lock:
                if self._total_waiting(product) == 0:
                    self._pump_tasks.pop(product, None)
                    return
                bucket = self._bucket(product)
                now = self._now()

                released = False
                for _ in range(len(self._order[product])):
                    if not self._order[product]:
                        break
                    tenant = self._order[product][0]
                    queue = self._queues[product].get(tenant)

                    if not queue:
                        # Stale rotation entry for a tenant with nothing queued.
                        self._order[product].popleft()
                        continue

                    if not bucket.try_consume(now):
                        # Out of tokens. Do NOT rotate: this tenant keeps its
                        # turn. Rotating on a failed poll would advance the ring
                        # once per empty tick, so whoever happened to be at the
                        # head when a token finally arrived would win every
                        # time - which let a large tenant's backlog drain ahead
                        # of a small tenant that had been waiting longer.
                        break

                    waiter = queue.popleft()
                    # Rotate only after an actual release, so each tenant gets
                    # exactly one turn per token.
                    self._order[product].rotate(-1)

                    if not waiter.done():
                        waiter.set_result(None)
                        released = True

                    if not queue:
                        self._queues[product].pop(tenant, None)
                        if tenant in self._order[product]:
                            self._order[product].remove(tenant)
                    break

                delay = 0.01 if released else max(0.01, bucket.wait_time(now))

            await asyncio.sleep(min(delay, 1.0))

    def _ensure_pump(self, product: str) -> None:
        if product not in self._pump_tasks or self._pump_tasks[product].done():
            self._pump_tasks[product] = asyncio.create_task(self._pump(product))

    # --- public API -------------------------------------------------------

    async def acquire(self, product: str, tenant_id: str, weight: float = 1.0) -> None:
        """Wait until this tenant may make one call against ``product``.

        Never busy-waits: callers are parked on a future and woken by the pump.
        Long waits should be wrapped in a Temporal activity heartbeat.
        """
        async with self._lock:
            bucket = self._bucket(product)
            if self._total_waiting(product) == 0 and bucket.try_consume(self._now(), weight):
                self._record_served(product, tenant_id, weight)
                return
            loop = self._loop or asyncio.get_running_loop()
            waiter: asyncio.Future[None] = loop.create_future()
            if tenant_id not in self._queues[product]:
                self._order[product].append(tenant_id)
            self._queues[product][tenant_id].append(waiter)
            self._ensure_pump(product)

        await waiter
        self._record_served(product, tenant_id, weight)

    def try_acquire(self, product: str, tenant_id: str, weight: float = 1.0) -> bool:
        """Non-blocking attempt. Used by schedulers deciding whether to enqueue."""
        if self._total_waiting(product) > 0:
            return False
        granted = self._bucket(product).try_consume(self._now(), weight)
        if granted:
            self._record_served(product, tenant_id, weight)
        return granted

    def stats(self, product: str) -> GovernorStats:
        """Live state for the console's quota panel."""
        bucket = self._bucket(product)
        now = self._now()
        bucket._refill(now)
        waiting = self._total_waiting(product)
        return GovernorStats(
            product=product,
            capacity=bucket.capacity,
            available=round(bucket.tokens, 3),
            queue_depth=waiting,
            tenants_waiting=len(self._queues[product]),
            estimated_wait_seconds=round(
                bucket.wait_time(now) + max(0, waiting - 1) / max(bucket.refill_per_second, 1e-9),
                2,
            ),
            served=self._served.get(product, 0),
            served_by_tenant=dict(self._served_by_tenant.get(product, {})),
        )

    async def aclose(self) -> None:
        """Cancel pumps and fail any remaining waiters."""
        for task in list(self._pump_tasks.values()):
            task.cancel()
        self._pump_tasks.clear()
        for product_queues in self._queues.values():
            for queue in product_queues.values():
                while queue:
                    waiter = queue.popleft()
                    if not waiter.done():
                        waiter.cancel()
        self._queues.clear()
        self._order.clear()
