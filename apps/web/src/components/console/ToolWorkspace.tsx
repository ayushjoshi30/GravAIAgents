"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { Chip, ConfirmCard, Skeleton } from "@/components/console/primitives";
import { API_BASE, api, type AgentRunResult, type McpToolOut } from "@/lib/api";
import { formatInr } from "@/lib/format";

/**
 * Run one tool and read what came back.
 *
 * The handoff routed the call through "the existing MCP proxy in `lib/mcp.ts`".
 * No such module exists here, and writing one would have been the wrong answer
 * anyway: the MCP endpoint is a bearer-authenticated JSON-RPC server that a
 * browser cannot address (it cannot attach the header — that is why opening the
 * endpoint in a tab returns 401), while this console already holds a token for
 * the REST API. So an agent tool is executed through `POST /v1/agents/{id}/run`.
 *
 * That is not a substitute, it is the same code path. `gravai_mcp.runner` is a
 * re-export of `gravai_runner`, which is what the REST route calls, and the
 * tool's `input_schema` is generated from the very `inputs_for(agent_id)`
 * declaration the route resolves the body against. Field for field, what you
 * send here is what a connected host sends.
 *
 * System-family tools are a different matter and are not faked: they are in the
 * catalogue, the servers do not serve them yet, and the panel says so.
 */

/* ---------- Reading the schema ---------- */

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: (string | number)[];
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
}

/**
 * How one property is edited. `amount` exists as its own control because the
 * API declares money as `["string", "number"]` and wants the string: a rupee
 * figure large enough to matter loses its last digits to a JSON float, so it
 * travels as text and is parsed as a decimal server-side.
 */
export type Control = "text" | "number" | "amount" | "select" | "switch";

export interface ToolField {
  name: string;
  schema: JsonSchema;
  control: Control;
  /** The word shown beside the name, so the form says what it will send. */
  typeLabel: string;
  required: boolean;
}

function asSchema(value: unknown): JsonSchema {
  return value && typeof value === "object" ? (value as JsonSchema) : {};
}

function controlFor(schema: JsonSchema): { control: Control; typeLabel: string } {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : ["string"];
  if (schema.enum?.length) return { control: "select", typeLabel: "one of" };
  if (types.includes("boolean")) return { control: "switch", typeLabel: "boolean" };
  if (types.includes("string") && (types.includes("number") || types.includes("integer"))) {
    return { control: "amount", typeLabel: "amount" };
  }
  if (types.includes("number") || types.includes("integer")) {
    return { control: "number", typeLabel: types.includes("integer") ? "integer" : "number" };
  }
  return { control: "text", typeLabel: types[0] ?? "string" };
}

/** The editable surface of a tool, in the order the API declared it. */
export function fieldsOf(inputSchema: Record<string, unknown> | undefined): ToolField[] {
  const schema = asSchema(inputSchema);
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, raw]) => {
    const property = asSchema(raw);
    const { control, typeLabel } = controlFor(property);
    return { name, schema: property, control, typeLabel, required: required.has(name) };
  });
}

/* ---------- Whether this tool can be run at all ---------- */

export interface RunGate {
  can: boolean;
  /** Said beside the button and again in the button's tooltip when it is off. */
  reason: string;
}

/**
 * Why the Run button is or is not live.
 *
 * The verdict on scopes comes from `tool.permitted`, which the API computed
 * against the real token, rather than from the claims in the JWT this browser
 * decoded — the two should agree, and when they do not the server is right.
 * The scope names in the sentence come from the diff, because "you are missing
 * a scope" is not a sentence anyone can act on.
 */
