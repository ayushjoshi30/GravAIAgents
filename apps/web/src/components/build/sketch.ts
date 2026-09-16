/**
 * What a sketch is, and what it is not.
 *
 * A sketch is the shape of a workflow — which steps, in what order, branching
 * where — and nothing else. It has no node configuration, no credentials, no
 * version and no run. It lives in this browser tab and nowhere else: there is
 * no request on this page, and closing the tab ends it.
 *
 * The shape below is deliberately the same shape the Agent Studio stores, so
 * "copy as JSON" hands over something a person can actually read next to the
 * real thing rather than a marketing-site invention. It is redeclared here
 * rather than imported from `lib/studio.ts` on purpose: that module carries the
 * authenticated API client with it, and a public page has no business pulling
 * a token-bearing client into its bundle to borrow four interfaces.
 */

/** The port types the engine recognises, from `PortType` in the registry. */
export const VARIABLE_TYPES = ["string", "number", "boolean", "object", "array", "any"] as const;

export type VariableType = (typeof VARIABLE_TYPES)[number];

export interface SketchNode {
  id: string;
  /** A node type from the registry: `input`, `condition`, `agent.risk_scoring`… */
  type: string;
  name: string;
  position: { x: number; y: number };
}

export interface SketchEdge {
  id: string;
  source: string;
  target: string;
  /**
   * Which outcome of a branching node this edge follows; empty for an ordinary
   * edge. It is also what decides how the edge is drawn: an edge with a branch
   * is dashed, because it is travelled only when that branch is chosen, and an
   * edge without one is solid, because it always is. That is the engine's own
   * behaviour, not a decorative distinction.
   */
  branch: string;
}

export interface SketchVariable {
  /** Stable across renames so a row keeps its identity while being typed into. */
  id: string;
  name: string;
  type: VariableType;
}

export interface Sketch {
  name: string;
  description: string;
  nodes: SketchNode[];
  edges: SketchEdge[];
  variables: SketchVariable[];
}

/**
 * A readable id for a new node, made unique against the canvas.
 *
 * Mirrors `nextNodeId` in `lib/studio.ts`, and for the same reason: ids appear
 * in `{{nodes.<id>.field}}` references in the console, and a UUID there would
 * make every expression unreadable. Someone who carries a sketch across keeps
 * names they can type.
 */
