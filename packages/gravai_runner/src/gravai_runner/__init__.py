"""Run one catalog agent, wherever the request came from.

The agents take their connectors by injection, so `gravai_agents` deliberately
does not depend on `gravai_connectors`. Something still has to decide which
connector an agent gets and assemble its inputs, and both the REST API and the
MCP server need that same decision made the same way.

This is that seam. It is a separate package rather than a module inside either
app, because an app importing another app is how two deployables quietly become
one.
"""

from __future__ import annotations

from .sandbox import (
    CALL_TIME,
    DEFAULT_APPLICATION,
    PENDING_APPLICATION,
    RUNNABLE,
    RUNNERS,
    AgentNotRunnable,
    SandboxFixtures,
    run_agent,
)

__all__ = [
    "CALL_TIME",
    "DEFAULT_APPLICATION",
    "PENDING_APPLICATION",
    "RUNNABLE",
    "RUNNERS",
    "AgentNotRunnable",
    "SandboxFixtures",
    "run_agent",
]
