/**
 * Typed client for the GravAI REST API.
 *
 * Design rule: this client never throws at a call site and never crashes a
 * screen. Every method returns a discriminated result. A 404 from an endpoint
 * that has not shipped yet is reported as `not-implemented`, a refused
 * connection as `unreachable`, an expired token as `unauthenticated` — and the
 * console renders the matching empty state rather than an error boundary.
 *
 * Endpoints that exist today:
 *   GET  /healthz                            GET  /readyz
 *   GET  /v1/agents                          GET  /v1/agents/{id}
 *   GET  /v1/applications                    GET  /v1/applications/summary
 *   GET  /v1/applications/{id}               POST /v1/applications
 *   GET  /v1/applications/{id}/eligibility
 *   GET  /v1/audit                           POST /v1/audit/verify
 *   GET  /v1/connectors
 *
 * Endpoints that land later are declared here and degrade to an empty state:
 *   /v1/runs  /v1/usage  /v1/tasks
 */

export const API_BASE = (
  process.env.NEXT_PUBLIC_GRAVAI_API_BASE ?? "http://localhost:8000"
).replace(/\/+$/, "");

export const API_ENV = process.env.NEXT_PUBLIC_GRAVAI_ENV ?? "local";

export type FailureKind =
  | "no-token"
  | "unauthenticated"
  | "forbidden"
  | "not-implemented"
  | "unreachable"
  | "server"
  | "bad-response";

export interface ApiFailure {
  ok: false;
  kind: FailureKind;
  status?: number;
  message: string;
  correlationId?: string;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

/** RFC 9457 problem document, as the API emits it. */
interface ProblemDetail {
  title?: string;
  detail?: string;
  code?: string;
  status?: number;
  correlation_id?: string | null;
  [key: string]: unknown;
}

export const FAILURE_COPY: Record<FailureKind, string> = {
  "no-token": "No API token set. Add one in Settings to connect this console.",
  unauthenticated: "The API rejected this token. It may have expired.",
  forbidden: "This token does not hold the scope required for this view.",
  "not-implemented": "This endpoint has not shipped yet in the API build you are pointed at.",
  unreachable: "The GravAI API is not reachable from this browser.",
  server: "The API returned an error.",
  "bad-response": "The API returned a response this console could not read.",
};

interface RequestOptions {
  token?: string | null;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Endpoints that are public on the API (health, readiness). */
  anonymous?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * One fetch, with the timeout, the bearer token and the problem-document
 * handling every call needs. Exported so the studio client can speak the same
 * dialect rather than re-implementing failure handling with subtly different
 * messages.
 */
/**
 * A failure message that is always a string.
 *
 * `detail` is a string in this API's own problem documents, but FastAPI answers
 * a request-validation failure with a LIST of `{loc, msg, type}` objects. Passing
 * that straight through typed as a string put an array of objects into React,
 * which throws "Objects are not valid as a React child" and takes the whole page
 * down — a 422 turning into a blank screen, on every page in the console.
 */
function readableDetail(problem: ProblemDetail, status: number, statusText: string): string {
  const detail: unknown = problem.detail;

  if (typeof detail === "string" && detail.trim()) return detail;

  if (Array.isArray(detail)) {
    const parts = detail
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const item = entry as { loc?: unknown; msg?: unknown };
          const where = Array.isArray(item.loc)
            ? item.loc.filter((part) => part !== "body").join(".")
            : "";
          const what = typeof item.msg === "string" ? item.msg : JSON.stringify(entry);
          return where ? `${where}: ${what}` : what;
        }
        return String(entry);
      })
      .filter(Boolean);
    if (parts.length) return parts.join("; ");
  }

  if (typeof problem.title === "string" && problem.title.trim()) return problem.title;
  return `${status} ${statusText}`;
}

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const {
    token,
    method = "GET",
    body,
    anonymous = false,
    signal,
    timeoutMs = 12_000,
  } = options;

  if (!anonymous && !token) {
    return { ok: false, kind: "no-token", message: FAILURE_COPY["no-token"] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token && !anonymous) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
      mode: "cors",
    });
  } catch {
    return { ok: false, kind: "unreachable", message: FAILURE_COPY.unreachable };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 204) {
    return { ok: true, data: undefined as T };
  }

  const rawText = await response.text().catch(() => "");
  let parsed: unknown = undefined;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = undefined;
    }
  }

  if (!response.ok) {
    const problem = (parsed ?? {}) as ProblemDetail;
    const correlationId =
      response.headers.get("X-Correlation-Id") ?? problem.correlation_id ?? undefined;
    const message = readableDetail(problem, response.status, response.statusText);

    let kind: FailureKind = "server";
    if (response.status === 401) kind = "unauthenticated";
    else if (response.status === 403) kind = "forbidden";
    else if (response.status === 404 || response.status === 405) kind = "not-implemented";
    else if (response.status >= 500) kind = "server";
    else kind = "bad-response";

    return {
      ok: false,
      kind,
      status: response.status,
      message,
      correlationId: correlationId ?? undefined,
    };
  }

  if (parsed === undefined && rawText) {
    return { ok: false, kind: "bad-response", message: FAILURE_COPY["bad-response"] };
  }

  return { ok: true, data: parsed as T };
}

