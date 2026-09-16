"""GravAI MCP server, over stdio.

Exposes the agent catalog as MCP tools so a host — Claude Desktop, or anything
else that speaks MCP — can run an agent and read its structured output.

    python -m gravai_mcp.server

Three things this deliberately does NOT do:

* **It does not invent tools.** The list comes from `tools.py`, which derives
  from the same agent catalog the REST API and the website read. If an agent is
  not in the catalog it is not a tool here.
* **It does not widen access.** A host sees only the tools the configured roles
  hold scopes for, via `tools_for_scopes`. Advertising a tool that will refuse
  is worse than not advertising it, because a model will keep trying.
* **It does not pretend a sandbox run is a real one.** Sandbox is forced on
  whenever no API key is configured, and every response says which mode it ran
  in. Sandbox output must never underwrite a decision.

Logging goes to stderr. On stdio, stdout is the protocol channel — anything
printed there corrupts the session.
"""

from __future__ import annotations

import json
import os
import sys
from decimal import Decimal
from typing import Any

# structlog is configured on the first gravai import and cached for the life of
# the process, so the level has to be set before those imports. On stdio a
# chatty logger is not merely noisy: it is the difference between a readable
# stderr and a wall of text while the host waits.
os.environ.setdefault("LOG_LEVEL", "WARNING")

import anyio
import mcp.types as types
from gravai_agents.catalog import AGENT_CATALOG
from gravai_core.auth import Role, Scope, scopes_for_roles
from gravai_core.settings import get_settings
from gravai_sarvam import build_sarvam
from mcp.server import InitializationOptions, NotificationOptions, Server
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.stdio import stdio_server

from .runner import RUNNABLE, AgentNotRunnable, SandboxFixtures, run_agent
from .tools import TOOL_CATALOG, tools_for_scopes

SERVER_NAME = "gravai"
SERVER_VERSION = "0.1.0"

INSTRUCTIONS = """\
GravAI runs auditable AI agents for Indian lending: document intelligence, bank
statement analytics, credit appraisal, risk scoring, KYC, collections and
operations research.

Two things to know before you read a result:

1. Several agents escalate by design. An escalation is the agent handing a
   decision to a person, not a failure. Report it as the outcome it is.
2. Arithmetic comes from code and language comes from the model. A risk
   probability is produced by a versioned scorecard, never generated. Do not
   recompute, re-rank or re-round any figure an agent returns.
"""


def _roles() -> list[Role]:
    """Roles this server runs as.

    stdio has no bearer token: the process itself is the trust boundary, so the
    operator states the roles when they configure the server.

    The default pairs underwriter with collections_manager, which between them
    reach all fourteen agents without granting tenant_admin. Narrow it to
    `underwriter` alone for lending only (ten tools), or widen it deliberately.
    An auditor holds no `agents:run` and so is offered nothing here, which is
    correct: reading the audit chain is a different surface.
    """
    raw = os.environ.get("GRAVAI_MCP_ROLES", "underwriter,collections_manager")
    names = [part.strip() for part in raw.split(",") if part.strip()]
    roles: list[Role] = []
    for name in names:
        try:
            roles.append(Role(name))
        except ValueError:
            print(f"gravai-mcp: ignoring unknown role {name!r}", file=sys.stderr)
    return roles or [Role("underwriter")]


async def _no_wait(_seconds: float) -> None:
    """Skip the back-off wait when there is no real job to wait for.

    The poll COUNT still accrues, so the call model and the cost ledger stay
    honest — a sandbox document still reports its twelve calls. What is skipped
    is only the wall-clock sleep between them, which in sandbox is waiting on a
    fixture. Without this a host sits for thirty seconds per document while
    nothing happens. Live mode keeps the real schedule.
    """
    return None


def _build_ai_layer() -> Any:
    """The AI layer, with the sandbox sleep suppressed."""
    cfg = get_settings()
    if cfg.sarvam_sandbox:
        return build_sarvam(cfg, sleep=_no_wait)
    return build_sarvam(cfg)


def _plain(value: Any) -> Any:
    """JSON-safe, without losing precision on a money value."""
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_plain(item) for item in value]
    return value


#: MCP advertises tool names (`score_risk`); the runner keys on agent ids
#: (`risk_scoring`). This is the only place the two vocabularies meet.
_TOOL_TO_AGENT: dict[str, str] = {
    spec.tool_name: agent_id for agent_id, spec in AGENT_CATALOG.items() if agent_id in RUNNABLE
}


def _caller_scopes() -> frozenset[Scope]:
    """The scopes of whoever is asking — not of whoever started the server.

    Over HTTP each request carries its own token, so the answer is per caller.
    On stdio there is no token: the operating system started the process, so
    the configured roles are the answer. Reading the server's own configuration
    over HTTP would show every caller the same tool list regardless of what
    their token actually permits.
    """
    access = get_access_token()
    if access is not None:
        held: set[Scope] = set()
        for raw in access.scopes:
            try:
                held.add(Scope(raw))
            except ValueError:
                continue
        return frozenset(held)
    return scopes_for_roles(_roles())


def _advertised(scopes: frozenset[Scope] | None = None) -> list[types.Tool]:
    """The tools this caller can actually run, filtered by their scopes.

    System tools are in the catalog but are not served here: they read the
    service layer, which this server has no session for. A tool that would
    always fail is not advertised.
    """
    permitted = tools_for_scopes(scopes if scopes is not None else _caller_scopes())
    out: list[types.Tool] = []
    for spec in permitted:
        if spec.family != "agent" or spec.name not in _TOOL_TO_AGENT:
            continue
        out.append(
            types.Tool(
                name=spec.name,
                title=spec.description.split(".")[0],
                description=(
                    f"{spec.description}\n\n"
                    "Runs the agent and returns its structured output, whether it "
                    "escalated, which guardrails passed, and what the run cost."
                ),
                input_schema=spec.input_schema,
                annotations=types.ToolAnnotations(
                    read_only_hint=spec.read_only,
                    destructive_hint=spec.destructive,
                    idempotent_hint=spec.read_only,
                    open_world_hint=True,
                ),
            )
        )
    return sorted(out, key=lambda tool: tool.name)


