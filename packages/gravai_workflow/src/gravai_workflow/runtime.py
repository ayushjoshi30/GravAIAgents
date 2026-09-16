"""What an executor is handed, and what it gives back.

Kept apart from both the executors and the engine so neither has to import the
other: the engine dispatches on a table the executors build, and the executors
need the context type the engine constructs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from .state import WorkflowState


@dataclass
class ExecutionContext:
    """Everything a node may reach for, and nothing more.

    Notably absent: the graph. A node cannot inspect or alter the workflow it
    sits in, which is what keeps the engine the only thing deciding what runs.
    """

    state: WorkflowState
    sarvam: Any
    tenant_id: str = "acme"
    tenant_name: str = "Acme Finance Limited"
    #: Resolved server-side. A node config names a credential; the value is
    #: looked up here and never travels to the browser.
    credentials: dict[str, str] = field(default_factory=dict)
    #: True when the AI layer is sandboxed, so nodes can say so rather than
    #: quietly present canned prose as analysis.
    sandbox: bool = True
    #: One set of fixtures for the whole run, so a workflow with three agent
    #: nodes reads the document set once rather than three times. Without this
    #: a nine-node credit workflow spends most of a minute re-reading the same
    #: eight files, and pays for each read.
    fixtures: Any = None

    def scope(self) -> dict[str, Any]:
        return self.state.resolution_scope()


@dataclass
class NodeOutcome:
    """What one node did."""

    outputs: dict[str, Any] = field(default_factory=dict)
    #: Which branch to follow, for a branching node. Empty means "all edges".
    branch: str = ""
    #: True when the run should stop here without this being a failure —
    #: a human approval gate, not an error.
    halt: bool = False
    halt_reason: str = ""
    #: Set when the node failed. The engine decides whether that ends the run.
    error: str = ""
    summary: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cost_inr: Decimal = Decimal("0")
    #: Anything worth showing in the trace that is not an output.
    detail: dict[str, Any] = field(default_factory=dict)

    @property
    def failed(self) -> bool:
        return bool(self.error)
