/**
 * The Agent Studio's API surface.
 *
 * Kept apart from `api.ts` because the studio speaks in whole workflows rather
 * than single agents, and mixing the two would leave one long module where
 * every call looks alike.
 *
 * The node library is fetched, never declared here. The canvas renders whatever
 * the backend says exists, so a node type cannot appear in the sidebar that the
 * engine has no executor for — the registry asserts that server-side and this
 * is the client half of the same guarantee.
 */

import { request, type ApiResult } from "@/lib/api";

// --- the node library -------------------------------------------------------

export interface StudioPort {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface StudioConfigField {
  name: string;
  label: string;
  /** text | textarea | number | select | boolean | expression | json */
  kind: string;
  default: unknown;
  help: string;
  choices: string[];
  required: boolean;
  /** True when the value may contain {{ ... }} references to the workflow state. */
  templated: boolean;
}

export interface StudioNodeSpec {
  type: string;
  family: string;
  label: string;
  summary: string;
  inputs: StudioPort[];
  outputs: StudioPort[];
  config: StudioConfigField[];
  /** True when running this node calls the language model. Drives the cost marking. */
  uses_llm: boolean;
  /** A deterministic node's decision cannot be overruled by a model's. */
  deterministic: boolean;
  branching: boolean;
  icon: string;
  /** Stated plainly where a node cannot do the whole of what its name implies. */
  caveat: string;
}

export interface NodeFamily {
  key: string;
  label: string;
  nodes: StudioNodeSpec[];
}

export interface NodeLibrary {
  families: NodeFamily[];
}

// --- a workflow -------------------------------------------------------------

export interface WorkflowNode {
  id: string;
  type: string;
  name: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** Which outcome of a branching node this follows. Empty for ordinary edges. */
  branch: string;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface StudioProblem {
  severity: "error" | "warning";
  message: string;
  node_id: string;
  field: string;
}

export interface WorkflowVersion {
  id: string;
  workflow_id?: string;
  version: string;
  status: "draft" | "deployed" | "retired";
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  created_at: string;
  created_by?: string | null;
}

/** What deploying answers: the promoted version, and the one it replaced. */
export interface Deployment {
  workflow_id: string;
  name: string;
  deployed: WorkflowVersion;
  retired: string | null;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  updated_at: string;
  versions: WorkflowVersion[];
}

export interface WorkflowDetail extends WorkflowSummary {
  definition: WorkflowDefinition;
}

// --- running ----------------------------------------------------------------

export interface NodeTrace {
  node_id: string;
  node_type: string;
  title: string;
  status: "ok" | "failed" | "skipped" | "halted";
  started_at: string;
  duration_ms: number;
  summary: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  detail: Record<string, unknown>;
  error: string;
  branch: string;
  input_tokens: number;
  output_tokens: number;
  cost_inr: string;
  attempts: number;
}

export interface RunResult {
  status: "completed" | "failed" | "awaiting_approval" | "invalid";
  output: Record<string, unknown>;
  state: {
    facts: Record<string, unknown>;
    summaries: string[];
    decisions: {
      node_id: string;
      name: string;
      value: unknown;
      deterministic: boolean;
      reason: string;
    }[];
    warnings: string[];
    artifacts: { node_id: string; name: string; kind: string; ref: string; size_bytes: number }[];
    previous_actions: string[];
    errors: string[];
  };
  trace: NodeTrace[];
  problems: string[];
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_inr: string;
  nodes_run: number;
  nodes_skipped: number;
  run_id?: string;
}

export interface RunSummary {
  id: string;
  workflow_id: string;
  /** Null for a draft run, which has no compiled version behind it. */
  version_id: string | null;
  status: string;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_inr: string;
  started_at: string;
  finished_at: string | null;
}

const base = "/v1/studio";

export const studio = {
  nodes: (token: string | null, signal?: AbortSignal): Promise<ApiResult<NodeLibrary>> =>
    request<NodeLibrary>(`${base}/nodes`, { token, signal }),

  list: (token: string | null, signal?: AbortSignal) =>
    request<WorkflowSummary[]>(`${base}/workflows`, { token, signal }),

  get: (token: string | null, id: string, signal?: AbortSignal) =>
    request<WorkflowDetail>(`${base}/workflows/${encodeURIComponent(id)}`, { token, signal }),

  create: (token: string | null, definition: WorkflowDefinition) =>
    request<WorkflowDetail>(`${base}/workflows`, {
      token,
      method: "POST",
      body: { name: definition.name, description: definition.description, definition },
    }),

  save: (token: string | null, id: string, definition: WorkflowDefinition) =>
    request<WorkflowDetail>(`${base}/workflows/${encodeURIComponent(id)}`, {
      token,
      method: "PUT",
      body: { name: definition.name, description: definition.description, definition },
    }),

  remove: (token: string | null, id: string) =>
    request<void>(`${base}/workflows/${encodeURIComponent(id)}`, { token, method: "DELETE" }),

  /** Check the draft the server has stored, without running it. */
  validate: (token: string | null, id: string) =>
    request<{ runnable: boolean; problems: StudioProblem[]; errors: number; warnings: number }>(
      `${base}/workflows/${encodeURIComponent(id)}/validate`,
      { token, method: "POST" },
    ),

  /**
   * Run the SAVED draft.
   *
   * The definition is deliberately not sent: the server runs what it has
   * stored, so a run always corresponds to a definition that exists as a
   * record. The page therefore saves before running, and says so.
   */
  run: (token: string | null, id: string, inputs: Record<string, unknown>) =>
    request<RunResult>(`${base}/workflows/${encodeURIComponent(id)}/run`, {
      token,
      method: "POST",
      body: { inputs },
      timeoutMs: 300_000,
    }),

  compile: (token: string | null, id: string, version: string, description: string) =>
    request<WorkflowVersion>(`${base}/workflows/${encodeURIComponent(id)}/compile`, {
      token,
      method: "POST",
      body: { version, description },
    }),

  deploy: (token: string | null, id: string, versionId: string) =>
    request<Deployment>(`${base}/workflows/${encodeURIComponent(id)}/deploy`, {
      token,
      method: "POST",
      body: { version_id: versionId },
    }),

  runs: (token: string | null, signal?: AbortSignal) =>
    request<RunSummary[]>(`${base}/runs`, { token, signal }),

  runDetail: (token: string | null, id: string, signal?: AbortSignal) =>
    request<RunResult>(`${base}/runs/${encodeURIComponent(id)}`, { token, signal }),
};

/** A new, empty workflow with the two nodes every workflow needs. */
export function blankWorkflow(name = "Untitled agent"): WorkflowDefinition {
  return {
    name,
    description: "",
    nodes: [
      {
        id: "input",
        type: "input",
        name: "Input",
        // No declared schema, deliberately.
        //
        // This used to seed `{ loan_id: "string" }`, which put a field nobody
        // asked for into every new workflow and made declaring one look like a
        // required first step. It is not: in the engine `input.schema` is
        // optional, the node's only output is `payload: object` — whatever the
        // caller sent — and every node downstream reads the shared state rather
        // than a typed port. A new canvas therefore accepts anything, which is
        // both the honest default and the one people usually want, since the
        // input to a step is normally an earlier step's output or a payload
        // some API posted in its own shape.
        config: {},
        position: { x: 80, y: 200 },
      },
      {
        id: "output",
        type: "output",
        name: "Output",
        // No mapping either, for the same reason as the Input node above.
        //
        // This used to seed `{ decision: "{{workflow.facts.decision}}" }`. That
        // was worse than it looked: the engine renders output expressions
        // strictly, so on any workflow that did not happen to publish a fact
        // called `decision` — which is every new one — the seed resolved to
        // null and pushed "output mapping — decision: ..." into the run's
        // warnings. A starter value that makes a clean run look faulty teaches
        // people to ignore warnings, which is the opposite of what this product
        // needs.
        //
        // THE TRADE, STATED PLAINLY. An empty mapping returns `{}` rather than
        // the whole state — `_output` builds its answer only from the keys it
        // is given. So a workflow answers with nothing until someone names a
        // field. That is the correct default: what a deployed agent returns is
        // its public contract, and guessing it on a tenant's behalf is how you
        // end up with an endpoint that promises a field nobody meant.
        //
        // The expression syntax stays discoverable through the field's own help
        // in the config panel, which is where a person is when they need it.
        config: {},
        position: { x: 720, y: 200 },
      },
    ],
    edges: [],
  };
}

/**
 * A readable id for a new node.
 *
 * Derived from the type and made unique against what is already on the canvas,
 * because ids appear in `{{nodes.<id>.field}}` references and a UUID there
 * would make every expression unreadable.
 */
export function nextNodeId(type: string, existing: WorkflowNode[]): string {
  const stem = type.replace(/^agent\./, "").replace(/[^a-z0-9_]/gi, "_");
  const taken = new Set(existing.map((node) => node.id));
  if (!taken.has(stem)) return stem;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}_${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}_${Date.now()}`;
}

/** The config a fresh node starts with, taken from the spec's declared defaults. */
export function defaultConfig(spec: StudioNodeSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of spec.config) {
    config[field.name] = field.default;
  }
  return config;
}
