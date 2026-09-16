"""The workflow definition, and everything that can be wrong with one.

Validation happens before a run rather than during it. A graph that fails here
has never called a model, never billed anything and never half-updated a state,
and the person who drew it gets told which node is wrong while they are still
looking at it. Discovering a missing prompt on node seven after six nodes have
run is the outcome this exists to prevent.
"""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any

from .expressions import ExpressionError, check, referenced_paths
from .registry import NODE_REGISTRY, NodeSpec, node_spec


@dataclass(frozen=True, slots=True)
class Problem:
    """One thing wrong with the graph, addressed to whoever drew it."""

    #: "error" stops a run; "warning" does not.
    severity: str
    message: str
    node_id: str = ""
    field: str = ""

    @property
    def blocking(self) -> bool:
        return self.severity == "error"


@dataclass
class NodeInstance:
    """One node as placed on the canvas."""

    id: str
    type: str
    name: str = ""
    config: dict[str, Any] = field(default_factory=dict)
    position: dict[str, float] = field(default_factory=lambda: {"x": 0.0, "y": 0.0})

    @property
    def spec(self) -> NodeSpec:
        return node_spec(self.type)

    @property
    def title(self) -> str:
        return self.name or (self.spec.label if self.type in NODE_REGISTRY else self.type)


@dataclass
class Edge:
    """A connection. `branch` names which outcome of a branching node it follows."""

    source: str
    target: str
    branch: str = ""
    id: str = ""

    def __post_init__(self) -> None:
        if not self.id:
            self.id = f"{self.source}->{self.target}" + (f":{self.branch}" if self.branch else "")


