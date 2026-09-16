"""GravAI MCP server.

`tools.py` defines the tool contract — names, descriptions, input schemas and
read/destructive annotations — derived from the same agent catalog the REST API
and the website read, so the three surfaces cannot disagree about which agents
exist.

`server.py` binds that contract to the `mcp` SDK over stdio. `runner.py`
assembles the inputs an agent needs and runs it; the terminal front end in
`scripts/run_agent.py` calls the same dispatcher, so the two cannot drift.

The server is a *thin adapter*: it validates, authorises and calls the agent
layer. No business logic lives here.
"""

from __future__ import annotations

from .runner import RUNNABLE, AgentNotRunnable, SandboxFixtures, run_agent
from .tools import TOOL_CATALOG, ToolSpec, agent_tools, system_tools, tools_for_scopes

__version__ = "0.1.0"

__all__ = [
    "RUNNABLE",
    "TOOL_CATALOG",
    "AgentNotRunnable",
    "SandboxFixtures",
    "ToolSpec",
    "__version__",
    "agent_tools",
    "run_agent",
    "system_tools",
    "tools_for_scopes",
]