export function gateFor(
  tool: McpToolOut,
  { agentId, hasToken, heldScopes }: { agentId: string | null; hasToken: boolean; heldScopes: string[] },
): RunGate {
  if (!hasToken) {
    return { can: false, reason: "No API token. Add one in Settings, then reload this page." };
  }
  if (!tool.permitted) {
    const missing = tool.scopes.filter((scope) => !heldScopes.includes(scope));
    return {
      can: false,
      reason: missing.length
        ? `Your token does not hold ${missing.join(", ")}. A host connecting with it is not offered this tool.`
        : "The API did not permit this tool for your token.",
    };
  }
  if (tool.family !== "agent") {
    return {
      can: false,
      reason:
        "Catalogued, not executable. This tool wraps one platform capability by reading the service layer, and the MCP process has no session for it — so neither server serves it yet, and there is nothing here to call.",
    };
  }
  if (!tool.runnable) {
    return {
      can: false,
      reason:
        "The runner cannot assemble the inputs this agent needs yet, so the endpoint would refuse the call. It is advertised in the catalogue and no more.",
    };
  }
  if (!agentId) {
    return {
      can: false,
      reason:
        "This console could not match the tool to an agent id, which is what the run endpoint is addressed by. The agent list carries that mapping and did not load.",
    };
  }
  return { can: true, reason: "Runs the agent end to end, audited with your identity." };
}

/* ---------- Values ---------- */

type Draft = Record<string, string | boolean>;

/**
 * What actually goes on the wire.
 *
 * Blank fields are dropped rather than sent, and the declared `default` is
 * never pre-filled into the form. That is the opposite of what the handoff did,
 * and the handoff is wrong for this API: most of these fields have a real
 * source — the statement states its own opening balance, the application record
 * holds the terms — and an omitted field means *read it from there*. Pre-filling
 * the hint and posting it back would overwrite the document the run was supposed
 * to read, and the result would look like an answer about your data when it was
 * an answer about the form's placeholder.
 */
/**
 * Trailing whitespace is never meant. A field holding only spaces is blank —
 * anything else and an accidental space bar would be posted as an override of
 * a value that had a perfectly good source.
 */
function normalise(value: string | boolean | undefined): string | boolean | undefined {
  return typeof value === "string" ? value.trim() : value;
}

function payloadOf(fields: ToolField[], draft: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = normalise(draft[field.name]);
    if (value === undefined || value === "") continue;
    if (field.control === "switch") out[field.name] = Boolean(value);
    else if (field.control === "number") out[field.name] = Number(value);
    else out[field.name] = String(value);
  }
  return out;
}

/**
 * Catch what can be caught here. The API validates every one of these again and
 * is the authority; this only spares a round trip and points at the field.
 */
function problemsOf(fields: ToolField[], draft: Draft): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const field of fields) {
    const value = normalise(draft[field.name]);
    const blank = value === undefined || value === "";
    if (field.required && blank) {
      problems[field.name] = "Required";
      continue;
    }
    if (blank || field.control === "switch" || field.control === "select") continue;
    if (field.control === "number" || field.control === "amount") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        problems[field.name] = field.control === "amount" ? "Must be an amount" : "Must be a number";
        continue;
      }
      if (field.control === "amount" && parsed < 0) problems[field.name] = "Cannot be negative";
      const { minimum, maximum } = field.schema;
      if (minimum !== undefined && parsed < minimum) problems[field.name] = `At least ${minimum}`;
      if (maximum !== undefined && parsed > maximum) problems[field.name] = `At most ${maximum}`;
    }
  }
  return problems;
}

/* ---------- The workspace ---------- */

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: AgentRunResult; ms: number }
  | { kind: "failed"; message: string; ms: number };

interface HistoryRow {
  at: string;
  args: Record<string, unknown>;
  draft: Draft;
  ms: number;
  ok: boolean;
}