// --- Response shapes, mirroring the FastAPI models ------------------------

export interface HealthOut {
  status: string;
  service: string;
  version: string;
}

export interface ReadinessOut {
  status: string;
  checks: {
    database: { ok: boolean; dialect: string; row_level_security: boolean };
  };
  /** `sarvam_sandbox` is the wire field name; the console surfaces it as "AI sandbox". */
  mode: { environment: string; sarvam_sandbox: boolean; auth: string };
}

export interface AgentOut {
  id: string;
  name: string;
  tier: string;
  summary: string;
  tool_name: string;
  scopes: string[];
  advisory_only: boolean;
  parity_with: string | null;
  tags: string[];
}

/** One MCP tool as a client would be offered it. */
export interface McpToolOut {
  name: string;
  family: string;
  description: string;
  input_schema: Record<string, unknown>;
  scopes: string[];
  read_only: boolean;
  destructive: boolean;
  long_running: boolean;
  tags: string[];
  runnable: boolean;
  permitted: boolean;
}

export interface McpSurfaceOut {
  total_tools: number;
  permitted_tools: number;
  held_scopes: string[];
  tools: McpToolOut[];
}

/** What POST /v1/agents/{id}/run returns. */
export interface AgentRunResult {
  agent_id: string;
  name: string;
  run_id: string;
  /** Sandbox output must never underwrite a real decision. */
  sandbox: boolean;
  escalated: boolean;
  escalation_reason: string | null;
  guardrails_passed: boolean;
  guardrail_violations: string[];
  reasoning_summary: string | null;
  cost_inr: string;
  steps: { name: string; kind: string; attempts: number }[];
  /** Only what you supplied. Everything else was read from the source. */
  overrides_applied: Record<string, unknown>;
  source: SourceReport | null;
  output: Record<string, unknown>;
}

/** What a document-source fetch actually produced. */
export interface SourceReport {
  url: string;
  content_type: string;
  bytes_fetched: number;
  documents: number;
  documents_with_content: number;
  transactions: number;
  application_fields: string[];
  account_fields: string[];
  /** Every field-name mapping the parser inferred, in plain words. */
  notes: string[];
  /** True when this alone can drive a run with no document-AI layer. */
  usable_without_extraction: boolean;
}

/** One editable input, as GET /v1/agents/{id}/inputs declares it. */
export interface AgentInputField {
  name: string;
  label: string;
  kind: "number" | "money" | "text" | "textarea" | "select";
  default: unknown;
  help: string;
  minimum: number | null;
  maximum: number | null;
  choices: string[];
  /** True when a real source supplies this, so blank means read it from there. */
  sourced: boolean;
  source_label: string;
  /** What leaving this field alone will do, in words. */
  blank_means: string;
}

/** The editable surface of one agent. `editable: false` still carries a caveat. */
export interface AgentInputsOut {
  agent_id: string;
  editable: boolean;
  caveat: string;
  fields: AgentInputField[];
}

