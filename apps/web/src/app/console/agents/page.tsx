"use client";

/**
 * Run an agent.
 *
 * Until this page existed the console could read runs but never start one, and
 * the only executable endpoint was the whole credit pipeline. Every agent here
 * goes through the same runner the MCP server uses, so an agent cannot behave
 * differently depending on which door the request came in by.
 *
 * The form is rendered from `GET /v1/agents/{id}/inputs` rather than written
 * out here. That is deliberate: a field described in this file could drift
 * from the field the runner reads, and a control wired to nothing is worse
 * than no control, because it looks like it worked.
 *
 * Four of the fourteen escalate by design. That is shown as the outcome it is,
 * not as a failure — an escalated run has still done its work and has raised a
 * task for a person.
 */

import { useCallback, useMemo, useState } from "react";
import { ConsolePage } from "@/components/console/ConsoleShell";
import { AgentPipeline } from "@/components/agents/AgentPipeline";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { Badge, Tag, TierBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SelectField, TextArea, TextField } from "@/components/ui/Field";
import { AGENTS, TIERS, type Agent } from "@/lib/agents";
import {
  api,
  type AgentInputField,
  type AgentInputsOut,
  type AgentRunResult,
  type SourceReport,
} from "@/lib/api";
import { formatInr } from "@/lib/format";
import { useToken } from "@/lib/session";

type RunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: AgentRunResult }
  | { status: "error"; message: string };

type SpecState =
  | { status: "loading" }
  | { status: "ready"; spec: AgentInputsOut }
  | { status: "error"; message: string };

/** Form values, held as strings. Blank means "leave it to the source". */
type Draft = Record<string, string>;

type CheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok"; report: SourceReport }
  | { status: "error"; message: string };

const NO_CHECK: CheckState = { status: "idle" };

const IDLE: RunState = { status: "idle" };

/**
 * Agents that read the document set before they can start.
 *
 * All four take the best part of half a minute for that reason, and a bare
 * "working…" next to a button that looks stuck invites a second click. Naming
 * the slow part is the difference between waiting and wondering.
 */
const READS_DOCUMENTS = new Set([
  "doc_intelligence",
  "bank_statement_analytics",
  "credit_appraisal",
  "risk_scoring",
]);

/**
 * Check a value before spending a request on it.
 *
 * The server validates too and is the authority; this only saves a round trip
 * and puts the message next to the field that caused it.
 */
function fieldError(field: AgentInputField, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  if (field.kind === "number" || field.kind === "money") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return `${field.label} must be a number`;
    if (field.kind === "money" && parsed < 0) return `${field.label} cannot be negative`;
    if (field.minimum !== null && parsed < field.minimum) {
      return `Must be at least ${field.minimum}`;
    }
    if (field.maximum !== null && parsed > field.maximum) {
      return `Must be at most ${field.maximum}`;
    }
  }
  return null;
}

/**
 * Build the request body.
 *
 * Amounts stay strings all the way to the server, which parses them as exact
 * decimals. Turning a rupee figure into a JavaScript number on the way out
 * would round it before anyone could see it happen.
 */
function toPayload(fields: AgentInputField[], draft: Draft): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = (draft[field.name] ?? "").trim();
    if (!raw) continue;
    payload[field.name] = field.kind === "number" ? Number(raw) : raw;
  }
  return payload;
}

function InputControl({
  field,
  value,
  onChange,
}: {
  field: AgentInputField;
  value: string;
  onChange: (next: string) => void;
}) {
  // The placeholder is what happens if you type nothing, not a value that
  // will be used. For a sourced field that is "read from the bank statement",
  // and showing the declared number there would promise the opposite.
  const placeholder = field.sourced ? field.blank_means : String(field.default ?? "");
  const error = fieldError(field, value);
  const hint = field.help || undefined;

  if (field.kind === "select") {
    return (
      <SelectField
        label={field.label}
        value={value || placeholder}
        onChange={onChange}
        options={field.choices.map((choice) => ({ value: choice, label: choice }))}
        hint={hint}
      />
    );
  }

  if (field.kind === "textarea") {
    return (
      <TextArea
        label={field.label}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        rows={3}
        hint={hint}
        error={error}
      />
    );
  }

  return (
    <TextField
      label={field.label}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      type={field.kind === "number" ? "number" : "text"}
      mono={field.kind === "money"}
      hint={hint}
      error={error}
    />
  );
}

