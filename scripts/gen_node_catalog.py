"""Emit the workflow node registry as a static TypeScript module.

WHY THIS EXISTS. The console's Agent Studio fetches its node library from
`/v1/studio/nodes`, which needs a tenant token — `apps/web/src/lib/studio.ts`
says so in its own first comment: the library is fetched, never declared. That
is the right call for the console, where the build the tenant is running is the
only library that matters.

The public agent sketchpad has no token and never will, so it cannot fetch. The
alternative to this file is a hand-written list of node types on a marketing
page, which is precisely the kind of second description of the system that
starts accurate and goes quietly wrong the first time a node is added — and
nobody would be able to tell it had.

So the list is generated from the registry instead, and regenerating it is one
command. If the registry changes and this file is not regenerated, the test in
tests/test_node_catalog.py fails, which is the whole point: a stale public page
becomes a red build rather than a quiet lie.

    python scripts/gen_node_catalog.py
"""

from __future__ import annotations

import json
from pathlib import Path

from gravai_workflow import NODE_REGISTRY

OUT = Path("apps/web/src/lib/nodeCatalog.ts")

# ---------------------------------------------------------------------------
# Hue assignment.
#
# The interface is colourful on purpose: a canvas of forty identical grey cards
# is harder to read than one where a node's family is legible at a glance from
# across the room. But a hue has to MEAN something or it is just noise, so the
# mapping is declared here, once, and generated into the catalog — rather than
# being typed into a className somewhere and quietly diverging.
#
# Two rules hold the system together:
#
#   1. A node that calls a language model is never drawn in a deterministic
#      node's hue family, and vice versa. That distinction is the platform's
#      central claim and it survives the colour.
#   2. Semantic hues are reserved. Green means a run proceeds, red means it
#      stops, amber means risk or a rule that can reject. Nothing decorative is
#      allowed to borrow them, because a green card that does not mean "passed"
#      makes every green card unreadable.
#
# Anything unmapped falls back to its family's base hue, so a node added to the
# engine tomorrow is coloured sensibly without touching this file.
HUE_BY_FAMILY = {
    "gravai": "teal",
    "data": "blue",
    "intelligence": "violet",
    "business": "amber",
    "control": "indigo",
    "memory": "rose",
}

HUE_BY_TYPE = {
    # Agents — varied within the family so fourteen of them do not read as one
    # block, but each hue is chosen for the work the agent does.
    "agent.doc_intelligence": "teal",
    "agent.bank_statement_analytics": "blue",
    "agent.credit_appraisal": "indigo",
    "agent.risk_scoring": "amber",          # risk is amber, always
    "agent.aa_data": "cyan",
    "agent.kyc_verification": "violet",     # identity, like the human nodes
    "agent.case_allocation": "rose",
    "agent.smart_mandate": "indigo",
    "agent.voice_collections": "orange",
    "agent.speech_analytics": "pink",
    "agent.onboarding_assistant": "violet",
    "agent.msme_underwriting": "green",
    "agent.customer_data_intelligence": "cyan",
    "agent.ops_research": "slate",
    # Flow — where the run enters, branches and leaves.
    "input": "violet",
    "output": "blue",
    "condition": "indigo",
    "router": "indigo",
    "human_approval": "violet",             # a person is involved: same hue as input
    # Sources and tools.
    "document_source": "navy",
    "http": "blue",
    "mcp": "teal",
    # Models.
    "llm": "teal",
    "classifier": "teal",
    "extractor": "teal",
    "summarizer": "indigo",
    # Rules and maths — deterministic, and one of them can reject.
    "bre": "amber",
    "validator": "blue",
    "calculator": "slate",
    # Memory.
    "context_compiler": "rose",
    "set_state": "slate",
}


def hue_for(node_type: str, family: str) -> str:
    return HUE_BY_TYPE.get(node_type, HUE_BY_FAMILY.get(family, "slate"))



