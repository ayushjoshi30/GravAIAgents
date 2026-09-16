"""The Studio's starter templates must only use nodes the engine really has.

`apps/web/src/lib/studioTemplates.ts` gives the Agent Studio something to open
other than an empty canvas. Each one is a real workflow shape built from real
node types.

That is worth a test because the failure is delayed and confusing. A template
naming a type this build does not have looks completely fine in the picker,
renders on the canvas, and only fails when the person tries to save it — with
"'x' is not a node type this build knows", about a node they did not choose,
in a workflow they did not write. Catching it here instead means the person who
removed the node from the registry finds out, rather than a tenant.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from gravai_workflow import NODE_REGISTRY

TEMPLATES = Path("apps/web/src/lib/studioTemplates.ts")


def _template_node_types() -> set[str]:
    """Pull every node type out of the template module.

    Read with a regex rather than by executing TypeScript: the file is data in
    the shape of code, and the alternative is a Node toolchain in the Python
    test run. The `node(...)` helper always takes the type as its second
    argument, so the shape being matched is stable.
    """
    source = TEMPLATES.read_text(encoding="utf-8")
    calls = re.findall(r'\bnode\(\s*"[^"]+"\s*,\s*"([^"]+)"', source)
    assert calls, "found no node() calls — has the helper's shape changed?"
    return set(calls)


def test_template_module_exists() -> None:
    assert TEMPLATES.exists(), f"{TEMPLATES} is missing"


def test_every_template_node_exists_in_the_registry() -> None:
    unknown = sorted(_template_node_types() - set(NODE_REGISTRY))
    assert not unknown, (
        f"Studio templates reference {len(unknown)} node type(s) the engine does "
        f"not have: {unknown}. Either restore them or edit the templates."
    )


def test_branching_templates_label_their_edges() -> None:
    """A branch's outgoing edges must name a branch the node declares.

    `graph.py` makes this an error, not a warning, so a template that got it
    wrong would be unsavable. The templates use `condition`, which declares
    true and false.
    """
    source = TEMPLATES.read_text(encoding="utf-8")
    branches = set(re.findall(r'\bedge\(\s*"[^"]+"\s*,\s*"[^"]+"\s*,\s*"([^"]+)"', source))
    assert branches, "no branch-labelled edges found, but templates use condition nodes"
    assert branches <= {"true", "false"}, (
        f"templates use branch labels {sorted(branches)}; `condition` declares true/false"
    )


def test_input_nodes_declare_no_schema() -> None:
    """The starter templates must not imply that typing the input is required.

    `input.schema` is optional in the registry and the node's only output is
    `payload: object` — whatever the caller sent. Every agent node downstream
    takes one optional `state: object`. A template that shipped a schema would
    teach a shape the platform does not require, and the person copying it would
    carry that into their own workflow.
    """
    spec = NODE_REGISTRY["input"]
    schema_field = next((f for f in (spec.config or []) if getattr(f, "name", "") == "schema"), None)
    assert schema_field is not None, "input node no longer has a schema field"
    assert not getattr(schema_field, "required", False), (
        "input.schema has become required in the engine — the templates and the "
        "Studio's Inputs panel both assume it is optional and need revisiting"
    )

    source = TEMPLATES.read_text(encoding="utf-8")
    assert "const INPUT_CONFIG: Record<string, unknown> = {};" in source, (
        "templates should seed the Input node with an empty config; a starter "
        "that declares a schema implies one is needed"
    )


def test_agent_nodes_take_shared_state_not_typed_inputs() -> None:
    """The premise the templates are built on, asserted rather than assumed.

    If agent nodes ever gain required, typed input ports, the templates' habit
    of wiring any output into any agent stops being valid and this test is where
    that should surface.
    """
    offenders = []
    for node_type, spec in NODE_REGISTRY.items():
        if not node_type.startswith("agent."):
            continue
        for port in spec.inputs or ():
            if getattr(port, "required", False):
                offenders.append(f"{node_type}.{port.name}")
    assert not offenders, (
        "agent nodes now have required input ports, so inputs are no longer "
        f"free-form shared state: {sorted(offenders)}"
    )
