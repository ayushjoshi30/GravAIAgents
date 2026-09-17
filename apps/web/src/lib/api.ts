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
 * Landing alongside this console change, so it may 404 against an older API
 * build — which this client reports as `not-implemented` like any other:
 *   POST /v1/documents
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
  /**
   * Read the response before its body is turned into a result.
   *
   * Some answers are not in the body. `GET /v1/studio/workflows` returns the
   * plain array its existing callers already read and puts the size of the
   * whole matching set in `X-Total-Count`, so that adding a count did not have
   * to move the rows. `ApiResult` carries no headers, so a caller that needs
   * one is handed the response rather than given a second fetch helper with its
   * own subtly different failure handling.
   *
   * A header is only readable from a browser cross-origin when the API names it
   * in `Access-Control-Expose-Headers`. `headers.get` answers null when it does
   * not, and null there means "this browser was not allowed to see it" — which
   * is not the same as zero and must never be reported as one.
   */
  onResponse?: (response: Response) => void;
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
    onResponse,
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

  // Before the status is judged and before the body is read, because a caller
  // that needs a header needs it on a 204 and on a failure too.
  onResponse?.(response);

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

/**
 * A run, as the API actually sends it.
 *
 * THREE FIELDS WERE DECLARED HERE THAT THE API DOES NOT SEND: `tenant`, `band`
 * and `duration_ms`. `RunOut` in routers/runs.py has id, agent_id,
 * application_id, status, escalated, escalation_reason, cost_inr, api_calls,
 * started_at and finished_at — and nothing else.
 *
 * Declaring them as present was not a harmless inaccuracy. TypeScript believed
 * it, so `run.tenant.toLowerCase()` in the runs filter and
 * `a.tenant.localeCompare(b.tenant)` in its sort both compiled clean and both
 * threw the moment a real row reached them — the filter on the first keystroke
 * of a search, which is why it looked like "an error as I type". A type that
 * overstates what arrives converts a missing field from a visible gap into a
 * runtime crash somewhere else entirely.
 *
 * They are optional now, so the compiler points at every place that has to
 * cope. `duration_ms` in particular is derivable — `finished_at - started_at` —
 * which is better than a field nobody sends.
 */
export interface RunOut {
  id: string;
  agent_id: string;
  application_id: string | null;
  status: RunStatus;
  cost_inr: number;
  escalated: boolean;
  escalation_reason?: string | null;
  api_calls?: number;
  started_at: string;
  finished_at?: string | null;
  /** Not sent by /v1/runs today. Present on some richer payloads. */
  tenant?: string;
  /** Not sent by /v1/runs today; a risk band lives in the run's output. */
  band?: string | null;
  /** Not sent by /v1/runs. Prefer `runDuration()`, which derives it. */
  duration_ms?: number;
  steps?: RunStepOut[];
}

/**
 * How long a run took, in milliseconds, or null when it cannot be known.
 *
 * Derived from the two timestamps the API does send rather than read from a
 * `duration_ms` it does not. Null for a run still in flight — which is a real
 * state and must not be rendered as a duration of zero.
 */
