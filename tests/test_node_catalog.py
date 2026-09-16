"""The public sketchpad's node list must match the engine's own registry.

`apps/web/src/lib/nodeCatalog.ts` is generated from `NODE_REGISTRY` so that the
public page at /build can show the real node types without a tenant token. A
generated file that nobody verifies is just a slower way to go stale, so this
test regenerates it in memory and fails if the committed copy has drifted.

When this fails the fix is one command:

    python scripts/gen_node_catalog.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from gravai_workflow import NODE_REGISTRY

CATALOG = Path("apps/web/src/lib/nodeCatalog.ts")


def _committed_nodes() -> dict[str, dict]:
    """Parse the node objects out of the generated TypeScript."""
    source = CATALOG.read_text(encoding="utf-8")
    match = re.search(
        r"export const NODE_CATALOG: CatalogFamily\[\] = (\[.*?\]);\n\nexport const NODE_BY_TYPE",
        source,
        re.DOTALL,
    )
    assert match, "could not find NODE_CATALOG in the generated file"
    families = json.loads(match.group(1))
    return {node["type"]: node for family in families for node in family["nodes"]}


def test_catalog_file_exists() -> None:
    assert CATALOG.exists(), f"{CATALOG} is missing — run scripts/gen_node_catalog.py"


def test_every_registry_node_is_published() -> None:
    """A node the engine has but the page does not is an invisible capability."""
    committed = _committed_nodes()
    missing = sorted(set(NODE_REGISTRY) - set(committed))
    assert not missing, (
        f"{len(missing)} node type(s) in the registry are absent from the public "
        f"catalog: {missing}. Run scripts/gen_node_catalog.py"
    )


def test_no_invented_nodes() -> None:
    """A node on the page that the engine does not have is a false claim.

    This is the direction that actually matters. The public page is a product
    claim: every block a visitor can drag onto the canvas is us saying the
    platform can do that thing.
    """
    committed = _committed_nodes()
    invented = sorted(set(committed) - set(NODE_REGISTRY))
    assert not invented, (
        f"the public catalog advertises {len(invented)} node type(s) that do not "
        f"exist in the engine: {invented}"
    )


@pytest.mark.parametrize("node_type", sorted(NODE_REGISTRY))
def test_node_fields_match_the_registry(node_type: str) -> None:
    """Labels, summaries and the two colour flags must be the registry's own."""
    spec = NODE_REGISTRY[node_type]
    node = _committed_nodes()[node_type]

    assert node["label"] == spec.label
    assert node["summary"] == spec.summary
    assert node["icon"] == spec.icon
    # These two drive the one thing colour means in this product, so a drift
    # here miscolours the diagram rather than merely dating it.
    assert node["usesLlm"] is bool(spec.uses_llm)
    assert node["deterministic"] is bool(spec.deterministic)
    assert node["branching"] is bool(spec.branching)
    assert node["caveat"] == (spec.caveat or None)
