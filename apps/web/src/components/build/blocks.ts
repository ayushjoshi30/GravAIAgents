/**
 * The blocks the sketchpad offers, and the few things the canvas needs that the
 * registry does not carry.
 *
 * The node list itself is NOT written here. It comes from `lib/nodeCatalog.ts`,
 * which is generated from `gravai_workflow.NODE_REGISTRY` and guarded against
 * drift by a test — so every label, every sentence and every caveat on this
 * page is the engine's own wording, and a node cannot appear in the rail that
 * the engine has no executor for. Transcribing the list into this file instead
 * would create a second description of the platform that goes stale the first
 * time a node is added, with nothing to catch it.
 *
 * What this module adds is presentation the registry has no opinion about: the
 * word printed under a node's title, the branch names a split offers, and a
 * note where a limit belongs to this page rather than to the platform.
 */

import type { CSSProperties } from "react";
import type { IconName } from "@/components/icons/AgentIcon";
import { NODE_CATALOG, NODE_BY_TYPE, type CatalogNode } from "@/lib/nodeCatalog";

export interface Family {
  key: string;
  label: string;
}

export const FAMILIES: Family[] = NODE_CATALOG.map((family) => ({
  key: family.key,
  label: family.label,
}));

/**
 * The word printed under a node's title on the canvas.
 *
 * Derived from the node's type and family rather than stored, so it cannot
 * disagree with the block it labels.
 */
export type BlockKind =
  | "input"
  | "output"
  | "agent"
  | "model"
  | "tool"
  | "rule"
  | "branch"
  | "human gate"
  | "memory";

const KIND_BY_TYPE: Record<string, BlockKind> = {
  input: "input",
  output: "output",
  human_approval: "human gate",
  router: "branch",
  condition: "branch",
};

const KIND_BY_FAMILY: Record<string, BlockKind> = {
  gravai: "agent",
  intelligence: "model",
  data: "tool",
  business: "rule",
  control: "rule",
  memory: "memory",
};

/**
 * The branch names a splitting node offers.
 *
 * A condition's two outcomes are fixed by the engine. A router's are named in
 * its configuration, which a sketch does not carry — see `sketchNote` below.
 * Nothing else in the registry branches, and a node that did but was not listed
 * here would simply offer no branches rather than invent some.
 */
const BRANCHES: Record<string, string[]> = {
  condition: ["true", "false"],
  router: ["branch 1", "branch 2"],
};

const SKETCH_NOTES: Record<string, string> = {
  router:
    "A router's branches are named in its configuration, which a sketch does not carry. Two unnamed ones are drawn so the shape of the split is visible.",
};

export interface Block {
  /** The engine's own node type. `agent.<id>` for a catalog agent. */
  type: string;
  family: string;
  familyLabel: string;
  label: string;
  /** One line, the registry's own. Never rewritten to sound better. */
  summary: string;
  kind: BlockKind;
  /**
   * True when running this step calls the language model.
   *
   * This — not `deterministic` — is the model/code distinction the interface
   * makes, because it is the thing the claim is about: a model reasoned, or code
   * decided. `usesLlm` is exactly that question and nothing else.
   *
   * It used to be carried by the plate colour alone, teal against navy. It no
   * longer is. The plate now carries `hue`, so the distinction is printed as a
   * word on every card instead — which it should always have been, since a
   * meaning signalled only by a colour is a meaning a colour-blind underwriter
   * cannot read.
   */
  usesLlm: boolean;
  /**
   * The node's place in the twelve-family categorical palette.
   *
   * Taken from the generated catalog and never decided here. The mapping of node
   * type to hue lives in `scripts/gen_node_catalog.py` and a test fails if this
   * file and the engine's registry disagree, so a component that invented its
   * own lookup would be a second, unguarded answer to a question that already
   * has one. Resolve it with `hueStyle` below rather than by building class
   * names, because Tailwind cannot generate a class from a value only known at
   * runtime and a half-written lookup would fail silently for the hue nobody
   * remembered.
   */
  hue: string;
  branching: boolean;
  branches: string[];
  /**
   * The registry's own caveat: where a node cannot do the whole of what its
   * name implies, it says so, and so does the card here. Printed unsoftened.
   */
  caveat: string;
  /**
   * A limit of THIS PAGE rather than of the platform, kept apart so the two are
   * never confused. A caveat is something the engine cannot do; a sketch note is
   * something a drawing with no configuration cannot show.
   */
  sketchNote: string;
  /** A generic glyph, or "" when the agent's own artwork is used instead. */
  icon: IconName | "";
  /** Set for `agent.*` blocks only, so the agent's drawing can be looked up. */
  agentId: string;
}