export function runDuration(run: RunOut): number | null {
  if (typeof run.duration_ms === "number") return run.duration_ms;
  if (!run.finished_at) return null;
  const started = Date.parse(run.started_at);
  const finished = Date.parse(run.finished_at);
  if (Number.isNaN(started) || Number.isNaN(finished)) return null;
  return Math.max(0, finished - started);
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

// --- Document upload ------------------------------------------------------

/**
 * What POST /v1/documents returns on 201, and nothing else.
 *
 * `uri` is a blob reference the platform resolves itself. DocumentRef's own
 * docstring in the Sarvam layer is explicit that it "is never sent to the
 * provider", so nothing in this console may treat it as a URL: it is not
 * fetched here, not put in an <a href>, and not offered as a data-source URL,
 * because the source fetcher takes public HTTP endpoints and a blob reference
 * is not one.
 */
export interface DocumentUploadOut {
  document_id: string;
  uri: string;
  mime_type: string;
  filename: string;
  bytes: number;
  pages: number | null;
  scanned_by: string;
}

/**
 * The documented failures of the upload endpoint, kept apart from `FailureKind`.
 *
 * `request()` collapses every 4xx it does not recognise into `bad-response`,
 * which is right for a JSON GET and wrong here: 413, 415, 422 and 503 each mean
 * something specific to a person holding a file, and 503 in particular has to
 * say that the scanner was unreachable and nothing was stored. Flattening those
 * four into one grey "the API returned an error" would lose the only
 * information the person needs to know what to do next.
 */
export type UploadFailureKind =
  | FailureKind
  | "empty-part"
  | "too-large"
  | "unsupported-type"
  | "scan-flagged"
  | "no-scanner"
  | "no-answer"
  | "cancelled";

export interface UploadFailure {
  ok: false;
  kind: UploadFailureKind;
  status?: number;
  message: string;
  /**
   * Who wrote `message`.
   *
   * The console quotes the API's own sentence back to the person under the
   * words "The API said:", and that attribution has to be true. A timeout
   * sentence written here, printed under that heading, would put words into
   * the mouth of a server that may never have received the request at all —
   * which is the same class of mistake as reporting a scan finding that no
   * scanner produced.
   */
  messageSource: "api" | "console";
  correlationId?: string;
}

export type UploadResult = ApiSuccess<DocumentUploadOut> | UploadFailure;

/**
 * The headline for each failure, written so that every one of them states what
 * happened to the file.
 *
 * Each sentence that can be read as "we have your file" is wrong unless the API
 * answered 201, so every failure here states the file's fate outright — either
 * that nothing was stored, or, in the handful of cases where the answer is
 * genuinely not knowable from a browser, that it is not knowable. The
 * scanner findings are phrased flatly on purpose: a person uploading a salary
 * slip that trips a scanner has almost certainly not done anything wrong, and
 * alarming copy would be both unkind and unearned — the console knows only that
 * the scanner objected, not that the file is malicious.
 */
export const UPLOAD_FAILURE_COPY: Record<UploadFailureKind, string> = {
  /*
   * The seven generic kinds are rewritten here rather than inherited from
   * `FAILURE_COPY`. Those sentences were written for a GET that fetched
   * nothing, so none of them says anything about a file — and a person who has
   * just handed one over is asking exactly one question. "The API returned an
   * error" leaves them to assume, and the assumption people make is that the
   * file went somewhere.
   *
   * Where this console genuinely cannot know — a 500, a body it could not
   * read, a request that went out in full and was never answered — it says so
   * in those words. Guessing "nothing was stored" there would be the same
   * fabrication as guessing the opposite; the difference is only which way it
   * happens to be wrong.
   */
  "no-token": "No API token is set, so nothing was sent and nothing was stored. Add one in Settings.",
  unauthenticated: "The API rejected this token, so the upload was refused and nothing was stored.",
  forbidden:
    "This token does not carry the documents:write scope, so the upload was refused and nothing was stored.",
  "not-implemented":
    "The API build this console is pointed at has no upload endpoint, so there was nowhere to put the file and nothing was stored.",
  unreachable:
    "The connection to the API failed before the file had finished sending, so nothing was stored.",
  server:
    "The API failed while handling this upload. A 500 does not say whether the file was stored, and this console will not guess — check before uploading it again.",
  "bad-response":
    "The API answered in a way this console could not read, so it cannot say whether the file was stored.",
  "no-answer":
    "The file finished sending, but the API never answered. Whether it was stored is unknown from here — check before uploading it again.",
  "empty-part": "That file came through with no content, so nothing was stored.",
  "too-large": "That file is larger than the limit this deployment accepts. Nothing was stored.",
  "unsupported-type": "This deployment does not accept that kind of file. Nothing was stored.",
  "scan-flagged": "The scanner flagged something in this file, so it was not stored.",
  "no-scanner":
    "No virus scanner was reachable, so the file was not stored. Uploads stay closed until a scanner is configured — a file that cannot be scanned is never accepted.",
  cancelled: "Upload cancelled before it finished sending. Nothing was stored.",
};

/** Which half of the request is in flight. The scan is the slow half. */
export type UploadPhase = "uploading" | "scanning";

export interface UploadProgress {
  phase: UploadPhase;
  /** Bytes the browser has confirmed it sent, or null when it will not say. */
  sent: number | null;
  /** Total bytes of the request body, or null when the browser will not say. */
  total: number | null;
}

/**
 * Upload one file to POST /v1/documents.
 *
 * WHY THIS IS XMLHttpRequest AND NOT `request()`. Two reasons, both about
 * telling the truth. `request()` JSON-encodes its body and sets a JSON
 * content type, which a multipart part cannot survive. And `fetch` will not
 * report how much of a request body has gone out, so a fetch-based upload
 * could only ever show a spinner — whereas `xhr.upload.onprogress` reports
 * real bytes sent, and `xhr.upload.onload` fires at the exact moment the body
 * is fully sent, which is the moment the wait stops being the network and
 * starts being the scanner. That transition is the one thing worth showing a
 * person here, and it is only observable this way.
 *
 * The timeout is generous because the scan is a real piece of work happening
 * between the last byte sent and the first byte of the response, and a console
 * that gives up at twelve seconds would report a healthy deployment as
 * unreachable.
 */
export function uploadDocument(
  token: string | null,
  file: File,
  options: {
    applicationId?: string | null;
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<UploadResult> {
  const { applicationId, onProgress, signal, timeoutMs = 120_000 } = options;

  if (!token) {
    return Promise.resolve({
      ok: false,
      kind: "no-token",
      message: UPLOAD_FAILURE_COPY["no-token"],
      messageSource: "console",
    });
  }

  const form = new FormData();
  // The part name is "file" and the field name is "application_id" because the
  // endpoint contract says so; both agents build against that spelling.
  form.append("file", file, file.name);
  const application = (applicationId ?? "").trim();
  if (application) form.append("application_id", application);

  return new Promise<UploadResult>((resolve) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    /**
     * Whether the whole body went out before the connection failed.
     *
     * This is the only thing that separates "the upload never got there" from
     * "the server may well have it and never said so", and the two deserve
     * opposite sentences. Without it every dropped connection would have to
     * claim one or the other for both cases, and half the time it would be
     * telling someone their file is gone when the platform is holding it.
     */
    let bodyFullySent = false;

    function finish(result: UploadResult): void {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    if (signal) {
      if (signal.aborted) {
        finish({
          ok: false,
          kind: "cancelled",
          message: UPLOAD_FAILURE_COPY.cancelled,
          messageSource: "console",
        });
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.open("POST", `${API_BASE}/v1/documents`, true);
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    // Content-Type is deliberately not set: the browser has to write it itself
    // so that the multipart boundary it generated is the one it declares.

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        onProgress({
          phase: "uploading",
          // `lengthComputable` false means the browser is not telling us the
          // total. Reporting null lets the caller show an indeterminate
          // indicator rather than compute a percentage out of a guess.
          sent: event.lengthComputable ? event.loaded : null,
          total: event.lengthComputable ? event.total : null,
        });
      };
    }

    // Recorded whether or not anyone asked for progress, because what this
    // fact decides — which sentence a dropped connection gets — is owed to
    // every caller, not only to one that wanted a bar.
    xhr.upload.onload = () => {
      // The body is fully sent. Everything from here is the server reading,
      // scanning and storing, and there is no honest number for that.
      bodyFullySent = true;
      onProgress?.({ phase: "scanning", sent: null, total: null });
    };

    xhr.onabort = () =>
      finish({
        ok: false,
        kind: "cancelled",
        message: UPLOAD_FAILURE_COPY.cancelled,
        messageSource: "console",
      });

    xhr.ontimeout = () =>
      finish({
        ok: false,
        kind: bodyFullySent ? "no-answer" : "unreachable",
        message: bodyFullySent
          ? "The file finished sending, but the API did not answer within the upload timeout. Whether it was stored is unknown from here — check before uploading it again."
          : "The upload timed out before the file had finished sending, so nothing was stored.",
        // Written here, not by the server: the server said nothing at all.
        messageSource: "console",
      });

    xhr.onerror = () => {
      const kind: UploadFailureKind = bodyFullySent ? "no-answer" : "unreachable";
      finish({ ok: false, kind, message: UPLOAD_FAILURE_COPY[kind], messageSource: "console" });
    };

    xhr.onload = () => {
      const rawText = xhr.responseText ?? "";
      let parsed: unknown = undefined;
      if (rawText) {
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = undefined;
        }
      }

      const problem = (parsed ?? {}) as ProblemDetail;
      const correlationId =
        xhr.getResponseHeader("X-Correlation-Id") ?? problem.correlation_id ?? undefined;
      // `readableDetail` falls back to "<status> <statusText>" when a body
      // carried no words of its own, which is a fine last resort for a generic
      // call and useless here — the caller would attribute "503" to the API as
      // though it were an explanation. Quote the API only when it wrote a
      // sentence; otherwise the copy below, which actually says what became of
      // the file, stands alone.
      const wroteSomething =
        (typeof problem.detail === "string" && problem.detail.trim().length > 0) ||
        Array.isArray(problem.detail) ||
        (typeof problem.title === "string" && problem.title.trim().length > 0);
      const said = wroteSomething ? readableDetail(problem, xhr.status, xhr.statusText) : "";

      // 201 AND NOTHING ELSE IS "STORED". The contract names exactly one
      // success status, so any other 2xx is a deployment this console does not
      // understand, and calling it stored would be a guess about a file's
      // safety. A 201 whose body is missing the id is the same guess, because
      // an id is what makes a stored document referable at all.
      if (xhr.status === 201) {
        const document = parsed as DocumentUploadOut | null;
        if (
          !document ||
          typeof document.document_id !== "string" ||
          document.document_id.length === 0
        ) {
          finish({
            ok: false,
            kind: "bad-response",
            status: xhr.status,
            message:
              "The API answered 201 but without a document id, so this console cannot say the file was stored.",
            messageSource: "console",
            correlationId: correlationId ?? undefined,
          });
          return;
        }
        finish({ ok: true, data: document });
        return;
      }

      let kind: UploadFailureKind;
      switch (xhr.status) {
        case 400:
          kind = "empty-part";
          break;
        case 401:
          kind = "unauthenticated";
          break;
        case 403:
          kind = "forbidden";
          break;
        case 404:
        case 405:
          kind = "not-implemented";
          break;
        case 413:
          kind = "too-large";
          break;
        case 415:
          kind = "unsupported-type";
          break;
        case 422:
          // A 422 means the scanner found something — EXCEPT that FastAPI
          // spends the same status on request validation, and answers it with
          // a LIST of {loc, msg, type} rather than a problem document. Telling
          // someone that a scanner objected to their payslip when in fact the
          // form was malformed would be a false accusation dressed as a
          // security finding, so the body's shape decides which 422 this is.
          kind = Array.isArray(problem.detail) ? "bad-response" : "scan-flagged";
          break;
        case 503:
          // The fail-closed answer. A 503 from a proxy in front of the API
          // would land here too, but both readings agree on the part that
          // matters and that the copy leads with: nothing was stored.
          kind = "no-scanner";
          break;
        default:
          kind = xhr.status >= 500 ? "server" : "bad-response";
      }

      finish({
        ok: false,
        kind,
        status: xhr.status,
        // The server's own words are carried when it wrote any, because 413
        // names the limit and 422 names the finding, and the canned copy names
        // neither. They are marked as the server's so the console can quote
        // them as a quotation and keep its own sentence — the one that says
        // what became of the file — in front of them.
        message: said || UPLOAD_FAILURE_COPY[kind],
        messageSource: said ? "api" : "console",
        correlationId: correlationId ?? undefined,
      });
    };

    xhr.send(form);
  });
}

// --- Agent Studio workflows, as "Your agents" reads them -------------------

/**
 * These shapes mirror `routers/studio.py` and belong here rather than in
 * `lib/studio.ts` because the list page is the only caller of the endpoints
 * below, and because the card is the payload the page, the card component and
 * the create dialog all have to agree about. One declaration, imported by
 * three files, is what stops those three from drifting.
 */

/** One node in a card's small picture of the graph. */
export interface WorkflowThumbnailNode {
  id: string;
  /**
   * The node type, which is a key into `NODE_BY_TYPE` in `lib/nodeCatalog.ts`.
   * That lookup carries the node's hue, and it is deliberately the same lookup
   * the minimap and the canvas use: a node has to be the same colour on a card
   * as it is on the canvas, or the picture is of a different graph.
   */
  type: string;
  /**
   * Where the canvas put it, or null.
   *
   * Nullable because the API declares it so. A workflow that was never opened
   * on the canvas — one built from a template, or posted straight to the API —
   * can carry nodes with no coordinates, and a thumbnail that invented
   * coordinates for those would draw a shape the workflow does not have.
   */
  x: number | null;
  y: number | null;
}

/** One connection, as the pair of node ids it joins. */
export interface WorkflowThumbnailEdge {
  source: string;
  target: string;
}

/**
 * Enough of a graph to draw its shape, and nothing that could carry a secret.
 *
 * Node config never travels in this payload: it is where prompts, mappings and
 * credential names live, and a page of thirty cards would otherwise ship thirty
 * whole definitions in order to draw thirty small pictures.
 */
export interface WorkflowThumbnail {
  nodes: WorkflowThumbnailNode[];
  edges: WorkflowThumbnailEdge[];
  /**
   * True when the graph holds more nodes than the thumbnail carries.
   *
   * The counts beside the picture are always the true ones, so a card whose
   * drawing is partial has to say so — otherwise a forty-node agent that the
   * thumbnail clipped to sixty reads as a small, simple one.
   */
  truncated: boolean;
}

/** One workflow without its graph. */
export interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  node_count: number;
  created_at: string;
  updated_at: string;
}

/** One workflow as a card on "Your agents" draws it. */
export interface WorkflowCard extends WorkflowRow {
  edge_count: number;
  thumbnail: WorkflowThumbnail;
}

/**
 * One page of the list, and how many rows the query matched in total.
 *
 * `total` is the size of the whole matching set, never the length of `items`:
 * a page that counted its own cards would tell someone with sixty agents that
 * they have twenty-four.
 *
 * It is NULLABLE, and the null is the honest part. The endpoint returns a bare
 * JSON array and carries the count in the `X-Total-Count` header, deliberately,
 * so that adding a count did not move the rows out from under the studio's own
 * list. A response header is invisible to a cross-origin browser unless the API
 * lists it in `Access-Control-Expose-Headers`, which this one does not yet — so
 * with the console on :3100 and the API on :8000 the count is, from here,
 * genuinely unknown. Unknown is a different fact from zero and from
 * `items.length`, and it is the caller's job to say so rather than to pick
 * whichever number is to hand.
 */
export interface WorkflowPage {
  items: WorkflowCard[];
  total: number | null;
}

/** What creating a workflow answers with: the new workflow, graph included. */
export interface WorkflowCreated extends WorkflowRow {
  definition: Record<string, unknown>;
  deployed_version?: string | null;
}

/** The orderings the list endpoint accepts. Sorting happens server-side. */
export type WorkflowSort = "last_edited" | "name" | "created";

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

  /**
   * Execute one agent. The only call in this client that does work rather than
   * reading it, so it is deliberately slow: several agents read documents
   * first, and the credit pipeline reads eight of them.
   *
   * `documentIds` are ids from `POST /v1/documents`. They travel as
   * `document_ids` beside `inputs` and `source` because the platform resolves
   * each one itself — against the CALLER'S tenant, which is the whole point of
   * the field — and hands what it finds to the runner in the same place the
   * data-source connector puts documents. That is why an uploaded document
   * shows up in the run's `source` report rather than in a result field of its
   * own, and why a run given both a source URL and uploaded ids comes back with
   * one document count covering both: nothing downstream can tell them apart,
   * so nothing upstream should claim to.
   *
   * An id that is not the caller's answers 404 exactly as an id that never
   * existed does, so there is nothing here for a caller to learn by guessing.
   *
   * The key is omitted when nothing is attached rather than sent as an empty
   * list, so a run that carries no documents posts the body older API builds
   * already accept.
   */
  runAgent: (
    token: string | null,
    id: string,
    inputs: Record<string, unknown> = {},
    source: { url: string; headers?: Record<string, string> } | null = null,
    documentIds: string[] = [],
    signal?: AbortSignal,
  ) => {
    const body: Record<string, unknown> = { inputs };
    if (source) body.source = source;
    if (documentIds.length > 0) body.document_ids = documentIds;
    return request<AgentRunResult>(`/v1/agents/${encodeURIComponent(id)}/run`, {
      token,
      method: "POST",
      body,
      timeoutMs: 180_000,
      signal,
    });
  },

  mcpSurface: (token: string | null, signal?: AbortSignal) =>
    request<McpSurfaceOut>("/v1/mcp/tools", { token, signal }),

  /**
   * The one call in this client that does not go through `request()`, because
   * a multipart body and a real byte count are both outside what it can do.
   * See `uploadDocument` above for why.
   */
  uploadDocument,

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

  // --- "Your agents": the workflows this caller has built -------------------
  //
  // Ownership and the soft-delete marker are enforced by the API, not here. A
  // workflow that is not the caller's answers 404 exactly as one that never
  // existed does, so there is nothing for the console to check and nothing for
  // a caller to learn by guessing an id.

  /**
   * One page of the caller's workflows.
   *
   * `q` and `sort` go to the server rather than being applied to the loaded
   * page, because the list is paginated: a filter written in the browser would
   * search the twenty-four rows that happen to be loaded and then present that
   * as the answer, which is wrong in the one case — a long list — where search
   * is the reason someone reached for it.
   *
   * THE SHAPE ON THE WIRE IS AN ARRAY, NOT AN ENVELOPE. `routers/studio.py`
   * declares `response_model=list[WorkflowCardOut]` and states in its docstring
   * why: the studio's own list already reads that array, and wrapping the rows
   * in `{items, total}` to carry a number would have broken every existing
   * caller of a path that commit promised to keep working. The count travels in
   * `X-Total-Count` instead. This method assembles the envelope the page wants
   * out of the two, which is the one place that translation belongs — and it
   * reports a count it could not read as null rather than inventing one.
   */
  listWorkflows: (
    token: string | null,
    params: { q?: string; sort?: WorkflowSort; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<ApiResult<WorkflowPage>> => {
    const query = new URLSearchParams();
    // An empty or whitespace-only `q` is omitted rather than sent, so that
    // clearing the box asks for the unfiltered list rather than for the rows
    // matching "".
    const q = params.q?.trim();
    if (q) query.set("q", q);
    if (params.sort) query.set("sort", params.sort);
    query.set("limit", String(params.limit ?? 24));
    query.set("offset", String(params.offset ?? 0));

    let total: number | null = null;
    return request<WorkflowCard[]>(`/v1/studio/workflows?${query.toString()}`, {
      token,
      signal,
      onResponse: (response) => {
        const header = response.headers.get("X-Total-Count");
        if (header === null || !header.trim()) return;
        const parsed = Number(header);
        // A header that is not a whole count is not a count. Leaving `total`
        // null makes the page say so; coercing it would put a number nobody
        // sent in front of a reader.
        if (Number.isInteger(parsed) && parsed >= 0) total = parsed;
      },
    }).then((result) => {
      if (!result.ok) return result;
      if (!Array.isArray(result.data)) {
        // An API build old enough — or new enough — to answer with something
        // other than an array is reported as a response this console cannot
        // read. Without this the page reaches for `.items` on an object that
        // has none and takes itself down with a TypeError, which is a blank
        // screen where a failure banner with a status on it belongs.
        return {
          ok: false as const,
          kind: "bad-response" as const,
          message: "The workflow list did not come back as a list of agents.",
        };
      }
      return { ok: true as const, data: { items: result.data, total } };
    });
  },

  /**
   * Start a new agent, blank or from a named starter.
   *
   * `template` is the server's own catalogue key, not a definition assembled
   * here: the console asking for "kyc" and the API deciding what that contains
   * is the only arrangement in which a starter cannot go stale in this file.
   */
  createWorkflow: (
    token: string | null,
    body: { name: string; description?: string; template?: string },
  ) => request<WorkflowCreated>("/v1/studio/workflows", { token, method: "POST", body }),

  /**
   * Rename one workflow, and nothing else.
   *
   * PATCH with only a name, rather than the studio's PUT, because the list page
   * holds no definition to send and a rename that posted one would save
   * whatever the page last happened to know about the graph over whatever the
   * canvas has since written.
   *
   * The server trims the name it is given and refuses one that is already taken
   * in this tenant, so the name it answers with is the name to display — not
   * the string that was typed into the field.
   */
  renameWorkflow: (token: string | null, id: string, name: string) =>
    request<WorkflowRow>(`/v1/studio/workflows/${encodeURIComponent(id)}`, {
      token,
      method: "PATCH",
      body: { name },
    }),

  /**
   * Copy a workflow. Omit the name and the server picks the next free one,
   * which it can do and the console cannot: names are unique per tenant and
   * this page only ever holds one page of them.
   *
   * THIS RETURN TYPE OVERSTATES THE PAYLOAD, KNOWINGLY. The endpoint declares
   * `response_model=WorkflowDetail`, which is the summary plus the definition:
   * there is no `edge_count` and no `thumbnail` in what comes back, so the copy
   * cannot be drawn as a card from this answer alone — re-read the list for
   * that, as `/console/workflows` does. It is still typed `WorkflowCard` here
   * because `AgentCard`'s `onDuplicated` is declared to take one, and narrowing
   * this alone would stop that file compiling while somebody else has it open.
   * Whoever reconciles the two should correct both in one change; until then,
   * do not reach for `.thumbnail` on this result.
   */
  duplicateWorkflow: (token: string | null, id: string, name?: string) =>
    request<WorkflowCard>(`/v1/studio/workflows/${encodeURIComponent(id)}/duplicate`, {
      token,
      method: "POST",
      // Always a body, even when empty, so the request carries the JSON
      // content type the endpoint's model expects.
      body: name ? { name } : {},
    }),

  /** Soft delete: the row keeps its name and its id, and `restoreWorkflow` undoes it. */
  deleteWorkflow: (token: string | null, id: string) =>
    request<void>(`/v1/studio/workflows/${encodeURIComponent(id)}`, { token, method: "DELETE" }),

  /**
   * The undo. Answers with the row as it now stands, so the list can replace it.
   *
   * `WorkflowCreated` rather than `WorkflowCard` because the endpoint returns
   * `WorkflowDetail`: the summary and the definition, with no `edge_count` and
   * no thumbnail. What a restore is good for is the name and the timestamps,
   * and claiming a picture that is not in the payload is how a card ends up
   * drawing an empty graph for a workflow that has nine nodes.
   */
  restoreWorkflow: (token: string | null, id: string) =>
    request<WorkflowCreated>(`/v1/studio/workflows/${encodeURIComponent(id)}/restore`, {
      token,
      method: "POST",
    }),
};

export type Api = typeof api;
