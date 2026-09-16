"""The MCP server, exercised the way a host actually talks to it.

These drive the real server process over a real stdio session: initialize, list
the tools, call one, read the result. Unit-testing the handler functions would
pass while the process failed to speak the protocol at all, which is the
failure that actually matters here.

The session is opened inside each test rather than in a fixture. anyio cancel
scopes must be entered and exited in the same task, and a yielding fixture
tears down in a different one.
"""

from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

REPO = Path(__file__).resolve().parents[1]

#: The child's environment, passed explicitly because it is a real subprocess.
#:
#: `conftest.py` pins SARVAM_SANDBOX and clears the key before settings are
#: imported, which covers every test running in THIS process. These do not:
#: they spawn `python -m gravai_mcp.server`, and a child with no `env` reads
#: `.env` for itself. The moment a developer put a real SARVAM_API_KEY and
#: SARVAM_SANDBOX=0 in their own `.env` — which is the normal thing to do once
#: you have a key — this file started making live, billed calls to
#: api.sarvam.ai and failing with provider errors.
#:
#: The failure was loud, which was lucky. A suite that reaches a paid API
#: because of what is in somebody's local environment can just as easily pass
#: and quietly spend money, so the child is told what it is rather than left to
#: infer it. `os.environ` is inherited first so PATH and the interpreter still
#: work; only the provider settings are overridden.
_SERVER_ENV = {
    **os.environ,
    "SARVAM_API_KEY": "",
    "SARVAM_SANDBOX": "1",
    "APP_ENV": "local",
}

PARAMS = StdioServerParameters(
    command=sys.executable,
    args=["-m", "gravai_mcp.server"],
    cwd=str(REPO),
    env=_SERVER_ENV,
)


@asynccontextmanager
async def connected():
    async with stdio_client(PARAMS) as (read, write), ClientSession(read, write) as client:
        await client.initialize()
        yield client


def _text(result) -> str:
    return "\n".join(block.text for block in result.content if block.type == "text")


async def test_the_server_completes_a_handshake() -> None:
    """If initialize fails, nothing else this file claims is meaningful."""
    async with connected() as client:
        assert (await client.list_tools()).tools


async def test_it_advertises_every_runnable_agent() -> None:
    """The list is derived from the catalog, so it cannot quietly shrink."""
    from gravai_mcp.runner import RUNNABLE

    async with connected() as client:
        names = {tool.name for tool in (await client.list_tools()).tools}

    assert len(names) == len(RUNNABLE) == 14
    assert "score_risk" in names
    assert "classify_documents" in names


async def test_it_does_not_advertise_system_tools() -> None:
    """A tool that would always fail must not be offered to a model."""
    async with connected() as client:
        names = {tool.name for tool in (await client.list_tools()).tools}
    assert "verify_audit_chain" not in names


async def test_tools_carry_honest_annotations() -> None:
    """Voice collections is the one agent that acts; the rest are advisory."""
    async with connected() as client:
        tools = {tool.name: tool for tool in (await client.list_tools()).tools}

    assert tools["score_risk"].annotations.read_only_hint is True
    assert tools["score_risk"].annotations.destructive_hint is False
    assert tools["run_collections_followup"].annotations.destructive_hint is True


async def test_running_the_risk_agent_returns_the_scorecard_figures() -> None:
    """The number must arrive exactly as the scorecard produced it."""
    async with connected() as client:
        result = await client.call_tool("score_risk", {})

    assert result.is_error is False
    structured = result.structured_content
    assert structured["agent_id"] == "risk_scoring"
    assert structured["mode"] == "sandbox"
    assert structured["guardrails_passed"] is True
    assert structured["escalated"] is False

    output = structured["output"]
    assert output["probability_30dpd_6m"] == 0.0658
    assert output["band"] == "AMBER"
    assert output["model_version"] == "scorecard-v1-illustrative"


