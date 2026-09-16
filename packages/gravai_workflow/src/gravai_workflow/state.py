"""The shared workflow state.

The tempting design is to pipe node A's output straight into node B. It falls
over as soon as a workflow is more than a line: node D needs something node A
found, node B already summarised it, and the edge between them carries none of
that. So nodes do not hand each other their output. They read from and write to
one state, and the edges say what runs when rather than what is passed.

Two consequences worth stating, because they are the reason this exists:

* **A fact is written once and named.** `facts["monthly_income"]` means the same
  thing to every node downstream, whoever put it there.
* **Raw output is kept separately from facts.** `outputs[node_id]` is what a
  node returned verbatim, for the trace and for explicit references. `facts` is
  what the workflow has decided is true. Conflating them is how a summary ends
  up quoted as a measurement.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any


def _plain(value: Any) -> Any:
    """Make a value safe to serialise and to template into a prompt."""
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    if hasattr(value, "model_dump"):
        return _plain(value.model_dump(mode="json"))
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


@dataclass
class Decision:
    """A determination some node made, kept so later nodes cannot relitigate it."""

    node_id: str
    name: str
    value: Any
    #: Deterministic decisions (a rule engine, a comparison) outrank a model's
    #: opinion, and the engine refuses to let a model overwrite one.
    deterministic: bool = False
    reason: str = ""


@dataclass
class Artifact:
    """Something produced that is not a fact: a document, a report, a payload."""

    node_id: str
    name: str
    kind: str
    ref: str
    size_bytes: int = 0


@dataclass
class WorkflowState:
    """Everything the workflow knows so far."""

    #: Named values any downstream node may read. The workflow's shared truth.
    facts: dict[str, Any] = field(default_factory=dict)
    #: Short prose descriptions of what happened, in order.
    summaries: list[str] = field(default_factory=list)
    decisions: list[Decision] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    artifacts: list[Artifact] = field(default_factory=list)
    previous_actions: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    #: Verbatim output per node, addressable as `{{nodes.<id>.<field>}}`.
    outputs: dict[str, Any] = field(default_factory=dict)

    # --- writing ----------------------------------------------------------

    def record_output(self, node_id: str, value: Any) -> None:
        self.outputs[node_id] = _plain(value)

    def set_fact(self, name: str, value: Any, *, node_id: str = "") -> None:
        """Write a named fact.

        A collision is a warning rather than an error: two nodes legitimately
        find the same thing, and stopping the run would be worse than saying so.
        Silence is the option that is not available — a fact changing under a
        later node is precisely what makes a workflow impossible to debug.
        """
        clean = _plain(value)
        if name in self.facts and self.facts[name] != clean:
            self.warnings.append(
                f"{node_id or 'a node'} changed fact {name!r} from "
                f"{self.facts[name]!r} to {clean!r}"
            )
        self.facts[name] = clean

    def set_facts(self, values: dict[str, Any], *, node_id: str = "") -> None:
        for name, value in values.items():
            self.set_fact(name, value, node_id=node_id)

    def add_decision(self, decision: Decision) -> None:
        """Record a determination, refusing to let an opinion overwrite a rule.

        The design principle this enforces: rules decide, models reason. A
        model node that tries to overturn a deterministic decision gets a
        warning and no effect, rather than quietly winning.
        """
        existing = next((d for d in self.decisions if d.name == decision.name), None)
        if existing and existing.deterministic and not decision.deterministic:
            self.warnings.append(
                f"{decision.node_id} tried to overrule the deterministic decision "
                f"{decision.name!r} ({existing.value!r}); the rule stands"
            )
            return
        if existing:
            self.decisions.remove(existing)
        self.decisions.append(decision)

    def note(self, action: str) -> None:
        self.previous_actions.append(action)

    # --- reading ----------------------------------------------------------

    def decision(self, name: str) -> Any:
        for entry in self.decisions:
            if entry.name == name:
                return entry.value
        return None

    def as_dict(self) -> dict[str, Any]:
        """The whole state, JSON-safe. What templates and the trace both read."""
        return {
            "facts": self.facts,
            "summaries": list(self.summaries),
            "decisions": [
                {
                    "node_id": d.node_id,
                    "name": d.name,
                    "value": _plain(d.value),
                    "deterministic": d.deterministic,
                    "reason": d.reason,
                }
                for d in self.decisions
            ],
            "warnings": list(self.warnings),
            "artifacts": [
                {
                    "node_id": a.node_id,
                    "name": a.name,
                    "kind": a.kind,
                    "ref": a.ref,
                    "size_bytes": a.size_bytes,
                }
                for a in self.artifacts
            ],
            "previous_actions": list(self.previous_actions),
            "metadata": self.metadata,
            "errors": list(self.errors),
        }

    def resolution_scope(self) -> dict[str, Any]:
        """What `{{ ... }}` expressions may address."""
        return {"workflow": self.as_dict(), "nodes": self.outputs, **self.facts}


def new_state(inputs: dict[str, Any] | None = None, **metadata: Any) -> WorkflowState:
    """A fresh state seeded with the workflow's own input."""
    state = WorkflowState()
    state.metadata = {"started_at": datetime.now(UTC).isoformat(), **metadata}
    if inputs:
        state.set_facts(_plain(inputs), node_id="input")
        state.outputs["input"] = _plain(inputs)
    return state
