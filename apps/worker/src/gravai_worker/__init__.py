"""GravAI Temporal workers.

Agent runs are durable workflows, not background tasks. That choice is forced by
the workload: Document Intelligence is asynchronous and rate-limited to 10
requests a minute, a backlog can take days to drain, and credit decisions wait on
a human. Each of those is a place an in-process task would lose its state.

Phase 0 defines the task queues and retry policy; the workflows land with their
agents in Phases 1-3.
"""

from __future__ import annotations

from .queues import RETRY_POLICIES, TaskQueue

__version__ = "0.1.0"

__all__ = ["RETRY_POLICIES", "TaskQueue", "__version__"]
