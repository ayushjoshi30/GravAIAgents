"""GET /v1/mcp/tools — what the console shows about the MCP surface.

The catalog is derived from the agent registry, so this mostly guards against
the two ways the page could lie: showing tools the token cannot actually call,
and drifting from the registry if an agent is added or removed.
"""

from __future__ import annotations

import contextlib
from uuid import UUID, uuid4

import pytest
from gravai_api.main import app
from gravai_core.auth import Role, issue_dev_token
from httpx import ASGITransport, AsyncClient
from sqlalchemy.exc import IntegrityError

TENANT = uuid4()


def _auth(*roles: Role, tenant_id: UUID = TENANT) -> dict[str, str]:
    token = issue_dev_token(
        tenant_id=tenant_id,
        subject="test:console",
        roles=list(roles) or [Role.UNDERWRITER],
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def client(_schema: None, make_tenant):  # type: ignore[no-untyped-def]
    with contextlib.suppress(IntegrityError):
        await make_tenant(TENANT, slug=f"mcp-{TENANT.hex[:8]}")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as http:
        yield http


async def test_the_surface_matches_the_tool_catalog(client) -> None:
    from gravai_mcp.tools import TOOL_CATALOG

    response = await client.get(
        "/v1/mcp/tools", headers=_auth(Role.UNDERWRITER, Role.COLLECTIONS_MANAGER)
    )
    assert response.status_code == 200
    body = response.json()
    assert body["total_tools"] == len(TOOL_CATALOG)
    assert len(body["tools"]) == len(TOOL_CATALOG)


async def test_it_marks_which_tools_this_token_can_actually_call(client) -> None:
    """Showing a tool as available when it would 403 is the failure here."""
    lending = await client.get("/v1/mcp/tools", headers=_auth(Role.UNDERWRITER))
    both = await client.get(
        "/v1/mcp/tools", headers=_auth(Role.UNDERWRITER, Role.COLLECTIONS_MANAGER)
    )

    lending_agents = {
        t["name"] for t in lending.json()["tools"] if t["family"] == "agent" and t["permitted"]
    }
    both_agents = {
        t["name"] for t in both.json()["tools"] if t["family"] == "agent" and t["permitted"]
    }

    assert "score_risk" in lending_agents
    assert "run_collections_followup" not in lending_agents
    assert "run_collections_followup" in both_agents
    assert len(both_agents) == 14


async def test_annotations_are_honest_about_what_acts(client) -> None:
    response = await client.get("/v1/mcp/tools", headers=_auth(Role.TENANT_ADMIN))
    tools = {t["name"]: t for t in response.json()["tools"]}
    assert tools["score_risk"]["read_only"] is True
    assert tools["score_risk"]["destructive"] is False
    assert tools["run_collections_followup"]["destructive"] is True


async def test_every_agent_tool_is_marked_runnable(client) -> None:
    """The catalog and the runner must agree, or the page offers dead buttons."""
    response = await client.get("/v1/mcp/tools", headers=_auth(Role.TENANT_ADMIN))
    agent_tools = [t for t in response.json()["tools"] if t["family"] == "agent"]
    assert len(agent_tools) == 14
    assert all(t["runnable"] for t in agent_tools)


async def test_it_needs_agents_run(client) -> None:
    response = await client.get("/v1/mcp/tools", headers=_auth(Role.AUDITOR))
    assert response.status_code == 403
