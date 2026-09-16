"""Load test: does the ceiling hold, and is it shared fairly?

Two questions a capacity plan has to answer before anyone commits to a volume:

1. Under a realistic fleet — many tenants submitting at once — does throughput
   stay at the configured limit, or does concurrency leak past it?
2. When one tenant is most of the book, does it starve the others?

Both are asked against the sandbox, so this costs nothing and can run in CI.

    uv run python scripts/loadtest.py
    uv run python scripts/loadtest.py --rpm 600 --documents 300 --seconds 20
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
from collections import Counter
from dataclasses import dataclass

from gravai_sarvam import RateGovernor

#: Tenant mix from the production book: one tenant is 48% of applications and
#: 62% of documents. A fair-share scheme that only works on an even split is not
#: a fair-share scheme.
FLEET: tuple[tuple[str, float], ...] = (
    ("lodestar", 0.62),
    ("acme", 0.14),
    ("northstar", 0.10),
    ("pinnacle", 0.08),
    ("vertex", 0.06),
)


@dataclass(slots=True)
class Outcome:
    tenant: str
    waited: float
    finished_at: float


async def _worker(
    governor: RateGovernor,
    tenant: str,
    units: int,
    results: list[Outcome],
    started: float,
    deadline: float,
) -> None:
    """One document: several quota units, as the real client consumes them."""
    loop = asyncio.get_running_loop()
    for _ in range(units):
        if loop.time() > deadline:
            return
        before = loop.time()
        await governor.acquire("docai", tenant)
        results.append(
            Outcome(tenant=tenant, waited=loop.time() - before, finished_at=loop.time() - started)
        )


async def run(rpm: float, documents: int, units: int, seconds: float) -> int:
    governor = RateGovernor(limits={"docai": rpm})
    results: list[Outcome] = []

    loop = asyncio.get_running_loop()
    started = loop.time()
    deadline = started + seconds

    tasks = []
    for tenant, share in FLEET:
        for _ in range(max(1, round(documents * share))):
            tasks.append(
                asyncio.create_task(
                    _worker(governor, tenant, units, results, started, deadline)
                )
            )

    try:
        await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=seconds + 5)
    except TimeoutError:
        pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await governor.aclose()

    elapsed = max(loop.time() - started, 1e-9)
    granted = len(results)

    # A token bucket legitimately allows an initial burst of `capacity` and then
    # sustains at the refill rate. Dividing total grants by elapsed time
    # conflates the two and reports a wild overshoot that is not one, so the
    # budget is modelled explicitly instead.
    burst_capacity = rpm
    refilled = rpm / 60 * elapsed
    allowance = burst_capacity + refilled
    leak = granted - allowance

    ordered = sorted(results, key=lambda outcome: outcome.finished_at)
    burst_phase = ordered[: int(burst_capacity)]
    sustained_phase = ordered[int(burst_capacity) :]
    sustained_rate = (
        len(sustained_phase)
        / max(elapsed - (burst_phase[-1].finished_at if burst_phase else 0), 1e-9)
        * 60
        if sustained_phase
        else 0.0
    )

    by_tenant = Counter(outcome.tenant for outcome in results)
    by_tenant_sustained = Counter(outcome.tenant for outcome in sustained_phase)
    waits = [outcome.waited for outcome in results if outcome.waited > 0]

    print()
    print("=" * 70)
    print("RATE GOVERNOR LOAD TEST")
    print("=" * 70)
    print(f"  configured limit        {rpm:,.0f} / minute")
    print(f"  documents offered       {documents:,} across {len(FLEET)} tenants")
    print(f"  quota units per doc     {units}")
    print(f"  window                  {elapsed:.1f}s")
    print()
    print(f"  units granted           {granted:,}")
    print(f"  budget (burst+refill)   {allowance:,.0f}  "
          f"= {burst_capacity:,.0f} burst + {refilled:,.0f} refilled")
    print(f"  leak beyond budget      {leak:+,.0f}")
    print(f"  sustained rate          {sustained_rate:,.1f} / minute")
    if waits:
        print(f"  wait p50 / p95          {statistics.median(waits):.2f}s / "
              f"{sorted(waits)[int(len(waits) * 0.95)]:.2f}s")
    print()
    print("  share of SUSTAINED units — what round-robin governs")
    for tenant, share in FLEET:
        got = by_tenant_sustained.get(tenant, 0)
        actual = got / len(sustained_phase) if sustained_phase else 0.0
        print(f"    {tenant:<12} {got:>6,}  {actual:>6.1%}   [{share:.0%} offered]")
    print()
    print("  share of the initial burst — first-come-first-served by design")
    for tenant, _ in FLEET:
        got = by_tenant.get(tenant, 0) - by_tenant_sustained.get(tenant, 0)
        print(f"    {tenant:<12} {got:>6,}")

    # The limit is a property of the account: no amount of concurrency may grant
    # more than the bucket held plus what refilled. A couple of units of slack
    # covers the clock read between the last grant and the measurement.
    ceiling_ok = leak <= 5
    # Every tenant must be served, however small its share.
    starvation_ok = all(by_tenant.get(tenant, 0) > 0 for tenant, _ in FLEET)
    # Fairness is a property of the queue. The burst is drained first-come —
    # at the production limit of 10/min that is one document's worth, but under
    # sustained pressure the round-robin must hold.
    biggest = FLEET[0][0]
    sustained_share = (
        by_tenant_sustained.get(biggest, 0) / len(sustained_phase) if sustained_phase else 0.0
    )
    fairness_ok = not sustained_phase or sustained_share <= 0.45

    print()
    print(f"  ceiling respected       {'PASS' if ceiling_ok else 'FAIL'}")
    print(f"  no tenant starved       {'PASS' if starvation_ok else 'FAIL'}")
    print(f"  sustained fair share    {'PASS' if fairness_ok else 'FAIL'}"
          f"   (largest tenant {sustained_share:.1%} of sustained grants)")
    print("=" * 70)
    print()
    print("  Note: the burst is drained first-come-first-served, which is what a")
    print("  token bucket does. At the production ceiling of 10/min the burst is")
    print("  ten units — under one document — so the sustained behaviour above is")
    print("  what actually governs a real fleet.")

    return 0 if (ceiling_ok and starvation_ok and fairness_ok) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Rate governor load test")
    parser.add_argument(
        "--rpm",
        type=float,
        default=600.0,
        help="requests per minute to enforce (default 600, so the run is short; "
        "production is 10)",
    )
    parser.add_argument("--documents", type=int, default=200)
    parser.add_argument(
        "--units", type=int, default=12, help="quota units per document (submit + polls + results)"
    )
    parser.add_argument("--seconds", type=float, default=15.0)
    args = parser.parse_args()

    return asyncio.run(run(args.rpm, args.documents, args.units, args.seconds))


if __name__ == "__main__":
    raise SystemExit(main())
