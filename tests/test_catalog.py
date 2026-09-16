"""Agent catalog and MCP tool contract.

The API, the MCP server and the docs all read one registry, so these tests are
what stop the three surfaces from drifting apart.
"""

from __future__ import annotations

import pytest
from gravai_agents import AGENT_CATALOG, AgentTier, get_agent, list_agents
from gravai_connectors import CONNECTOR_REGISTRY, ConnectorStatus
from gravai_core.auth import Scope
from gravai_core.errors import NotFound
from gravai_mcp.tools import TOOL_CATALOG, agent_tools, system_tools, tools_for_scopes


def test_catalog_holds_every_planned_agent() -> None:
    """Thirteen at Phase 3, plus the Account Aggregator data agent."""
    assert len(AGENT_CATALOG) == 14


def test_every_tier_is_represented() -> None:
    assert len(list_agents(AgentTier.P0)) == 3
    assert len(list_agents(AgentTier.P1)) == 8
    assert len(list_agents(AgentTier.P2)) == 3


def test_agent_ids_and_tool_names_are_unique() -> None:
    tool_names = [spec.tool_name for spec in AGENT_CATALOG.values()]
    assert len(tool_names) == len(set(tool_names))


def test_every_agent_declares_at_least_one_scope() -> None:
    for spec in AGENT_CATALOG.values():
        assert spec.scopes, f"{spec.id} declares no scopes"


def test_unknown_agent_raises_not_found() -> None:
    with pytest.raises(NotFound):
        get_agent("no_such_agent")


def test_credit_appraisal_is_advisory() -> None:
    """Credit decisions are never automated: a human underwriter decides."""
    assert get_agent("credit_appraisal").advisory_only is True


def test_voice_collections_is_not_advisory() -> None:
    """It genuinely acts in the world - it places calls - so it is marked so."""
    assert get_agent("voice_collections").advisory_only is False


def test_every_agent_appears_as_an_mcp_tool() -> None:
    for spec in AGENT_CATALOG.values():
        assert spec.tool_name in TOOL_CATALOG


def test_tool_names_are_unique_across_both_families() -> None:
    names = [tool.name for tool in (*system_tools(), *agent_tools())]
    assert len(names) == len(set(names))


def test_every_tool_has_a_valid_object_schema() -> None:
    for tool in TOOL_CATALOG.values():
        schema = tool.input_schema
        assert schema["type"] == "object"
        assert set(schema["required"]).issubset(schema["properties"].keys())


def test_mandate_presentment_is_marked_destructive() -> None:
    """It moves money, so a host must confirm rather than auto-approve."""
    tool = TOOL_CATALOG["mandate.present"]
    assert tool.destructive is True
    assert tool.read_only is False


def test_read_only_tools_are_not_destructive() -> None:
    for tool in TOOL_CATALOG.values():
        if tool.read_only:
            assert not tool.destructive, f"{tool.name} is both read-only and destructive"


def test_document_submission_is_flagged_long_running() -> None:
    """Document Intelligence is asynchronous; hosts must not block on it."""
    assert TOOL_CATALOG["docai.extract"].long_running is True
    assert TOOL_CATALOG["docai.digitise"].long_running is True


def test_tool_visibility_follows_scopes() -> None:
    """A host sees only the tools its token actually permits."""
    collections_only = tools_for_scopes({Scope.COLLECTIONS_READ})
    names = {tool.name for tool in collections_only}
    assert "collections.list_cases" in names
    assert "bre.evaluate" not in names


def test_a_scopeless_principal_sees_no_tools() -> None:
    assert tools_for_scopes(set()) == []


def test_account_aggregator_is_declared_an_external_dependency() -> None:
    """The one genuine gap must be stated, not quietly implied to work."""
    assert CONNECTOR_REGISTRY["aa"].status is ConnectorStatus.EXTERNAL_DEPENDENCY


def test_no_connector_claims_to_be_live_yet() -> None:
    """Phase 0 has no production adapter wired; the registry must say so."""
    assert all(spec.status is not ConnectorStatus.LIVE for spec in CONNECTOR_REGISTRY.values())
