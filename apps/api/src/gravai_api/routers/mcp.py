"""The MCP surface, described over REST.

The console needs to show what an MCP client would actually see: which tools
are advertised, what each takes, and which ones the caller's own token permits.
That catalog lives in `gravai_mcp.tools`, derived from the same agent registry
the REST API and the website read — so it is served from here rather than
transcribed into TypeScript, where it would drift the first time an agent moved.

Filtered by the caller's scopes, exactly as the MCP server filters it. A tool
listed here is one this token can really call.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from gravai_core.auth import Scope
from gravai_mcp.runner import RUNNABLE
from gravai_mcp.tools import TOOL_CATALOG, tools_for_scopes
from pydantic import BaseModel, Field

from ..deps import CurrentPrincipal, require_scope

router = APIRouter(prefix="/v1/mcp", tags=["mcp"])


class McpToolOut(BaseModel):
    """One tool as an MCP client is offered it."""

    name: str
    family: str
    description: str
    input_schema: dict[str, Any]
    scopes: list[str]
    read_only: bool = Field(description="Advisory tools never act on their own")
    destructive: bool
    long_running: bool
    tags: list[str]
    runnable: bool = Field(
        description="Whether this server can assemble the inputs the tool needs"
    )
    permitted: bool = Field(description="Whether the calling token holds every scope it needs")


class McpSurfaceOut(BaseModel):
    """Everything the console needs to describe this MCP deployment."""

    total_tools: int
    permitted_tools: int
    held_scopes: list[str]
    tools: list[McpToolOut]


@router.get(
    "/tools",
    response_model=McpSurfaceOut,
    summary="The MCP tool catalog, filtered by the caller's scopes",
    dependencies=[Depends(require_scope(Scope.AGENTS_RUN))],
)
async def list_tools(principal: CurrentPrincipal) -> McpSurfaceOut:
    held = frozenset(principal.scopes)
    permitted = {tool.name for tool in tools_for_scopes(held)}

    tools = [
        McpToolOut(
            name=spec.name,
            family=spec.family,
            description=spec.description,
            input_schema=spec.input_schema,
            scopes=sorted(scope.value for scope in spec.scopes),
            read_only=spec.read_only,
            destructive=spec.destructive,
            long_running=spec.long_running,
            tags=list(spec.tags),
            runnable=any(
                spec.name == candidate for candidate in _tool_names_for_runnable()
            ),
            permitted=spec.name in permitted,
        )
        for spec in TOOL_CATALOG.values()
    ]
    tools.sort(key=lambda tool: (not tool.permitted, tool.family, tool.name))

    return McpSurfaceOut(
        total_tools=len(tools),
        permitted_tools=sum(1 for tool in tools if tool.permitted),
        held_scopes=sorted(scope.value for scope in held),
        tools=tools,
    )


def _tool_names_for_runnable() -> set[str]:
    """MCP advertises tool names; the runner keys on agent ids."""
    from gravai_agents.catalog import AGENT_CATALOG

    return {spec.tool_name for agent_id, spec in AGENT_CATALOG.items() if agent_id in RUNNABLE}