@dataclass
class WorkflowGraph:
    """A whole workflow: what the canvas saves and the engine runs."""

    name: str = "Untitled agent"
    description: str = ""
    nodes: list[NodeInstance] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)

    # --- structure --------------------------------------------------------

    def node(self, node_id: str) -> NodeInstance | None:
        return next((n for n in self.nodes if n.id == node_id), None)

    def outgoing(self, node_id: str) -> list[Edge]:
        return [e for e in self.edges if e.source == node_id]

    def incoming(self, node_id: str) -> list[Edge]:
        return [e for e in self.edges if e.target == node_id]

    def entry_nodes(self) -> list[NodeInstance]:
        """Nodes nothing points at. These start the run."""
        targeted = {e.target for e in self.edges}
        return [n for n in self.nodes if n.id not in targeted]

    def reachable(self) -> set[str]:
        seen: set[str] = set()
        queue = deque(n.id for n in self.entry_nodes())
        while queue:
            current = queue.popleft()
            if current in seen:
                continue
            seen.add(current)
            queue.extend(e.target for e in self.outgoing(current))
        return seen

    def cycles(self) -> list[list[str]]:
        """Every cycle, by Kahn's algorithm on what is left after peeling."""
        indegree: dict[str, int] = defaultdict(int)
        for node in self.nodes:
            indegree[node.id] += 0
        for edge in self.edges:
            indegree[edge.target] += 1

        queue = deque(node_id for node_id, count in indegree.items() if count == 0)
        removed: set[str] = set()
        while queue:
            current = queue.popleft()
            removed.add(current)
            for edge in self.outgoing(current):
                indegree[edge.target] -= 1
                if indegree[edge.target] == 0:
                    queue.append(edge.target)

        stuck = [node.id for node in self.nodes if node.id not in removed]
        return [stuck] if stuck else []

    def layers(self) -> list[list[str]]:
        """Nodes grouped so everything in a layer can run at once.

        A layer is the set of nodes whose dependencies are all satisfied. Two
        branches of a fan-out land in the same layer and therefore run
        concurrently; a join waits because it has an edge from each.
        """
        indegree: dict[str, int] = {node.id: 0 for node in self.nodes}
        for edge in self.edges:
            if edge.target in indegree:
                indegree[edge.target] += 1

        ready = [node_id for node_id, count in indegree.items() if count == 0]
        ordered: list[list[str]] = []
        seen: set[str] = set()

        while ready:
            layer = sorted(ready)
            ordered.append(layer)
            seen.update(layer)
            nxt: list[str] = []
            for node_id in layer:
                for edge in self.outgoing(node_id):
                    indegree[edge.target] -= 1
                    if indegree[edge.target] == 0 and edge.target not in seen:
                        nxt.append(edge.target)
            ready = nxt

        return ordered

    # --- validation -------------------------------------------------------

    def validate(self) -> list[Problem]:
        problems: list[Problem] = []
        problems += self._check_nodes()
        problems += self._check_edges()
        problems += self._check_shape()
        problems += self._check_config()
        return problems

    def _check_nodes(self) -> list[Problem]:
        problems: list[Problem] = []
        seen: set[str] = set()
        for node in self.nodes:
            if node.id in seen:
                problems.append(Problem("error", f"Two nodes share the id {node.id!r}", node.id))
            seen.add(node.id)
            if node.type not in NODE_REGISTRY:
                problems.append(
                    Problem("error", f"{node.type!r} is not a node type this build knows", node.id)
                )
        return problems

    def _check_edges(self) -> list[Problem]:
        problems: list[Problem] = []
        ids = {node.id for node in self.nodes}
        for edge in self.edges:
            if edge.source not in ids:
                problems.append(
                    Problem("error", f"A connection starts at {edge.source!r}, which is not here")
                )
            if edge.target not in ids:
                problems.append(
                    Problem("error", f"A connection ends at {edge.target!r}, which is not here")
                )

        # A branching node's edges must name branches it actually declares.
        for node in self.nodes:
            if node.type not in NODE_REGISTRY or not node.spec.branching:
                continue
            declared = _branch_labels(node)
            for edge in self.outgoing(node.id):
                if not edge.branch:
                    problems.append(
                        Problem(
                            "error",
                            f"{node.title} branches, so each connection out of it must say "
                            f"which branch it is ({', '.join(declared) or 'none declared'})",
                            node.id,
                        )
                    )
                elif declared and edge.branch not in declared:
                    problems.append(
                        Problem(
                            "error",
                            f"{node.title} has a connection for branch {edge.branch!r}, which it "
                            f"does not declare (it has {', '.join(declared)})",
                            node.id,
                        )
                    )
            for label in declared:
                if not any(e.branch == label for e in self.outgoing(node.id)):
                    problems.append(
                        Problem(
                            "warning",
                            f"{node.title} declares branch {label!r} but nothing is connected to "
                            "it, so that path ends the run",
                            node.id,
                        )
                    )
        return problems

    def _check_shape(self) -> list[Problem]:
        problems: list[Problem] = []
        if not self.nodes:
            return [Problem("error", "The workflow is empty")]

        for cycle in self.cycles():
            problems.append(
                Problem(
                    "error",
                    "These nodes form a loop, and the engine runs a graph once through: "
                    + ", ".join(sorted(cycle)),
                )
            )

        entries = self.entry_nodes()
        if not entries and not problems:
            problems.append(Problem("error", "Every node has an input, so nothing can start"))

        inputs = [n for n in self.nodes if n.type == "input"]
        if len(inputs) > 1:
            problems.append(Problem("error", "There is more than one Input node"))
        if not inputs:
            problems.append(
                Problem("warning", "There is no Input node, so the workflow takes no arguments")
            )

        if not any(n.type == "output" for n in self.nodes):
            problems.append(
                Problem(
                    "warning",
                    "There is no Output node, so the run returns the whole state rather than a "
                    "chosen answer",
                )
            )

        reachable = self.reachable()
        for node in self.nodes:
            if node.id not in reachable:
                problems.append(
                    Problem("warning", f"{node.title} is not connected to anything", node.id)
                )
        return problems

    def _check_config(self) -> list[Problem]:
        problems: list[Problem] = []
        for node in self.nodes:
            if node.type not in NODE_REGISTRY:
                continue
            for setting in node.spec.config:
                value = node.config.get(setting.name, setting.default)
                if setting.required and _empty(value):
                    problems.append(
                        Problem(
                            "error",
                            f"{node.title} needs {setting.label}",
                            node.id,
                            setting.name,
                        )
                    )
                    continue
                if setting.kind == "expression" and not _empty(value):
                    try:
                        check(str(value))
                    except ExpressionError as exc:
                        problems.append(
                            Problem(
                                "error",
                                f"{node.title}: {setting.label} does not parse — {exc}",
                                node.id,
                                setting.name,
                            )
                        )
                if setting.templated:
                    problems += _check_templates(node, setting.name, value)

            if node.spec.branching:
                problems += _check_branches(node)
        return problems