export function ToolWorkspace({
  tool,
  agentId,
  agentName,
  token,
  heldScopes,
}: {
  tool: McpToolOut;
  /** The agent this tool invokes, where the mapping is known. */
  agentId: string | null;
  agentName?: string;
  token: string | null;
  heldScopes: string[];
}) {
  const fields = useMemo(() => fieldsOf(tool.input_schema), [tool]);
  const gate = useMemo(
    () => gateFor(tool, { agentId, hasToken: Boolean(token), heldScopes }),
    [tool, agentId, token, heldScopes],
  );

  const [draft, setDraft] = useState<Draft>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [state, setState] = useState<RunState>({ kind: "idle" });
  const [raw, setRaw] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [copied, setCopied] = useState(false);

  const set = useCallback((name: string, value: string | boolean) => {
    setDraft((previous) => ({ ...previous, [name]: value }));
    setProblems((previous) => {
      if (!(name in previous)) return previous;
      const next = { ...previous };
      delete next[name];
      return next;
    });
  }, []);

  const execute = useCallback(async () => {
    if (!gate.can || !agentId || !token) return;
    setConfirming(false);
    setState({ kind: "running" });
    const args = payloadOf(fields, draft);
    const startedAt = performance.now();
    const outcome = await api.runAgent(token, agentId, args);
    const ms = Math.round(performance.now() - startedAt);
    setState(
      outcome.ok
        ? { kind: "done", result: outcome.data, ms }
        : { kind: "failed", message: outcome.message, ms },
    );
    setHistory((rows) =>
      [
        {
          at: new Date().toTimeString().slice(0, 8),
          args,
          draft: { ...draft },
          ms,
          ok: outcome.ok,
        },
        ...rows,
      ].slice(0, 12),
    );
  }, [agentId, draft, fields, gate.can, token]);

  const start = useCallback(() => {
    const found = problemsOf(fields, draft);
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    if (tool.destructive) {
      setConfirming(true);
      return;
    }
    void execute();
  }, [draft, execute, fields, tool.destructive]);

  const curl = useMemo(() => {
    // Single-quote escaping matters more than it looks: one apostrophe in a
    // text override and the pasted command ends the shell string early, so the
    // reader gets a mangled request rather than the one shown on screen.
    const body = JSON.stringify({ inputs: payloadOf(fields, draft) }).replaceAll("'", `'\\''`);
    return [
      `curl -X POST "${API_BASE}/v1/agents/${agentId ?? "<agent>"}/run" \\`,
      '  -H "Authorization: Bearer <token>" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '${body}'`,
    ].join("\n");
  }, [agentId, draft, fields]);

  const running = state.kind === "running";

  return (
    <section aria-label={`${tool.name} workspace`} className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 font-mono text-[clamp(17px,2.4vw,22px)] font-medium break-all">{tool.name}</h2>
        <Chip tone={tool.family === "agent" ? "navy" : "slate"}>{tool.family}</Chip>
        {tool.read_only ? <Chip tone="green">read only</Chip> : <Chip tone="amber">acts</Chip>}
        {tool.destructive ? <Chip tone="red">cannot be undone</Chip> : null}
        {tool.long_running ? <Chip tone="teal">long running</Chip> : null}
        {tool.scopes.map((scope) => (
          <Chip key={scope} tone="outline" mono>
            {scope}
          </Chip>
        ))}
      </div>

      <p className="mt-2 mb-0 max-w-[720px] text-[14px] leading-relaxed text-ink-2">{tool.description}</p>
      {agentName ? (
        <p className="mt-1 mb-0 text-[12.5px] text-ink-3">
          Runs the <span className="text-ink-2">{agentName}</span> —{" "}
          <span className="gv-id text-ink-3">{agentId}</span>
        </p>
      ) : null}

      {!gate.can ? (
        <div className="mt-3.5 rounded-md border border-warn bg-amber-tint px-3.5 py-3 text-[13px] leading-relaxed text-amber-ink">
          {gate.reason}
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
        <div className="gv-panel p-5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="m-0 text-[15px] font-semibold">Arguments</h3>
            <span className="text-xs text-ink-3">generated from input_schema</span>
          </div>

          <div className="mt-3.5 grid gap-3.5">
            {fields.length === 0 ? (
              <p className="m-0 text-[13px] leading-relaxed text-ink-3">
                This tool takes no arguments.
              </p>
            ) : null}

            {fields.map((field) => (
              <FieldControl
                key={field.name}
                field={field}
                value={draft[field.name]}
                problem={problems[field.name]}
                disabled={!gate.can || running}
                onChange={(value) => set(field.name, value)}
              />
            ))}
          </div>

          {fields.length > 0 ? (
            <p className="mt-3.5 mb-0 text-xs leading-relaxed text-ink-3">
              Every field is an override. Leave one blank and the run reads that value from its
              real source rather than from a constant; each field says where that source is.
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span title={gate.can ? undefined : gate.reason}>
              <button
                type="button"
                onClick={start}
                disabled={!gate.can || running}
                className="gv-btn gv-btn-primary"
              >
                {running ? "Running…" : tool.destructive ? "Run (confirms first)" : "Run"}
              </button>
            </span>

            {gate.can ? (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(curl).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1600);
                    },
                    () => undefined,
                  );
                }}
                className="gv-btn text-[13px]"
              >
                {copied ? "Copied" : "Copy as curl"}
              </button>
            ) : null}

            <span className="text-xs text-ink-3">
              {gate.can
                ? tool.read_only
                  ? "Read only. The run is still recorded."
                  : "Writes are audited with your identity."
                : "Not executable"}
            </span>
          </div>

          {gate.can && tool.long_running ? (
            <p className="mt-2 mb-0 text-xs leading-relaxed text-ink-3">
              This runs the agent end to end and can take a minute or two — several agents read
              documents before they decide anything.
            </p>
          ) : null}
        </div>

        <div className="gv-panel min-h-[220px] p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="m-0 text-[15px] font-semibold">Response</h3>
            {state.kind === "done" || state.kind === "failed" ? (
              <div className="flex items-center gap-2.5 text-xs text-ink-3">
                <span className="font-mono" data-numeric="">
                  {state.ms} ms
                </span>
                {state.kind === "done" ? (
                  <button
                    type="button"
                    onClick={() => setRaw((value) => !value)}
                    aria-pressed={raw}
                    className={`gv-chip h-[26px] cursor-pointer border ${
                      raw ? "border-navy bg-navy-tint text-navy-ink" : "border-line bg-white text-ink-2"
                    }`}
                  >
                    Raw JSON
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          {state.kind === "idle" ? (
            <p className="mt-10 mb-0 text-center text-[13px] leading-relaxed text-ink-3">
              {gate.can
                ? "Fill what you want to override and run. The response is read out in words first; raw JSON is one toggle away."
                : "Nothing to run here. The panel above says why."}
            </p>
          ) : null}

          {running ? (
            <div aria-busy="true" className="mt-4 grid gap-2.5">
              <div className="flex items-center gap-2 text-[13px] text-teal-ink">
                <span className="gv-dot gv-dot-live" aria-hidden="true" />
                Running {tool.name}
              </div>
              <Skeleton w="60%" />
              <Skeleton w="80%" />
              <Skeleton w="45%" />
            </div>
          ) : null}

          {state.kind === "failed" ? (
            <div className="mt-3.5 rounded-r-md border-l-2 border-red bg-red-tint px-3.5 py-3 text-[13px] leading-relaxed text-red-ink">
              {state.message}
            </div>
          ) : null}

          {state.kind === "done" && !raw ? <RunReadout result={state.result} /> : null}

          {state.kind === "done" && raw ? (
            <pre className="gv-scroll-x mt-3.5 overflow-auto rounded-md border border-line-2 bg-surface-3 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
              {JSON.stringify(
                { tool: tool.name, agent_id: agentId, arguments: payloadOf(fields, draft), result: state.result },
                null,
                2,
              )}
            </pre>
          ) : null}
        </div>
      </div>

      <div className="gv-panel mt-4 overflow-hidden">
        <div className="flex items-baseline justify-between gap-2 border-b border-line-2 px-5 py-3.5">
          <h3 className="m-0 text-[15px] font-semibold">History</h3>
          <span className="text-xs text-ink-3">this tool, this session · a row restores its arguments</span>
        </div>
        {history.length === 0 ? (
          <p className="m-0 px-5 py-6 text-center text-[13px] text-ink-3">No calls yet.</p>
        ) : (
          history.map((row, index) => (
            <button
              key={`${row.at}-${index}`}
              type="button"
              onClick={() => setDraft(row.draft)}
              className="gv-row grid w-full cursor-pointer grid-cols-[64px_minmax(0,1fr)_64px_74px] items-center gap-3 border-0 border-t border-line-2 bg-white px-5 text-left text-xs"
            >
              <span className="font-mono text-ink-3">{row.at}</span>
              <span className="truncate text-ink-2">
                {Object.entries(row.args)
                  .map(([key, value]) => `${key}=${String(value)}`)
                  .join(" · ") || "no overrides"}
              </span>
              <span className="text-right font-mono" data-numeric="">
                {row.ms} ms
              </span>
              <span className="flex items-center justify-end gap-1.5">
                <span
                  className={`gv-dot ${row.ok ? "bg-ok" : "bg-bad"}`}
                  style={{ width: 7, height: 7 }}
                  aria-hidden="true"
                />
                {row.ok ? "ok" : "error"}
              </span>
            </button>
          ))
        )}
      </div>

      {confirming ? (
        <ConfirmCard
          spec={{
            title: `Run ${tool.name}?`,
            sub: "This tool acts outside the platform and cannot be undone.",
            cta: "Run it",
            danger: true,
            rows: [
              {
                k: "Overrides",
                v:
                  Object.entries(payloadOf(fields, draft))
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(" · ") || "none — every value is read from its source",
                mono: true,
              },
              { k: "Agent", v: agentName ?? agentId ?? tool.name },
              { k: "Recorded", v: "In the audit chain, against your identity" },
            ],
          }}
          onBack={() => setConfirming(false)}
          onConfirm={() => void execute()}
          busy={running}
        />
      ) : null}
    </section>
  );
}

/* ---------- One generated control ---------- */

function FieldControl({
  field,
  value,
  problem,
  disabled,
  onChange,
}: {
  field: ToolField;
  value: string | boolean | undefined;
  problem?: string;
  disabled: boolean;
  onChange: (value: string | boolean) => void;
}) {
  // `useId` rather than the field name: two fields called `limit` on the same
  // screen would otherwise share an id, and a label would point at the wrong box.
  const uid = useId();
  const id = `${uid}-input`;
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  const described =
    [field.schema.description ? hintId : null, problem ? errorId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div>
      <label htmlFor={id} className="flex items-baseline gap-1.5 text-[13px] font-medium">
        <span className="font-mono">{field.name}</span>
        {field.required ? (
          <span className="text-red" aria-hidden="true">
            *
          </span>
        ) : null}
        <span className="text-xs font-normal text-ink-3">{field.typeLabel}</span>
      </label>

      {field.schema.description ? (
        <p id={hintId} className="mt-0.5 mb-0 text-xs leading-relaxed text-ink-3">
          {field.schema.description}
        </p>
      ) : null}

      {field.control === "select" ? (
        <select
          id={id}
          value={String(value ?? "")}
          disabled={disabled}
          aria-invalid={problem ? true : undefined}
          aria-describedby={described}
          onChange={(event) => onChange(event.target.value)}
          className="gv-input mt-1.5 text-[13px] disabled:bg-surface-3 disabled:text-ink-4"
          style={problem ? { borderColor: "var(--color-red)" } : undefined}
        >
          <option value="">Leave to the source</option>
          {(field.schema.enum ?? []).map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      ) : field.control === "switch" ? (
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={Boolean(value)}
          aria-describedby={described}
          disabled={disabled}
          onClick={() => onChange(!value)}
          className="mt-1.5 flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-[13px] disabled:cursor-not-allowed"
        >
          <span
            aria-hidden="true"
            className={`relative inline-block h-5 w-9 rounded-full transition-colors ${
              value ? "bg-navy" : "bg-line-strong"
            }`}
          >
            <span
              className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
              style={{ left: value ? 18 : 2 }}
            />
          </span>
          {value ? "true" : "false"}
        </button>
      ) : (
        <input
          id={id}
          value={String(value ?? "")}
          disabled={disabled}
          // Numbers are held as text while they are being typed. `type="number"`
          // hands back an empty string for "1." and for "-", so a half-typed
          // figure silently becomes "read it from the source" instead.
          inputMode={field.control === "text" ? undefined : "decimal"}
          placeholder={field.control === "amount" ? "₹ — digits only" : ""}
          aria-invalid={problem ? true : undefined}
          aria-describedby={described}
          onChange={(event) => onChange(event.target.value)}
          className="gv-input mt-1.5 font-mono text-[13px] disabled:bg-surface-3 disabled:text-ink-4"
          style={problem ? { borderColor: "var(--color-red)" } : undefined}
        />
      )}

      {problem ? (
        <p id={errorId} className="mt-1 mb-0 text-xs text-red-ink">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/* ---------- Reading a run out in words ---------- */

/**
 * An escalation is the agent handing the decision to a person, which is the
 * design working. It is reported here as the outcome it is, in amber rather
 * than red, because a queue of runs marked "failed" that all succeeded teaches
 * people to ignore the colour.
 */
function RunReadout({ result }: { result: AgentRunResult }) {
  const output = Object.entries(result.output ?? {});
  const overrides = Object.entries(result.overrides_applied ?? {});

  return (
    <div className="mt-3.5 grid gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        {result.escalated ? (
          <Chip tone="amber">escalated to a person</Chip>
        ) : (
          <Chip tone="green">completed</Chip>
        )}
        {result.sandbox ? <Chip tone="teal">sandbox</Chip> : null}
        {result.guardrails_passed ? null : <Chip tone="red">guardrail stopped it</Chip>}
      </div>

      {result.escalation_reason ? (
        <p className="m-0 text-[13px] leading-relaxed text-ink-2">{result.escalation_reason}</p>
      ) : null}

      {result.sandbox ? (
        <p className="m-0 text-xs leading-relaxed text-ink-3">
          This ran against sandbox fixtures. The figures are shaped like the real thing and must
          never underwrite a real decision.
        </p>
      ) : null}

      {result.guardrail_violations.length > 0 ? (
        <ul className="m-0 grid list-none gap-1 rounded-r-md border-l-2 border-red bg-red-tint p-3 pl-3.5 text-[13px] leading-relaxed text-red-ink">
          {result.guardrail_violations.map((violation) => (
            <li key={violation}>{violation}</li>
          ))}
        </ul>
      ) : null}

      <dl className="m-0 grid grid-cols-[minmax(84px,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px] leading-relaxed">
        <dt className="font-mono text-ink-3">run</dt>
        <dd className="gv-id m-0 [overflow-wrap:anywhere]">{result.run_id}</dd>
        <dt className="font-mono text-ink-3">cost</dt>
        <dd className="m-0" data-numeric="">
          {formatInr(result.cost_inr)}
        </dd>
        <dt className="font-mono text-ink-3">steps</dt>
        <dd className="m-0">{result.steps.map((step) => step.name).join(" → ") || "—"}</dd>
      </dl>

      {result.reasoning_summary ? (
        <p className="m-0 text-[13px] leading-relaxed text-ink-2">{result.reasoning_summary}</p>
      ) : null}

      <div>
        <p className="gv-eyebrow m-0">Output</p>
        {output.length === 0 ? (
          <p className="mt-1.5 mb-0 text-[13px] text-ink-3">
            The run returned no output fields.
          </p>
        ) : (
          <dl className="mt-1.5 mb-0 grid grid-cols-[minmax(84px,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px] leading-relaxed">
            {output.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="font-mono text-ink-3 [overflow-wrap:anywhere]">{key}</dt>
                <dd className="m-0 [overflow-wrap:anywhere]">
                  {typeof value === "string" || typeof value === "number" || typeof value === "boolean"
                    ? String(value)
                    : JSON.stringify(value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <p className="m-0 text-xs leading-relaxed text-ink-3">
        {overrides.length === 0
          ? "Nothing was overridden — every value was read from its source."
          : `You overrode ${overrides.map(([key]) => key).join(", ")}. Everything else was read from its source.`}
        {result.source
          ? ` The source supplied ${result.source.documents} document(s) and ${result.source.transactions} transaction(s).`
          : ""}
      </p>
    </div>
  );
}