function OutcomeBadge({ result }: { result: AgentRunResult }) {
  if (!result.guardrails_passed) {
    return (
      <Badge tone="fail" dot>
        guardrails failed
      </Badge>
    );
  }
  if (result.escalated) {
    return (
      <Badge tone="amber" dot>
        escalated
      </Badge>
    );
  }
  return (
    <Badge tone="pass" dot>
      cleared
    </Badge>
  );
}

function SourcePanel({ report }: { report: SourceReport }) {
  const counts = [
    report.transactions ? `${report.transactions} statement lines` : null,
    report.documents ? `${report.documents} documents` : null,
    report.application_fields.length
      ? `${report.application_fields.length} application fields`
      : null,
  ].filter(Boolean);

  return (
    <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">your data</Badge>
        {report.usable_without_extraction ? (
          <Badge tone="pass" dot>
            facts, no extraction needed
          </Badge>
        ) : (
          <Badge tone="amber" dot>
            needs extraction
          </Badge>
        )}
        <span className="ml-auto font-mono text-[11px] text-ink-3" data-numeric="">
          {(report.bytes_fetched / 1024).toFixed(1)} kB
        </span>
      </div>

      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
        Fetched {counts.join(", ") || "nothing usable"} from{" "}
        <code className="font-mono break-all">{report.url}</code>.
      </p>

      {report.notes.length > 0 ? (
        <>
          <p className="gv-eyebrow mt-2.5">How your field names were read</p>
          <ul className="mt-1 space-y-0.5 text-[11.5px] leading-relaxed text-ink-3">
            {report.notes.map((note) => (
              <li key={note}>· {note}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function SourceControls({
  url,
  headerValue,
  onUrl,
  onHeader,
  check,
  onCheck,
}: {
  url: string;
  headerValue: string;
  onUrl: (next: string) => void;
  onHeader: (next: string) => void;
  check: CheckState;
  onCheck: () => void;
}) {
  return (
    <div className="mb-5 rounded-lg border border-line bg-sunken p-4">
      <h4 className="text-[12.5px] font-semibold text-ink">Data source</h4>
      <p className="mt-1 mb-3 text-[12.5px] leading-relaxed text-ink-2">
        A <code className="font-mono">GET</code> endpoint of yours. Return statement lines
        and application fields as JSON and the run uses them directly — no document-AI key
        needed, because everything after extraction is arithmetic. Return{" "}
        <code className="font-mono">content_base64</code> documents instead and reading them
        needs that key configured. Leave this empty to use the connected environment.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="URL"
          value={url}
          onChange={onUrl}
          placeholder="https://your-host/applications/18302/documents"
          mono
          hint="Must be publicly reachable — the server refuses private and loopback addresses."
        />
        <TextField
          label="Authorization header"
          value={headerValue}
          onChange={onHeader}
          placeholder="Bearer …"
          mono
          hint="Optional. Dropped if a redirect leaves your origin."
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={onCheck} disabled={!url.trim() || check.status === "checking"}>
          {check.status === "checking" ? "Checking…" : "Check source"}
        </Button>
        {check.status === "error" ? (
          <span className="text-[12px] text-fail">{check.message}</span>
        ) : null}
      </div>

      {check.status === "ok" ? <SourcePanel report={check.report} /> : null}
    </div>
  );
}

function ResultPanel({ result }: { result: AgentRunResult }) {
  const [showRaw, setShowRaw] = useState(false);
  const [showInputs, setShowInputs] = useState(false);
  const used = Object.entries(result.overrides_applied ?? {});

  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <OutcomeBadge result={result} />
        {result.sandbox ? <Badge tone="neutral">sandbox</Badge> : <Badge tone="brand">live</Badge>}
        <span className="ml-auto font-mono text-[11.5px] text-ink-3" data-numeric="">
          {formatInr(result.cost_inr)}
        </span>
      </div>

      {result.escalated && result.escalation_reason ? (
        <p className="mt-3 rounded-lg border border-amber-border bg-amber-soft p-3 text-[12.5px] leading-relaxed text-amber-strong">
          <strong>Escalated by design.</strong> {result.escalation_reason}. The agent
          completed its analysis and raised a task for a person.
        </p>
      ) : null}

      {result.guardrail_violations.length > 0 ? (
        <ul className="mt-3 rounded-lg border border-fail-border bg-fail-soft p-3 text-[12.5px] text-fail">
          {result.guardrail_violations.map((violation) => (
            <li key={violation}>{violation}</li>
          ))}
        </ul>
      ) : null}

      {result.reasoning_summary ? (
        <p className="mt-3 text-[13px] leading-relaxed text-ink-2">{result.reasoning_summary}</p>
      ) : null}

      {result.steps.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {result.steps.map((step, index) => (
            <Tag key={`${step.name}-${index}`}>
              {step.name} · {step.kind}
            </Tag>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-4">
        {used.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowInputs((value) => !value)}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:text-brand-600"
            aria-expanded={showInputs}
          >
            {showInputs ? "Hide" : "Show"} the {used.length} value
            {used.length === 1 ? "" : "s"} you overrode
            <Icon
              name="chevron"
              size={12}
              className={showInputs ? "-rotate-180 transition-transform" : "transition-transform"}
            />
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => setShowRaw((value) => !value)}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:text-brand-600"
          aria-expanded={showRaw}
        >
          {showRaw ? "Hide" : "Show"} full output
          <Icon
            name="chevron"
            size={12}
            className={showRaw ? "-rotate-180 transition-transform" : "transition-transform"}
          />
        </button>
      </div>

      {showInputs ? (
        <dl className="mt-2 grid gap-x-6 gap-y-1.5 rounded-lg border border-amber-border bg-amber-soft p-3 sm:grid-cols-2">
          {used.map(([key, value]) => (
            <div key={key} className="flex items-baseline justify-between gap-3">
              <dt className="font-mono text-[11.5px] text-ink-3">{key}</dt>
              <dd className="font-mono text-[11.5px] text-ink" data-numeric="">
                {String(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {showRaw ? (
        <pre className="gv-scroll-x mt-2 max-h-80 overflow-auto rounded-lg border border-line bg-sunken p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
          {JSON.stringify(result.output, null, 2)}
        </pre>
      ) : null}

      {result.source ? <SourcePanel report={result.source} /> : null}

      <p className="mt-3 font-mono text-[11px] text-ink-3">run {result.run_id}</p>
    </div>
  );
}

function AgentRunCard({
  agent,
  open,
  onToggle,
  spec,
  draft,
  onField,
  onReset,
  state,
  onRun,
  disabled,
  sourceUrl,
  sourceHeader,
  onSourceUrl,
  onSourceHeader,
  check,
  onCheck,
}: {
  agent: Agent;
  open: boolean;
  onToggle: () => void;
  spec: SpecState | undefined;
  draft: Draft;
  onField: (name: string, value: string) => void;
  onReset: () => void;
  state: RunState;
  onRun: () => void;
  disabled: boolean;
  sourceUrl: string;
  sourceHeader: string;
  onSourceUrl: (next: string) => void;
  onSourceHeader: (next: string) => void;
  check: CheckState;
  onCheck: () => void;
}) {
  const running = state.status === "running";
  const fields = spec?.status === "ready" ? spec.spec.fields : [];
  const blocked = fields.some((field) => fieldError(field, draft[field.name] ?? "") !== null);
  const changed = fields.filter((field) => (draft[field.name] ?? "").trim()).length;

  return (
    <li className={`gv-card flex flex-col p-4 ${open ? "lg:col-span-2 xl:col-span-3" : ""}`}>
      <div className="flex items-start gap-3">
        <span className="gv-icon-plate shrink-0">
          <AgentIcon id={agent.id} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] leading-snug font-semibold text-ink">{agent.name}</h3>
          <p className="gv-id mt-0.5 text-ink-3">{agent.toolName}</p>
        </div>
        <TierBadge tier={agent.tier} />
      </div>

      <p
        className={`mt-2.5 text-[12.5px] leading-relaxed text-ink-2 ${open ? "" : "line-clamp-3"}`}
      >
        {agent.summary}
      </p>

      {/* The explainer sits on the collapsed card rather than behind the
          "set up a run" step, because the question it answers — what does this
          one actually do — is the question someone has *before* deciding to
          run it. It reads the agent catalog, so it cannot describe a pipeline
          the agent does not have. */}
      <div className="mt-3">
        <AgentPipeline agent={agent} compact={!open} />
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={open ? "secondary" : "primary"}
          onClick={onToggle}
          aria-expanded={open}
        >
          {open ? "Close" : "Set up a run"}
        </Button>

        {open ? (
          <Button
            size="sm"
            variant="primary"
            onClick={onRun}
            disabled={disabled || running || blocked}
          >
            {running ? "Running…" : "Run agent"}
          </Button>
        ) : null}

        {open && changed > 0 ? (
          <Button size="sm" variant="ghost" onClick={onReset}>
            Reset
          </Button>
        ) : null}

        {running ? (
          <span className="text-[12px] text-ink-3" role="status">
            {READS_DOCUMENTS.has(agent.id) ? "reading 8 documents…" : "working…"}
          </span>
        ) : null}

        {!open && state.status === "done" ? (
          <span className="text-[12px] text-ink-3">ran once</span>
        ) : null}
      </div>

      {open ? (
        <div className="mt-4 border-t border-line pt-4">
          {spec?.status === "loading" ? (
            <p className="text-[12.5px] text-ink-3">Loading the inputs this agent accepts…</p>
          ) : null}

          {spec?.status === "error" ? (
            <p className="rounded-lg border border-fail-border bg-fail-soft p-3 text-[12.5px] text-fail">
              {spec.message}
            </p>
          ) : null}

          {spec?.status === "ready" ? (
            <>
              <SourceControls
                url={sourceUrl}
                headerValue={sourceHeader}
                onUrl={onSourceUrl}
                onHeader={onSourceHeader}
                check={check}
                onCheck={onCheck}
              />

              {fields.length > 0 ? (
                <>
                  <div className="mb-3 flex flex-wrap items-baseline gap-2">
                    <h4 className="text-[12.5px] font-semibold text-ink">Overrides</h4>
                    <span className="text-[11.5px] text-ink-3">
                      each field says what leaving it blank will do
                    </span>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {fields.map((field) => (
                      <InputControl
                        key={field.name}
                        field={field}
                        value={draft[field.name] ?? ""}
                        onChange={(next) => onField(field.name, next)}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-[12.5px] font-medium text-ink">
                  Nothing here is overridable yet.
                </p>
              )}

              {spec.spec.caveat ? (
                <p className="mt-4 flex items-start gap-2.5 rounded-lg border border-line bg-sunken p-3 text-[12.5px] leading-relaxed text-ink-2">
                  <span className="mt-px shrink-0 text-ink-3">
                    <Icon name="book" size={14} />
                  </span>
                  <span>{spec.spec.caveat}</span>
                </p>
              ) : null}
            </>
          ) : null}

          {state.status === "error" ? (
            <p className="mt-4 rounded-lg border border-fail-border bg-fail-soft p-3 text-[12.5px] text-fail">
              {state.message}
            </p>
          ) : null}

          {state.status === "done" ? <ResultPanel result={state.result} /> : null}
        </div>
      ) : null}
    </li>
  );
}

export default function ConsoleAgentsPage() {
  const [token] = useToken();
  const [openId, setOpenId] = useState<string | null>(null);
  const [specs, setSpecs] = useState<Record<string, SpecState>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [states, setStates] = useState<Record<string, RunState>>({});
  const [busy, setBusy] = useState(false);

  // One source for the whole page rather than one per card: it describes where
  // your data lives, which does not change between agents.
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceHeader, setSourceHeader] = useState("");
  const [check, setCheck] = useState<CheckState>(NO_CHECK);

  const sourceBody = useCallback(() => {
    const url = sourceUrl.trim();
    if (!url) return null;
    const headers: Record<string, string> = {};
    const header = sourceHeader.trim();
    if (header) headers.Authorization = header;
    return { url, headers };
  }, [sourceHeader, sourceUrl]);

  const runCheck = useCallback(async () => {
    const body = sourceBody();
    if (!body || !token) {
      setCheck({ status: "error", message: "Add an API token in Settings first." });
      return;
    }
    setCheck({ status: "checking" });
    const outcome = await api.checkSource(token, body);
    setCheck(
      outcome.ok
        ? { status: "ok", report: outcome.data }
        : { status: "error", message: outcome.message },
    );
  }, [sourceBody, token]);

  const toggle = useCallback(
    async (agentId: string) => {
      if (openId === agentId) {
        setOpenId(null);
        return;
      }
      setOpenId(agentId);

      // A successful load is kept: the declaration only changes when the API is
      // redeployed, and refetching on every open would flicker the form under
      // anyone mid-edit. A failure is not kept, because caching it turns one
      // unlucky moment — the API restarting, a dropped connection — into a card
      // that can never show its form again however many times you reopen it.
      if (specs[agentId]?.status === "ready") return;

      setSpecs((prev) => ({ ...prev, [agentId]: { status: "loading" } }));
      const outcome = await api.agentInputs(token, agentId);
      setSpecs((prev) => ({
        ...prev,
        [agentId]: outcome.ok
          ? { status: "ready", spec: outcome.data }
          : { status: "error", message: outcome.message },
      }));
    },
    [openId, specs, token],
  );

  const run = useCallback(
    async (agentId: string) => {
      if (!token) {
        setStates((prev) => ({
          ...prev,
          [agentId]: {
            status: "error",
            message: "No API token. Add one in Settings, then try again.",
          },
        }));
        return;
      }

      const spec = specs[agentId];
      const fields = spec?.status === "ready" ? spec.spec.fields : [];
      const payload = toPayload(fields, drafts[agentId] ?? {});

      setBusy(true);
      setStates((prev) => ({ ...prev, [agentId]: { status: "running" } }));

      const outcome = await api.runAgent(token, agentId, payload, sourceBody());
      setStates((prev) => ({
        ...prev,
        [agentId]: outcome.ok
          ? { status: "done", result: outcome.data }
          : { status: "error", message: outcome.message },
      }));
      setBusy(false);
    },
    [drafts, sourceBody, specs, token],
  );

  const ranCount = useMemo(
    () => Object.values(states).filter((state) => state.status === "done").length,
    [states],
  );

  return (
    <ConsolePage
      title="Agents"
      description="Set the inputs, run any agent against the connected environment, and read exactly what it produced — the same runner the MCP server uses."
    >
      {!token ? (
        <p className="mb-5 flex items-start gap-2.5 rounded-lg border border-amber-border bg-amber-soft p-3.5 text-[12.5px] leading-relaxed text-amber-strong">
          <span className="mt-px shrink-0">
            <Icon name="warning" size={14} />
          </span>
          <span>
            <strong>No API token.</strong> Running an agent needs one carrying the{" "}
            <code className="font-mono">agents:run</code> scope. Add it in Settings.
          </span>
        </p>
      ) : null}

      <p className="mb-6 max-w-3xl text-[12.5px] leading-relaxed text-ink-3">
        Every card carries a diagram of what that agent actually does, drawn from the same
        catalog the API and the MCP surface read — <span className="text-teal-ink">teal is the
        language model thinking</span>, navy is deterministic code, and the split is the point:
        a probability comes from a versioned scorecard and only the sentence around it comes
        from a model. Point a run at a <strong>data source</strong> — a GET endpoint of yours
        returning statement lines and application fields as JSON — and the figures that come
        back are real answers about your data, with no document-AI key involved. The fields on
        each card are <strong>overrides</strong>, not inputs: most have a real source, and
        leaving one blank reads it from there rather than substituting a constant. There is no
        file upload because the sandbox reader returns a fixed extraction per document type and
        never opens the file.{" "}
        {ranCount > 0 ? `${ranCount} run so far this session.` : ""}
      </p>

      {TIERS.map((tier) => {
        const agents = AGENTS.filter((agent) => agent.tier === tier.tier);
        return (
          <section key={tier.tier} className="mb-8">
            <div className="mb-3 flex items-baseline gap-2">
              <h2 className="text-[13px] font-semibold text-ink">{tier.label}</h2>
              <span className="font-mono text-[11.5px] text-ink-3" data-numeric="">
                {agents.length}
              </span>
            </div>
            <ul className="grid items-start gap-3 lg:grid-cols-2 xl:grid-cols-3">
              {agents.map((agent) => (
                <AgentRunCard
                  key={agent.id}
                  agent={agent}
                  open={openId === agent.id}
                  onToggle={() => void toggle(agent.id)}
                  spec={specs[agent.id]}
                  draft={drafts[agent.id] ?? {}}
                  onField={(name, value) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [agent.id]: { ...(prev[agent.id] ?? {}), [name]: value },
                    }))
                  }
                  onReset={() => setDrafts((prev) => ({ ...prev, [agent.id]: {} }))}
                  state={states[agent.id] ?? IDLE}
                  onRun={() => void run(agent.id)}
                  disabled={busy}
                  sourceUrl={sourceUrl}
                  sourceHeader={sourceHeader}
                  onSourceUrl={setSourceUrl}
                  onSourceHeader={setSourceHeader}
                  check={check}
                  onCheck={() => void runCheck()}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </ConsolePage>
  );
}
