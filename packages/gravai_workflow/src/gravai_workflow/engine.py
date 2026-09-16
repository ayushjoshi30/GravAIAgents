"""Running a workflow.

The engine walks the graph in dependency order, runs whatever is ready
concurrently, keeps one shared state, follows the branch a branching node
chose, retries what is worth retrying, and records every step.

Three decisions worth stating, because each has a tempting wrong answer:

* **A node runs when its dependencies are settled, not when its turn comes.**
  Two branches of a fan-out are independent, so they run at the same time; a
  join waits for both. Running strictly in topological order would serialise
  work that has no reason to be serial.

* **An unchosen branch is skipped, not failed.** When a router picks `approve`,
  everything downstream of `review` is marked skipped and never runs. Treating
  those as failures would make every branching workflow report errors.

* **The trace is produced whether the run succeeds or not.** A failed run is
  exactly when the trace matters, so it is assembled as the run proceeds rather
  than at the end.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import anyio
from gravai_runner import SandboxFixtures

from .executors import EXECUTORS
from .graph import WorkflowGraph
from .runtime import ExecutionContext, NodeOutcome
from .state import WorkflowState, new_state

#: How many nodes may run at once. Enough for a wide fan-out, low enough that a
#: workflow cannot open fifty model connections by accident.
MAX_CONCURRENCY = 8


@dataclass
class NodeTrace:
    """What one node did, for the TEST screen and for debugging afterwards."""

    node_id: str
    node_type: str
    title: str
    status: str  # ok | failed | skipped | halted
    started_at: str = ""
    duration_ms: int = 0
    summary: str = ""
    inputs: dict[str, Any] = field(default_factory=dict)
    outputs: dict[str, Any] = field(default_factory=dict)
    detail: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    branch: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cost_inr: Decimal = Decimal("0")
    attempts: int = 1

    def as_dict(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "node_type": self.node_type,
            "title": self.title,
            "status": self.status,
            "started_at": self.started_at,
            "duration_ms": self.duration_ms,
            "summary": self.summary,
            "inputs": self.inputs,
            "outputs": self.outputs,
            "detail": self.detail,
            "error": self.error,
            "branch": self.branch,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_inr": str(self.cost_inr),
            "attempts": self.attempts,
        }


@dataclass
class RunResult:
    """The whole outcome of one run."""

    status: str  # completed | failed | awaiting_approval | invalid
    output: dict[str, Any] = field(default_factory=dict)
    state: WorkflowState = field(default_factory=WorkflowState)
    trace: list[NodeTrace] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    duration_ms: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_inr: Decimal = Decimal("0")

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "output": self.output,
            "state": self.state.as_dict(),
            "trace": [entry.as_dict() for entry in self.trace],
            "problems": self.problems,
            "duration_ms": self.duration_ms,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_inr": str(self.cost_inr),
            "nodes_run": sum(1 for t in self.trace if t.status == "ok"),
            "nodes_skipped": sum(1 for t in self.trace if t.status == "skipped"),
        }


async def run_workflow(
    graph: WorkflowGraph,
    sarvam: Any,
    *,
    inputs: dict[str, Any] | None = None,
    tenant_id: str = "acme",
    tenant_name: str = "Acme Finance Limited",
    credentials: dict[str, str] | None = None,
    only_nodes: set[str] | None = None,
) -> RunResult:
    """Execute a workflow and return its result and trace.

    `only_nodes`, when given, restricts execution to those nodes — the replay
    of a single step from the TEST screen, against the state it would have had.
    """
    started = time.monotonic()

    problems = [p.message for p in graph.validate() if p.blocking]
    if problems:
        return RunResult(status="invalid", problems=problems)

    state = new_state(
        inputs,
        tenant_id=tenant_id,
        workflow=graph.name,
        started_at=datetime.now(UTC).isoformat(),
    )
    ctx = ExecutionContext(
        state=state,
        sarvam=sarvam,
        tenant_id=tenant_id,
        tenant_name=tenant_name,
        credentials=credentials or {},
        sandbox=bool(getattr(sarvam, "sandbox", True)),
        fixtures=SandboxFixtures(sarvam, tenant_id=tenant_id, tenant_name=tenant_name),
    )

    trace: list[NodeTrace] = []
    settled: set[str] = set()
    skipped: set[str] = set()
    halted = False
    failed = False

    #: Edges the run is allowed to follow. A branching node prunes this.
    live_edges = {edge.id for edge in graph.edges}

    pending = {node.id for node in graph.nodes}
    if only_nodes is not None:
        pending = set(only_nodes)

    while pending and not halted:
        ready = [
            node_id
            for node_id in sorted(pending)
            if _dependencies_settled(graph, node_id, settled, skipped, live_edges)
        ]
        if not ready:
            # Nothing can proceed: everything left depends on a pruned branch.
            for node_id in sorted(pending):
                node = graph.node(node_id)
                trace.append(
                    NodeTrace(
                        node_id=node_id,
                        node_type=node.type if node else "?",
                        title=node.title if node else node_id,
                        status="skipped",
                        summary="not on the path this run took",
                    )
                )
            break

        batch = [node_id for node_id in ready if node_id not in skipped]
        pending -= set(ready)

        # A node whose every incoming edge was pruned never runs.
        for node_id in ready:
            if node_id in skipped or not _on_live_path(graph, node_id, live_edges, settled):
                skipped.add(node_id)
                node = graph.node(node_id)
                trace.append(
                    NodeTrace(
                        node_id=node_id,
                        node_type=node.type if node else "?",
                        title=node.title if node else node_id,
                        status="skipped",
                        summary="its branch was not taken",
                    )
                )
        batch = [node_id for node_id in batch if node_id not in skipped]
        if not batch:
            continue

        results = await _run_batch(graph, batch, ctx)

        for node_id in batch:
            entry, outcome = results[node_id]
            trace.append(entry)
            settled.add(node_id)

            if outcome.failed:
                failed = True
                state.errors.append(f"{entry.title}: {outcome.error}")
                # Everything downstream of a failure is skipped rather than
                # attempted against a state that never got its inputs.
                _prune_all(graph, node_id, live_edges)
                continue

            state.record_output(node_id, outcome.outputs)

            if outcome.halt:
                halted = True
                break

            node = graph.node(node_id)
            if node is not None and node.spec.branching:
                _prune_unchosen(graph, node_id, outcome.branch, live_edges)

    duration = int((time.monotonic() - started) * 1000)
    output = _final_output(graph, trace, state)

    status = "completed"
    if halted:
        status = "awaiting_approval"
    elif failed:
        status = "failed"

    return RunResult(
        status=status,
        output=output,
        state=state,
        trace=trace,
        problems=[p.message for p in graph.validate() if not p.blocking],
        duration_ms=duration,
        input_tokens=sum(entry.input_tokens for entry in trace),
        output_tokens=sum(entry.output_tokens for entry in trace),
        cost_inr=sum((entry.cost_inr for entry in trace), Decimal("0")),
    )


async def _run_batch(
    graph: WorkflowGraph, batch: list[str], ctx: ExecutionContext
) -> dict[str, tuple[NodeTrace, NodeOutcome]]:
    """Run one layer of independent nodes at the same time.

    A function rather than a closure inside the scheduling loop: defining the
    task body in the loop captures the loop's own variables, which is correct
    only for as long as nothing awaits between defining and using them. That is
    a condition no future edit can see.
    """
    results: dict[str, tuple[NodeTrace, NodeOutcome]] = {}
    limiter = anyio.CapacityLimiter(MAX_CONCURRENCY)

    async def one(node_id: str) -> None:
        async with limiter:
            results[node_id] = await _run_node(graph, node_id, ctx)

    async with anyio.create_task_group() as group:
        for node_id in batch:
            group.start_soon(one, node_id)

    return results


async def _run_node(
    graph: WorkflowGraph, node_id: str, ctx: ExecutionContext
) -> tuple[NodeTrace, NodeOutcome]:
    node = graph.node(node_id)
    if node is None:
        outcome = NodeOutcome(error=f"{node_id} is not in the graph")
        return NodeTrace(node_id, "?", node_id, "failed", error=outcome.error), outcome

    executor = EXECUTORS.get(node.type)
    if executor is None:
        # Unreachable while validate_registry passes; kept because the
        # alternative failure is a node that silently does nothing.
        outcome = NodeOutcome(error=f"{node.type!r} has no executor in this build")
        return (
            NodeTrace(node_id, node.type, node.title, "failed", error=outcome.error),
            outcome,
        )

    retries = int(node.config.get("retries", 0) or 0)
    started_at = datetime.now(UTC).isoformat()
    began = time.monotonic()
    attempts = 0
    outcome = NodeOutcome()

    while attempts <= retries:
        attempts += 1
        try:
            outcome = await executor(node, ctx)
        except Exception as exc:  # a node must not take the whole run down
            outcome = NodeOutcome(error=f"{type(exc).__name__}: {exc}")
        if not outcome.failed:
            break

    duration = int((time.monotonic() - began) * 1000)
    entry = NodeTrace(
        node_id=node_id,
        node_type=node.type,
        title=node.title,
        status="halted" if outcome.halt else ("failed" if outcome.failed else "ok"),
        started_at=started_at,
        duration_ms=duration,
        summary=outcome.halt_reason if outcome.halt else outcome.summary,
        inputs=dict(node.config),
        outputs=outcome.outputs,
        detail=outcome.detail,
        error=outcome.error,
        branch=outcome.branch,
        input_tokens=outcome.input_tokens,
        output_tokens=outcome.output_tokens,
        cost_inr=outcome.cost_inr,
        attempts=attempts,
    )
    return entry, outcome


def _dependencies_settled(
    graph: WorkflowGraph,
    node_id: str,
    settled: set[str],
    skipped: set[str],
    live_edges: set[str],
) -> bool:
    for edge in graph.incoming(node_id):
        if edge.id not in live_edges:
            continue  # pruned: it will never arrive, so it is not waited on
        if edge.source not in settled and edge.source not in skipped:
            return False
    return True


def _on_live_path(
    graph: WorkflowGraph, node_id: str, live_edges: set[str], settled: set[str]
) -> bool:
    """An entry node always runs; anything else needs one surviving edge in."""
    incoming = graph.incoming(node_id)
    if not incoming:
        return True
    return any(edge.id in live_edges and edge.source in settled for edge in incoming)


def _prune_unchosen(graph: WorkflowGraph, node_id: str, chosen: str, live_edges: set[str]) -> None:
    """Remove every edge out of a branching node except the one it chose."""
    for edge in graph.outgoing(node_id):
        if edge.branch != chosen:
            live_edges.discard(edge.id)


def _prune_all(graph: WorkflowGraph, node_id: str, live_edges: set[str]) -> None:
    queue = deque([node_id])
    seen: set[str] = set()
    while queue:
        current = queue.popleft()
        if current in seen:
            continue
        seen.add(current)
        for edge in graph.outgoing(current):
            live_edges.discard(edge.id)
            queue.append(edge.target)


def _final_output(
    graph: WorkflowGraph, trace: list[NodeTrace], state: WorkflowState
) -> dict[str, Any]:
    """The Output node's answer, or the state when the workflow has none."""
    for node in graph.nodes:
        if node.type != "output":
            continue
        entry = next((t for t in trace if t.node_id == node.id and t.status == "ok"), None)
        if entry is not None:
            return entry.outputs
    return {"facts": state.facts, "decisions": state.as_dict()["decisions"]}