def _empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, dict, tuple)):
        return len(value) == 0
    return False


def _branch_labels(node: NodeInstance) -> list[str]:
    if node.type == "condition":
        return ["true", "false"]
    branches = node.config.get("branches") or []
    labels: list[str] = []
    if isinstance(branches, list):
        for entry in branches:
            if isinstance(entry, dict) and entry.get("label"):
                labels.append(str(entry["label"]))
    return labels


def _check_branches(node: NodeInstance) -> list[Problem]:
    problems: list[Problem] = []
    if node.type == "condition":
        return problems

    branches = node.config.get("branches")
    if not isinstance(branches, list) or not branches:
        return [Problem("error", f"{node.title} has no branches", node.id, "branches")]

    for index, entry in enumerate(branches):
        if not isinstance(entry, dict):
            problems.append(
                Problem("error", f"{node.title}: branch {index + 1} is malformed", node.id)
            )
            continue
        if not entry.get("label"):
            problems.append(
                Problem("error", f"{node.title}: branch {index + 1} has no label", node.id)
            )
        condition = entry.get("condition", "")
        if _empty(condition):
            problems.append(
                Problem(
                    "error",
                    f"{node.title}: branch {entry.get('label', index + 1)!r} has no condition",
                    node.id,
                )
            )
            continue
        try:
            check(str(condition))
        except ExpressionError as exc:
            problems.append(
                Problem(
                    "error",
                    f"{node.title}: branch {entry.get('label')!r} does not parse — {exc}",
                    node.id,
                )
            )

    labels = [e.get("label") for e in branches if isinstance(e, dict)]
    if len(labels) != len(set(labels)):
        problems.append(
            Problem("error", f"{node.title} has two branches with the same label", node.id)
        )

    last = branches[-1] if isinstance(branches[-1], dict) else {}
    if str(last.get("condition", "")).strip() not in {"true", "True"}:
        problems.append(
            Problem(
                "warning",
                f"{node.title}'s last branch is conditional, so an input matching none of them "
                "ends the run there. End with a branch whose condition is `true`.",
                node.id,
            )
        )
    return problems


def _check_templates(node: NodeInstance, field_name: str, value: Any) -> list[Problem]:
    """Every `{{ path }}` must at least be well-formed and addressable."""
    text = value if isinstance(value, str) else str(value)
    problems: list[Problem] = []
    for path in referenced_paths(text):
        root = path.split(".")[0].split("[")[0]
        if root not in {"workflow", "nodes"} and not root.isidentifier():
            problems.append(
                Problem(
                    "error",
                    f"{node.title}: {{{{{path}}}}} is not a readable reference",
                    node.id,
                    field_name,
                )
            )
    return problems


# --- serialisation ----------------------------------------------------------


def from_dict(payload: dict[str, Any]) -> WorkflowGraph:
    return WorkflowGraph(
        name=str(payload.get("name") or "Untitled agent"),
        description=str(payload.get("description") or ""),
        nodes=[
            NodeInstance(
                id=str(node["id"]),
                type=str(node["type"]),
                name=str(node.get("name") or ""),
                config=dict(node.get("config") or {}),
                position=dict(node.get("position") or {"x": 0, "y": 0}),
            )
            for node in payload.get("nodes") or []
        ],
        edges=[
            Edge(
                source=str(edge["source"]),
                target=str(edge["target"]),
                branch=str(edge.get("branch") or ""),
                id=str(edge.get("id") or ""),
            )
            for edge in payload.get("edges") or []
        ],
    )


def to_dict(graph: WorkflowGraph) -> dict[str, Any]:
    return {
        "name": graph.name,
        "description": graph.description,
        "nodes": [
            {
                "id": node.id,
                "type": node.type,
                "name": node.name,
                "config": node.config,
                "position": node.position,
            }
            for node in graph.nodes
        ],
        "edges": [
            {"id": edge.id, "source": edge.source, "target": edge.target, "branch": edge.branch}
            for edge in graph.edges
        ],
    }