# The order families appear in the sketchpad's left rail. Agents first because
# they are what the platform is actually for; plumbing afterwards.
FAMILY_ORDER = ["gravai", "data", "intelligence", "business", "control", "memory"]

FAMILY_LABEL = {
    "gravai": "Agents",
    "data": "Sources & tools",
    "intelligence": "Models",
    "business": "Rules & maths",
    "control": "Flow",
    "memory": "Memory",
}


def main() -> None:
    families: dict[str, list[dict]] = {}
    for node_type, spec in NODE_REGISTRY.items():
        families.setdefault(spec.family, []).append(
            {
                "type": node_type,
                "label": spec.label,
                "summary": spec.summary,
                "icon": spec.icon,
                "usesLlm": bool(spec.uses_llm),
                "deterministic": bool(spec.deterministic),
                "branching": bool(spec.branching),
                "caveat": spec.caveat or None,
                "hue": hue_for(node_type, spec.family),
            }
        )

    ordered = []
    for family in FAMILY_ORDER:
        if family not in families:
            continue
        ordered.append(
            {
                "key": family,
                "label": FAMILY_LABEL.get(family, family.title()),
                "nodes": sorted(families[family], key=lambda n: n["label"]),
            }
        )
    # Any family added to the engine that this script has not been taught about
    # still ships, under its own name, rather than silently disappearing.
    for family in sorted(set(families) - set(FAMILY_ORDER)):
        ordered.append(
            {
                "key": family,
                "label": FAMILY_LABEL.get(family, family.replace("_", " ").title()),
                "nodes": sorted(families[family], key=lambda n: n["label"]),
            }
        )

    body = json.dumps(ordered, indent=2, ensure_ascii=False)
    total = sum(len(f["nodes"]) for f in ordered)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        f'''/**
 * The workflow node registry, as static data.
 *
 * GENERATED FILE — do not edit by hand. Run `python scripts/gen_node_catalog.py`
 * and commit the result. `tests/test_node_catalog.py` fails if this drifts from
 * the engine's own registry.
 *
 * WHY IT IS GENERATED. The console fetches its node library from the API, which
 * needs a tenant token — see the note at the top of `studio.ts`. The public
 * sketchpad at /build has no token, so it needs the list at build time. Writing
 * that list by hand would create a second description of the platform that goes
 * stale the first time a node is added, with nothing to catch it. Generating it
 * means the public page is wrong only when the engine is wrong.
 *
 * `usesLlm` and `deterministic` are the two flags the interface actually reads:
 * they drive the one thing colour means here — teal is a language model
 * reasoning, navy is deterministic code. `branching` marks the nodes drawn as a
 * decision diamond rather than a card.
 *
 * {total} node types across {len(ordered)} families, from `gravai_workflow.NODE_REGISTRY`.
 */

export interface CatalogNode {{
  type: string;
  label: string;
  summary: string;
  icon: string;
  /** True when this node calls a language model. Drawn teal. */
  usesLlm: boolean;
  /** True when this node is code with a fixed answer. Drawn navy. */
  deterministic: boolean;
  /** True when this node sends the run down one of several branches. */
  branching: boolean;
  /** A limitation worth stating before someone places the node. */
  caveat: string | null;
  /** Palette key. Resolves to --gv-hue-<hue>-* tokens. See the generator for why. */
  hue: string;
}}

export interface CatalogFamily {{
  key: string;
  label: string;
  nodes: CatalogNode[];
}}

export const NODE_CATALOG: CatalogFamily[] = {body};

export const NODE_BY_TYPE: Record<string, CatalogNode> = Object.fromEntries(
  NODE_CATALOG.flatMap((family) => family.nodes.map((node) => [node.type, node])),
);
''',
        encoding="utf-8",
    )
    print(f"wrote {OUT} — {total} node types across {len(ordered)} families")


if __name__ == "__main__":
    main()