export function nextNodeId(type: string, existing: SketchNode[]): string {
  const stem = type.replace(/^agent\./, "").replace(/[^a-z0-9_]/gi, "_");
  const taken = new Set(existing.map((node) => node.id));
  if (!taken.has(stem)) return stem;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}_${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}_${Date.now()}`;
}

/** Ids for edges and variables. Not cryptographic; they only have to be unique
 *  inside one tab's sketch. */
let counter = 0;
export function localId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

export function edgeId(source: string, target: string, branch: string): string {
  return `${source}->${target}${branch ? `:${branch}` : ""}`;
}

/**
 * The sketch the page opens with.
 *
 * A real retail-loan shape, drawn with real agents: documents and statements
 * are independent of each other so they sit side by side (the engine runs
 * whatever is ready, so they would genuinely run at once), risk needs both, and
 * the decision itself reaches a person either way — the Credit Appraisal agent
 * always escalates the decision, so a canvas that ran straight to Output would
 * be drawing something the platform will not do.
 *
 * The input variable is `loan_id`, which is the registry's own default input
 * schema for an Input node, not a figure invented for a screenshot.
 */
export function seedSketch(): Sketch {
  const nodes: SketchNode[] = [
    { id: "input", type: "input", name: "Application received", position: { x: 40, y: 250 } },
    {
      id: "doc_intelligence",
      type: "agent.doc_intelligence",
      name: "Read the documents",
      position: { x: 330, y: 110 },
    },
    {
      id: "bank_statement_analytics",
      type: "agent.bank_statement_analytics",
      name: "Read the statements",
      position: { x: 330, y: 360 },
    },
    {
      id: "risk_scoring",
      type: "agent.risk_scoring",
      name: "Score the risk",
      position: { x: 660, y: 235 },
    },
    {
      id: "condition",
      type: "condition",
      name: "Risk band is GREEN",
      position: { x: 990, y: 255 },
    },
    {
      id: "credit_appraisal",
      type: "agent.credit_appraisal",
      name: "Write the memorandum",
      position: { x: 1190, y: 90 },
    },
    {
      id: "human_approval",
      type: "human_approval",
      name: "Underwriter decides",
      position: { x: 1530, y: 250 },
    },
    { id: "output", type: "output", name: "Decision", position: { x: 1860, y: 250 } },
  ];

  const edges: SketchEdge[] = [
    { id: edgeId("input", "doc_intelligence", ""), source: "input", target: "doc_intelligence", branch: "" },
    {
      id: edgeId("input", "bank_statement_analytics", ""),
      source: "input",
      target: "bank_statement_analytics",
      branch: "",
    },
    {
      id: edgeId("doc_intelligence", "risk_scoring", ""),
      source: "doc_intelligence",
      target: "risk_scoring",
      branch: "",
    },
    {
      id: edgeId("bank_statement_analytics", "risk_scoring", ""),
      source: "bank_statement_analytics",
      target: "risk_scoring",
      branch: "",
    },
    { id: edgeId("risk_scoring", "condition", ""), source: "risk_scoring", target: "condition", branch: "" },
    {
      id: edgeId("condition", "credit_appraisal", "true"),
      source: "condition",
      target: "credit_appraisal",
      branch: "true",
    },
    {
      id: edgeId("condition", "human_approval", "false"),
      source: "condition",
      target: "human_approval",
      branch: "false",
    },
    {
      id: edgeId("credit_appraisal", "human_approval", ""),
      source: "credit_appraisal",
      target: "human_approval",
      branch: "",
    },
    { id: edgeId("human_approval", "output", ""), source: "human_approval", target: "output", branch: "" },
  ];

  return {
    name: "Retail loan, end to end",
    description: "Read what the applicant sent, score it, and put the decision in front of a person.",
    nodes,
    edges,
    /* A literal id rather than a generated one: the seed renders on the server
       and again in the browser, and an id that counts up would not agree
       across the two. Ids generated after that are for rows a visitor added,
       which only ever happens in the browser. */
    variables: [{ id: "var_seed", name: "loan_id", type: "string" }],
  };
}

/**
 * The sketch as JSON.
 *
 * `config` is present and empty on every node, which is the truthful
 * representation: a sketch records that a step exists and where it sits, and
 * says nothing about how it is configured. Leaving the key out would suggest
 * the definition was complete; filling it with plausible-looking values would
 * be worse still.
 */
export function sketchToJson(sketch: Sketch): string {
  return JSON.stringify(
    {
      name: sketch.name,
      description: sketch.description,
      input_schema: Object.fromEntries(
        sketch.variables.filter((v) => v.name.trim()).map((v) => [v.name.trim(), v.type]),
      ),
      nodes: sketch.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        name: node.name,
        config: {},
        position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      })),
      edges: sketch.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        branch: edge.branch,
      })),
    },
    null,
    2,
  );
}

/**
 * Somewhere sensible to drop a node added from the keyboard.
 *
 * A dragged node lands where it was dropped. A node added with Enter has no
 * pointer to take a position from, so it is placed to the right of whatever is
 * already furthest right, on a lane that is free — which is where a person
 * building left-to-right would have put it anyway.
 */
export function nextFreePosition(nodes: SketchNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 80, y: 220 };
  const rightmost = nodes.reduce((best, node) => (node.position.x > best.position.x ? node : best));
  const lane = { x: rightmost.position.x + 320, y: rightmost.position.y };
  // Nudge down until nothing else is sitting in that spot.
  while (nodes.some((node) => Math.abs(node.position.x - lane.x) < 40 && Math.abs(node.position.y - lane.y) < 40)) {
    lane.y += 170;
  }
  return lane;
}