export interface ApplicationOut {
  id: string;
  external_id: string;
  product: string;
  status: string;
  applicant_name: string;
  aadhaar_last4: string | null;
  loan_amount: string | null;
  tenure_months: number | null;
  interest_rate_pct: string | null;
  collateral_value: string | null;
  net_monthly_income: string | null;
  existing_monthly_emi: string | null;
  document_count: number;
}

export interface EligibilityOut {
  application_id: string;
  proposed_emi: string;
  proposed_emi_display: string;
  foir: string | null;
  foir_display: string | null;
  ltv: string | null;
  ltv_display: string | null;
  formula: Record<string, string>;
  missing_inputs: string[];
}

export interface AuditEntryOut {
  id: string;
  seq: number;
  action: string;
  actor_type: string;
  actor_id: string;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  prev_hash: string;
  hash: string;
  recorded_at: string;
}

export interface ChainVerificationOut {
  ok: boolean;
  checked: number;
  first_bad_seq: number | null;
  reason: string | null;
}

export interface ConnectorOut {
  id: string;
  name: string;
  status: string;
  summary: string;
  onboarding_requirement: string;
}

// --- Shapes for endpoints that have not shipped yet ----------------------
// Declared so the console is written against the contract rather than against
// whatever the first response happens to look like.

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "escalated"
  | "cancelled";

export interface RunStepOut {
  id: string;
  name: string;
  status: "ok" | "failed" | "skipped";
  prompt_version: string | null;
  model: string | null;
  redacted_input: string;
  output: unknown;
  validators: { name: string; result: "pass" | "fail"; detail?: string }[];
  input_tokens: number;
  output_tokens: number;
  cost_inr: number;
  latency_ms: number;
  citations: { document_id: string; page: number; label?: string }[];
  started_at: string;
}

export interface RunOut {
  id: string;
  tenant: string;
  agent_id: string;
  application_id: string | null;
  status: RunStatus;
  band: string | null;
  cost_inr: number;
  duration_ms: number;
  escalated: boolean;
  started_at: string;
  steps?: RunStepOut[];
}

export interface TaskOut {
  id: string;
  type: "decision" | "deviation" | "call_review" | "pendency";
  title: string;
  application_id: string | null;
  agent_id: string | null;
  severity: "L1" | "L2" | "L3" | null;
  raised_at: string;
  sla_due_at: string | null;
  assigned_to: string | null;
  summary: string;
  detail: Record<string, string>;
}

export interface UsageRow {
  date: string;
  tenant: string;
  agent_id: string;
  /** Provider-neutral product key, e.g. `docai_extract`. */
  product: string;
  /**
   * Neutral display name supplied by the API, e.g. "Document extraction".
   * Always render this in preference to the key; `productLabel()` is the
   * fallback for older API builds that do not send it.
   */
  label?: string;
  requests: number;
  /** Billable API calls for this row (renamed from the old provider-specific key). */
  api_calls?: number;
  input_tokens: number;
  output_tokens: number;
  pages: number;
  audio_seconds: number;
  cost_inr: number;
}

export interface GovernorStateOut {
  product: string;
  capacity: number;
  available: number;
  queue_depth: number;
  tenants_waiting: number;
  estimated_wait_seconds: number;
}

// --- Methods --------------------------------------------------------------