def _summarise(agent_id: str, tool_name: str, result: Any, sandbox: bool) -> str:
    """What the host reads. The caveats come first because they qualify the rest."""
    lines = [f"{tool_name} ({agent_id})"]
    if sandbox:
        lines.append(
            "MODE: sandbox — recorded fixtures, no vendor call, no spend. "
            "This output must not underwrite a real decision."
        )
    else:
        lines.append("MODE: live")

    if result.escalated:
        reason = result.escalation_reason or "an escalation rule matched"
        lines.append(f"ESCALATED (by design): {reason}")
    else:
        lines.append("Completed without escalation.")

    if result.validation.ok:
        lines.append("Guardrails: all passed.")
    else:
        lines.append("Guardrails: FAILED — treat this output as untrusted.")
        lines.extend(f"  - {violation}" for violation in result.validation.violations)

    lines.append(f"Cost: INR {result.cost_inr}")
    steps = ", ".join(f"{step.name}[{step.kind}]" for step in result.steps)
    if steps:
        lines.append(f"Steps: {steps}")

    summary = getattr(result.output, "reasoning_summary", None)
    if summary:
        lines.append("")
        lines.append(str(summary))
    return "\n".join(lines)


async def _on_list_tools(_ctx: Any, _params: Any) -> types.ListToolsResult:
    return types.ListToolsResult(tools=_advertised(_caller_scopes()))


async def _on_call_tool(_ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
    # Hiding a tool from the listing is presentation. This is the control: a
    # caller may name any tool they like, so permission is checked here, on the
    # scopes in their own token, before anything runs.
    permitted = {tool.name for tool in _advertised(_caller_scopes())}
    if params.name in _TOOL_TO_AGENT and params.name not in permitted:
        return types.CallToolResult(
            content=[
                types.TextContent(
                    type="text",
                    text=(
                        f"{params.name} requires scopes this token does not hold. "
                        "Ask for a token with the roles that carry them."
                    ),
                )
            ],
            is_error=True,
        )

    agent_id = _TOOL_TO_AGENT.get(params.name)
    if agent_id is None:
        known = ", ".join(sorted(_TOOL_TO_AGENT))
        return types.CallToolResult(
            content=[
                types.TextContent(
                    type="text",
                    text=f"No runnable tool named {params.name!r}. Available: {known}",
                )
            ],
            is_error=True,
        )

    sarvam = _build_ai_layer()
    try:
        result = await run_agent(
            agent_id,
            sarvam,
            fixtures=SandboxFixtures(sarvam, tenant_id="acme", tenant_name="Acme Finance Limited"),
            inputs=dict(params.arguments or {}),
        )
        payload = _plain(result.output.model_dump(mode="json"))
        structured = {
            "agent_id": agent_id,
            "mode": "sandbox" if sarvam.sandbox else "live",
            "escalated": result.escalated,
            "escalation_reason": result.escalation_reason,
            "guardrails_passed": result.validation.ok,
            "guardrail_violations": list(result.validation.violations),
            "cost_inr": str(result.cost_inr),
            "steps": [
                {"name": step.name, "kind": step.kind, "attempts": step.attempts}
                for step in result.steps
            ],
            "output": payload,
        }
        return types.CallToolResult(
            content=[
                types.TextContent(
                    type="text",
                    text=_summarise(agent_id, params.name, result, sarvam.sandbox),
                ),
                types.TextContent(
                    type="text", text=json.dumps(payload, indent=2, ensure_ascii=False)
                ),
            ],
            structured_content=structured,
            # A guardrail failure is a real failure: the host must not treat the
            # payload as usable just because the call returned.
            is_error=not result.validation.ok,
        )
    except ValueError as exc:
        # Raised when an argument is unknown or out of range. Saying which one
        # lets a host correct the call; a generic failure invites it to retry
        # the same arguments.
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=f"Invalid arguments: {exc}")],
            is_error=True,
        )
    except AgentNotRunnable:
        return types.CallToolResult(
            content=[
                types.TextContent(
                    type="text",
                    text=(
                        f"The catalog lists {agent_id!r} but this server cannot "
                        "assemble its inputs yet."
                    ),
                )
            ],
            is_error=True,
        )
    except Exception as exc:
        return types.CallToolResult(
            content=[
                types.TextContent(
                    type="text", text=f"{agent_id} failed: {type(exc).__name__}: {exc}"
                )
            ],
            is_error=True,
        )
    finally:
        await sarvam.aclose()


def build_server() -> Server:
    return Server(
        SERVER_NAME,
        version=SERVER_VERSION,
        title="GravAI",
        instructions=INSTRUCTIONS,
        on_list_tools=_on_list_tools,
        on_call_tool=_on_call_tool,
    )


async def serve() -> None:
    server = build_server()
    advertised = len(_advertised())
    roles = ", ".join(role.value for role in _roles())
    print(
        f"gravai-mcp: {advertised} of {len(TOOL_CATALOG)} catalog tools advertised "
        f"as roles [{roles}]",
        file=sys.stderr,
    )
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name=SERVER_NAME,
                server_version=SERVER_VERSION,
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
                instructions=INSTRUCTIONS,
            ),
        )


def main() -> None:
    anyio.run(serve)


if __name__ == "__main__":
    main()
