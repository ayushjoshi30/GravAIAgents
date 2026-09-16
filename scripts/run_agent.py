"""Run one agent against the sandbox and print what it produced.

There is no way to execute an agent from the web console today: the console
reads runs, it does not start them, and the only REST endpoint that executes
anything is the credit pipeline. This is the terminal equivalent of the MCP
server — same dispatcher, different front end.

    uv run python scripts/run_agent.py --list
    uv run python scripts/run_agent.py risk_scoring
    uv run python scripts/run_agent.py credit_appraisal --json

Sandbox only: with no API key configured every run is sandboxed, and sandbox
output must never underwrite a real decision.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import date, datetime
from decimal import Decimal
from typing import Any

# structlog is configured the first time any gravai logger is created, and that
# configuration is cached for the life of the process. So the level has to be
# set before the imports below rather than after argparse has run — hence the
# raw sys.argv check. Without it, eight document_complete lines scroll the
# actual answer off the screen.
if not {"--verbose", "-v"} & set(sys.argv):
    os.environ.setdefault("LOG_LEVEL", "WARNING")

from gravai_agents.catalog import AGENT_CATALOG
from gravai_mcp.runner import RUNNABLE, SandboxFixtures, run_agent
from gravai_sarvam import build_sarvam


async def _no_wait(_seconds: float) -> None:
    """Skip the back-off wait; the poll count still accrues."""
    return None


def _plain(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_plain(item) for item in value]
    return value


def _render(agent_id: str, result: Any) -> None:
    spec = AGENT_CATALOG[agent_id]
    steps = ", ".join(f"{step.name}[{step.kind}]" for step in result.steps)

    print()
    print(f"  {spec.name}  ({agent_id})")
    print(f"  {'-' * 64}")
    print(f"  escalated     : {result.escalated}")
    if result.escalation_reason:
        print(f"  reason        : {result.escalation_reason}")
    print(f"  guardrails    : {'passed' if result.validation.ok else 'FAILED'}")
    for violation in result.validation.violations:
        print(f"                  ! {violation}")
    print(f"  cost (INR)    : {result.cost_inr}")
    print(f"  steps         : {steps or '-'}")

    summary = getattr(result.output, "reasoning_summary", None)
    if summary:
        print()
        print(f"  {summary}")
    print()
    print("  Add --json for the full output payload.")
    print()


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run one GravAI agent against the sandbox.",
    )
    parser.add_argument("agent_id", nargs="?", help="agent id, e.g. risk_scoring")
    parser.add_argument("--list", action="store_true", help="list every agent id")
    parser.add_argument("--json", action="store_true", help="print the full output payload")
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="show the platform log lines as well as the result",
    )
    args = parser.parse_args()

    if args.list or not args.agent_id:
        print()
        print("  Agents you can run:")
        print()
        for spec in AGENT_CATALOG.values():
            mark = " " if spec.id in RUNNABLE else "*"
            print(f"  {mark} {spec.id:<28} {spec.name}")
        if len(RUNNABLE) != len(AGENT_CATALOG):
            print()
            print("  * no input wiring yet")
        print()
        return 0

    if args.agent_id not in AGENT_CATALOG:
        print(f"Unknown agent '{args.agent_id}'. Use --list to see the catalog.")
        return 2

    sarvam = build_sarvam(sleep=_no_wait)
    try:
        fixtures = SandboxFixtures(sarvam, tenant_id="acme", tenant_name="Acme Finance Limited")
        result = await run_agent(args.agent_id, sarvam, fixtures=fixtures)
        if args.json:
            payload = _plain(result.output.model_dump(mode="json"))
            print(json.dumps(payload, indent=2, ensure_ascii=False))
        else:
            _render(args.agent_id, result)
    finally:
        await sarvam.aclose()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