export const api = {
  health: (signal?: AbortSignal) =>
    request<HealthOut>("/healthz", { anonymous: true, timeoutMs: 5000, signal }),

  readiness: (signal?: AbortSignal) =>
    request<ReadinessOut>("/readyz", { anonymous: true, timeoutMs: 5000, signal }),

  listAgents: (token: string | null, signal?: AbortSignal) =>
    request<AgentOut[]>("/v1/agents", { token, signal }),

  getAgent: (token: string | null, id: string, signal?: AbortSignal) =>
    request<AgentOut>(`/v1/agents/${encodeURIComponent(id)}`, { token, signal }),

  /**
   * Execute one agent. The only call in this client that does work rather than
   * reading it, so it is deliberately slow: several agents read documents
   * first, and the credit pipeline reads eight of them.
   */
  agentInputs: (token: string | null, id: string, signal?: AbortSignal) =>
    request<AgentInputsOut>(`/v1/agents/${encodeURIComponent(id)}/inputs`, { token, signal }),

  checkSource: (
    token: string | null,
    source: { url: string; headers?: Record<string, string> },
    signal?: AbortSignal,
  ) =>
    request<SourceReport>("/v1/agents/source/check", {
      token,
      method: "POST",
      body: source,
      timeoutMs: 40_000,
      signal,
    }),

  runAgent: (
    token: string | null,
    id: string,
    inputs: Record<string, unknown> = {},
    source: { url: string; headers?: Record<string, string> } | null = null,
    signal?: AbortSignal,
  ) =>
    request<AgentRunResult>(`/v1/agents/${encodeURIComponent(id)}/run`, {
      token,
      method: "POST",
      body: source ? { inputs, source } : { inputs },
      timeoutMs: 180_000,
      signal,
    }),

  mcpSurface: (token: string | null, signal?: AbortSignal) =>
    request<McpSurfaceOut>("/v1/mcp/tools", { token, signal }),

  listApplications: (
    token: string | null,
    params: { status?: string; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    query.set("limit", String(params.limit ?? 200));
    query.set("offset", String(params.offset ?? 0));
    return request<ApplicationOut[]>(`/v1/applications?${query.toString()}`, { token, signal });
  },

  applicationSummary: (token: string | null, signal?: AbortSignal) =>
    request<Record<string, number>>("/v1/applications/summary", { token, signal }),

  getApplication: (token: string | null, id: string, signal?: AbortSignal) =>
    request<ApplicationOut>(`/v1/applications/${encodeURIComponent(id)}`, { token, signal }),

  eligibility: (token: string | null, id: string, signal?: AbortSignal) =>
    request<EligibilityOut>(`/v1/applications/${encodeURIComponent(id)}/eligibility`, {
      token,
      signal,
    }),

  listAudit: (
    token: string | null,
    params: { entityType?: string; entityId?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (params.entityType) query.set("entity_type", params.entityType);
    if (params.entityId) query.set("entity_id", params.entityId);
    query.set("limit", String(params.limit ?? 500));
    return request<AuditEntryOut[]>(`/v1/audit?${query.toString()}`, { token, signal });
  },

  verifyAudit: (token: string | null, signal?: AbortSignal) =>
    request<ChainVerificationOut>("/v1/audit/verify", { token, method: "POST", signal }),

  listConnectors: (token: string | null, signal?: AbortSignal) =>
    request<ConnectorOut[]>("/v1/connectors", { token, signal }),

  // Not yet shipped — these degrade to `not-implemented` and an empty state.
  listRuns: (
    token: string | null,
    params: { status?: string; agentId?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    if (params.agentId) query.set("agent_id", params.agentId);
    query.set("limit", String(params.limit ?? 200));
    return request<RunOut[]>(`/v1/runs?${query.toString()}`, { token, signal });
  },

  getRun: (token: string | null, id: string, signal?: AbortSignal) =>
    request<RunOut>(`/v1/runs/${encodeURIComponent(id)}`, { token, signal }),

  listTasks: (token: string | null, signal?: AbortSignal) =>
    request<TaskOut[]>("/v1/tasks", { token, signal }),

  actOnTask: (
    token: string | null,
    id: string,
    action: "approve" | "reject" | "request_info",
    note: string,
  ) =>
    request<{ id: string; status: string }>(
      `/v1/tasks/${encodeURIComponent(id)}/${action}`,
      { token, method: "POST", body: { note } },
    ),

  usage: (
    token: string | null,
    params: { from?: string; to?: string } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (params.from) query.set("from", params.from);
    if (params.to) query.set("to", params.to);
    const suffix = query.toString();
    return request<UsageRow[]>(`/v1/usage${suffix ? `?${suffix}` : ""}`, { token, signal });
  },

  governor: (token: string | null, signal?: AbortSignal) =>
    request<GovernorStateOut[]>("/v1/usage/governor", { token, signal }),
};

export type Api = typeof api;