/**
 * A block's hue, as four custom properties to hang on an element.
 *
 * Tailwind builds its stylesheet by reading the source for complete class
 * names, so `bg-${hue}-soft` produces nothing at all — the class is assembled
 * in the browser, long after the stylesheet was written. The way round it that
 * does not rot is to keep the class name constant, `bg-[var(--plate)]`, and
 * move the varying part into a custom property set inline. A lookup table of
 * literal class strings would also compile, but it is a third copy of the
 * hue-to-node mapping, and the failure when someone adds a node and forgets the
 * table is an invisible one: a card that quietly renders with no plate.
 *
 * The four steps are the palette's own, documented beside the tokens in
 * `globals.css`: `--plate` is the tinted ground, `--plate-border` its edge,
 * `--plate-accent` the base value for iconography, and `--plate-strong` the
 * darkened step for text that has to hold contrast at small sizes.
 *
 * Typed through `CSSProperties` with a cast because React's style prop accepts
 * custom properties at runtime but its published type does not admit them.
 */
export function hueStyle(hue: string): CSSProperties {
  return {
    "--plate": `var(--gv-hue-${hue}-soft)`,
    "--plate-border": `var(--gv-hue-${hue}-border)`,
    "--plate-accent": `var(--gv-hue-${hue})`,
    "--plate-strong": `var(--gv-hue-${hue}-strong)`,
  } as CSSProperties;
}

/** The generic glyph names `AgentIcon.tsx` draws. An icon the registry names
 *  that is not one of these is an agent id, or nothing. */
const GLYPHS = new Set<string>([
  "shield", "clock", "chain", "database", "bolt", "check", "cross", "warning",
  "book", "terminal", "globe", "menu", "close", "chevron", "external", "grid",
  "activity", "inbox", "file", "chart", "settings", "sliders",
]);

function toBlock(node: CatalogNode, family: { key: string; label: string }): Block {
  const isAgent = node.type.startsWith("agent.");
  return {
    type: node.type,
    family: family.key,
    familyLabel: family.label,
    label: node.label,
    summary: node.summary,
    kind: KIND_BY_TYPE[node.type] ?? KIND_BY_FAMILY[family.key] ?? "rule",
    usesLlm: node.usesLlm,
    hue: node.hue,
    branching: node.branching,
    branches: BRANCHES[node.type] ?? [],
    caveat: node.caveat ?? "",
    sketchNote: SKETCH_NOTES[node.type] ?? "",
    icon: !isAgent && GLYPHS.has(node.icon) ? (node.icon as IconName) : "",
    agentId: isAgent ? node.type.slice("agent.".length) : "",
  };
}

export const BLOCKS: Block[] = NODE_CATALOG.flatMap((family) =>
  family.nodes.map((node) => toBlock(node, family)),
);

const BY_TYPE = new Map<string, Block>(BLOCKS.map((entry) => [entry.type, entry]));

/**
 * The block behind a node type.
 *
 * Returns undefined rather than a stand-in, because a card that invents a
 * description for a type nobody recognises is the exact failure this product is
 * built to avoid. Callers say "not recognised" instead.
 */
export function blockFor(type: string): Block | undefined {
  return BY_TYPE.get(type);
}

/** True when the generated catalog knows this type at all. */
export function isKnownType(type: string): boolean {
  return type in NODE_BY_TYPE;
}

/** The library grouped for the rail, in the catalog's own family order and its
 *  own within-family order. */
export function groupedBlocks(query: string): { key: string; label: string; blocks: Block[] }[] {
  const needle = query.trim().toLowerCase();
  const matches = (entry: Block) =>
    needle.length === 0 ||
    entry.label.toLowerCase().includes(needle) ||
    entry.summary.toLowerCase().includes(needle) ||
    entry.type.toLowerCase().includes(needle);

  return NODE_CATALOG.map((family) => ({
    key: family.key,
    label: family.label,
    blocks: family.nodes.map((node) => toBlock(node, family)).filter(matches),
  }));
}
