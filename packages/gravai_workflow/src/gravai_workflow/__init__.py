"""Agent Studio: build a workflow on a canvas, run it as one agent.

The pieces, in the order they matter:

* `registry` — what node types exist and what each promises.
* `graph` — a workflow definition, and everything that can be wrong with one.
* `state` — the shared state nodes read from and write to, instead of piping
  each other's output.
* `expressions` — templates and conditions over that state, parsed rather than
  evaluated.
* `executors` — what each node actually does. Every node type has an entry.
* `engine` — dependency-ordered execution, parallel where safe, with a trace.
"""

from __future__ import annotations

from .engine import MAX_CONCURRENCY, NodeTrace, RunResult, run_workflow
from .examples import CREDIT_UNDERWRITING, EXAMPLES, TWO_STEP
from .executors import EXECUTORS
from .expressions import ExpressionError, evaluate, render
from .graph import Edge, NodeInstance, Problem, WorkflowGraph, from_dict, to_dict
from .registry import (
    FAMILIES,
    NODE_REGISTRY,
    ConfigField,
    NodeSpec,
    Port,
    by_family,
    node_spec,
    validate_registry,
)
from .runtime import ExecutionContext, NodeOutcome
from .state import Artifact, Decision, WorkflowState, new_state

__version__ = "0.1.0"

__all__ = [
    "CREDIT_UNDERWRITING",
    "EXAMPLES",
    "EXECUTORS",
    "FAMILIES",
    "MAX_CONCURRENCY",
    "NODE_REGISTRY",
    "TWO_STEP",
    "Artifact",
    "ConfigField",
    "Decision",
    "Edge",
    "ExecutionContext",
    "ExpressionError",
    "NodeInstance",
    "NodeOutcome",
    "NodeSpec",
    "NodeTrace",
    "Port",
    "Problem",
    "RunResult",
    "WorkflowGraph",
    "WorkflowState",
    "by_family",
    "evaluate",
    "from_dict",
    "new_state",
    "node_spec",
    "render",
    "run_workflow",
    "to_dict",
    "validate_registry",
]