async def test_the_summary_tells_the_host_it_was_a_sandbox_run() -> None:
    """A host must never present sandbox output as a real decision."""
    async with connected() as client:
        result = await client.call_tool("score_risk", {})

    text = _text(result).lower()
    assert "sandbox" in text
    assert "must not underwrite" in text


async def test_an_escalating_agent_reports_escalation_not_failure() -> None:
    """Escalation is the designed outcome, so it is not an error result."""
    async with connected() as client:
        result = await client.call_tool("underwrite_application", {})

    assert result.is_error is False
    assert result.structured_content["escalated"] is True
    assert result.structured_content["escalation_reason"]
    assert "by design" in _text(result).lower()


async def test_an_unknown_tool_is_refused_with_the_available_list() -> None:
    async with connected() as client:
        result = await client.call_tool("not_a_real_tool", {})

    assert result.is_error is True
    assert "score_risk" in _text(result)


async def test_a_document_run_reports_its_real_call_count() -> None:
    """Suppressing the sandbox sleep must not suppress the call accounting.

    The wall-clock wait is skipped because there is no real job to wait for.
    The twelve calls per document are still counted, because that is what the
    cost model and the rate governor are sized against.
    """
    async with connected() as client:
        result = await client.call_tool("classify_documents", {})

    output = result.structured_content["output"]
    assert output["total_calls"] == 98
    assert output["total_pages"] == 29


async def test_a_role_without_agents_run_is_offered_no_agent_tools() -> None:
    """The tool list must not tempt a model into a call that will be refused.

    An auditor holds applications:read but not agents:run. Matching on any
    shared scope rather than all required ones offered them every agent tool,
    and every call would have been refused.
    """
    from gravai_core.auth import Role, scopes_for_roles
    from gravai_mcp.tools import tools_for_scopes

    auditor = scopes_for_roles([Role("auditor")])
    assert not [tool for tool in tools_for_scopes(auditor) if tool.family == "agent"]


async def test_a_lending_role_is_not_offered_collections_agents() -> None:
    """Least privilege has to actually bite, or the filter is decoration.

    An underwriter holds no collections scope, so the four collections agents
    are not theirs to run. Reaching all fourteen takes both roles, which is the
    server's default.
    """
    from gravai_core.auth import Role, scopes_for_roles
    from gravai_mcp.tools import tools_for_scopes

    def agent_tool_names(*roles: str) -> set[str]:
        scopes = scopes_for_roles([Role(name) for name in roles])
        return {tool.name for tool in tools_for_scopes(scopes) if tool.family == "agent"}

    lending = agent_tool_names("underwriter")
    assert len(lending) == 10
    assert "run_collections_followup" not in lending
    assert "score_risk" in lending

    assert len(agent_tool_names("underwriter", "collections_manager")) == 14


async def test_the_advertised_schema_is_the_one_the_runner_reads() -> None:
    """The schema used to offer application_id, case_id and options.

    None of the three reached the runner, so a host that filled them in got the
    fixture run back with no sign its arguments went nowhere.
    """
    async with connected() as client:
        tools = {tool.name: tool for tool in (await client.list_tools()).tools}

    schema = tools["score_risk"].input_schema
    properties = schema["properties"]

    assert "application_id" not in properties
    assert "bureau_score" in properties
    assert properties["bureau_score"]["minimum"] == 300
    assert schema["additionalProperties"] is False


async def test_a_host_can_change_the_answer_with_arguments() -> None:
    async with connected() as client:
        poor = await client.call_tool("score_risk", {"bureau_score": 540})
        good = await client.call_tool("score_risk", {"bureau_score": 830})

    assert poor.is_error is False and good.is_error is False
    assert (
        poor.structured_content["output"]["probability_30dpd_6m"]
        > good.structured_content["output"]["probability_30dpd_6m"]
    )


async def test_a_bad_argument_says_which_one() -> None:
    """A generic failure invites the host to retry the same call."""
    async with connected() as client:
        result = await client.call_tool("score_risk", {"bureau_score": 9999})

    assert result.is_error is True
    assert "bureau score" in _text(result).lower()
