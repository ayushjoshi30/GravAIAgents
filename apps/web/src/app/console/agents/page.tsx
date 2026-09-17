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

import Link from "next/link";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ConsolePage } from "@/components/console/ConsoleShell";
import { DocumentUpload } from "@/components/console/DocumentUpload";
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
  type DocumentUploadOut,
  type SourceReport,
} from "@/lib/api";
import { formatInr } from "@/lib/format";
import { useToken } from "@/lib/session";

type RunState =
  | { status: "idle" }
  | { status: "running" }
  /**
   * A finished run, plus what was sent with it.
   *
   * `attached` and `sourceSent` are a snapshot taken at the moment of the
   * request, not a reading of the current page state. Someone can remove a
   * document or clear the source URL while the result is still on screen, and a
   * result panel that re-read the live state would quietly rewrite the history
   * of a run that has already happened — telling a person their run carried one
   * document when it carried three.
   */
  | {
      status: "done";
      result: AgentRunResult;
      attached: DocumentUploadOut[];
      sourceSent: boolean;
    }
  /**
   * A run that produced nothing.
   *
   * The status is kept because the contract spends specific codes on documents
   * — 404 for an id that is not yours or does not exist, 502 for a blob store
   * that could not be reached — and a person who attached a file deserves to
   * know which of those they are looking at.
   */
  | { status: "error"; message: string; httpStatus: number | null; documentsSent: number };

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
        {/* The byte count is what was fetched over HTTP, and an upload was not
            fetched over HTTP — the report comes back with nothing there. A
            "0.0 kB" beside a nineteen-page document that was read perfectly
            well would be a number contradicting the sentence under it. */}
        {report.bytes_fetched > 0 ? (
          <span className="ml-auto font-mono text-[11px] text-ink-3" data-numeric="">
            {(report.bytes_fetched / 1024).toFixed(1)} kB
          </span>
        ) : null}
      </div>

      {/* A run whose documents came from uploads has no URL to name — the
          platform resolved them out of blob storage — and the report comes
          back with that field empty. Printing "from ." there would read as a
          rendering fault; naming a URL that was never fetched would be worse. */}
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
        {report.url ? (
          <>
            Fetched {counts.join(", ") || "nothing usable"} from{" "}
            <code className="font-mono break-all">{report.url}</code>.
          </>
        ) : (
          <>Read {counts.join(", ") || "nothing usable"}.</>
        )}
      </p>

      {/* The heading used to say "How your field names were read", which was
          true of every note a fetch produced. The run's report now also carries
          a note for documents that came from an upload, where no field name was
          involved at all, so the heading says what the whole list is: how this
          run came by what it read. */}
      {report.notes.length > 0 ? (
        <>
          <p className="gv-eyebrow mt-2.5">How this source was read</p>
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
    // The outer margin used to live here. It moved to `WaysIn`, which now owns
    // the spacing for both halves so that neither can drift away from the other.
    <div className="rounded-lg border border-line bg-sunken p-4">
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

/**
 * The two ways a document gets in, side by side.
 *
 * They are laid out as equal halves of one grid rather than stacked, because
 * stacking would make whichever came second read as the fallback. Neither is:
 * a tenant that already runs a document service should keep pointing runs at
 * it — no key, no upload, no copy of the file anywhere — and a tenant that has
 * no such service needs somewhere to put a file. The heading says "or" for the
 * same reason.
 *
 * "Either one, not both" used to end that heading, and it no longer does. A run
 * now carries uploaded document ids alongside a source URL if both are set, and
 * what comes back is a single document count covering the two together — which
 * is why the result panel refuses to read that count as a verdict on the
 * uploads when a URL went with them.
 */
function WaysIn({
  source,
  upload,
}: {
  source: ReactNode;
  upload: ReactNode;
}) {
  return (
    <div className="mb-5">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h4 className="text-[12.5px] font-semibold text-ink">Where the documents come from</h4>
        <span className="text-[11.5px] text-ink-3">
          point the run at a service of yours, or hand it a file — an upload goes into the run
          as an id
        </span>
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-2">
        {source}
        {upload}
      </div>
    </div>
  );
}

/**
 * What the run's own report says about the documents that went with it.
 *
 * WHAT THE COUNT IS, AND WHAT IT IS NOT. `documents` is the size of the source
 * the runner was handed, counted by the API after it resolved the ids out of
 * storage. So it is evidence that the uploads reached the run — the thing that
 * was impossible before `document_ids` existed — and it is not evidence that
 * the agent quoted, extracted from or otherwise acted on them. The response
 * carries no per-document outcome and no per-document ids, so the strongest
 * true sentence available here is about what the run was given, and this block
 * will not write a stronger one. An earlier draft of this panel said the count
 * caught a file being "accepted and then ignored"; it cannot, and a reader who
 * believed it would have taken a restatement of their own request for a finding
 * about the agent.
 *
 * The list below says what was SENT and the sentence beside it says what the
 * run's report counted. Nothing tries to pair the two up, because nothing in
 * the response makes that pairing knowable.
 *
 * The shapes it can take:
 *
 *   - No source report at all. Nothing reached the run's source, so the ids
 *     went nowhere — which is also what an API build that predates
 *     `document_ids` looks like from here, because it ignores the field rather
 *     than refusing it. Either way the documents were not read.
 *   - A source URL went with the ids. The count is one number covering both,
 *     and splitting it would be arithmetic on data that is not there.
 *   - Ids alone. The count should equal what was sent, because the API resolves
 *     every id or fails the whole run. The mismatch arms below are there for an
 *     API that stops being true to that, not because either is expected today.
 */
function DocumentOutcome({
  result,
  attached,
  sourceSent,
}: {
  result: AgentRunResult;
  attached: DocumentUploadOut[];
  sourceSent: boolean;
}) {
  if (attached.length === 0) return null;

  const report = result.source;
  const sent = attached.length;
  const read = report?.documents ?? 0;
  const withContent = report?.documents_with_content ?? 0;

  // Tone is decided by whether the run accounted for what it was given, not by
  // whether the run itself succeeded: an agent can clear every guardrail on a
  // document set that is missing the file someone cared about.
  const missing = report === null || (!sourceSent && read < sent);
  const plate = missing
    ? "border-fail-border bg-fail-soft text-fail"
    : "border-line bg-sunken text-ink-2";

  return (
    <div className={`mt-3 rounded-lg border p-3 ${plate}`}>
      <p className="text-[12.5px] leading-relaxed">
        <strong className="font-medium">
          {sent} uploaded document{sent === 1 ? "" : "s"} sent with this run.
        </strong>{" "}
        {report === null ? (
          <>
            The run reported no source at all, so nothing in its result says{" "}
            {sent === 1 ? "this document was" : "these documents were"} read. Do not treat the
            output as having taken {sent === 1 ? "it" : "them"} into account.
          </>
        ) : sourceSent ? (
          <>
            Its source report counts {read} document{read === 1 ? "" : "s"}, {withContent} with
            content — but a data source was sent as well, and that count covers both. This
            console cannot say how many of those {read} were{" "}
            {sent === 1 ? "this upload" : "these uploads"}, and the count would not say what
            the agent made of them if it could.
          </>
        ) : read < sent ? (
          <>
            It reported reading only {read} of them, {withContent} with content. The other{" "}
            {sent - read} {sent - read === 1 ? "was" : "were"} not read — that gap is the signal
            something was not readable, and the output cannot be relied on to cover{" "}
            {sent - read === 1 ? "it" : "them"}.
          </>
        ) : read > sent ? (
          <>
            It reported reading {read} documents, {withContent} with content — more than were
            sent from here, so the rest came from somewhere other than these uploads.
          </>
        ) : (
          <>
            Its source report counts {read} document{read === 1 ? "" : "s"}, {withContent} with
            content, so {sent === 1 ? "it reached" : "they reached"} the run rather than only
            the store. That is as far as the response goes — it says nothing about what the
            agent did with {sent === 1 ? "it" : "them"}, so read the output below on its own
            terms.
            {withContent < read ? (
              <>
                {" "}
                The {read - withContent} with no content reached the run as documents but
                carried nothing for an agent to work from.
              </>
            ) : null}
          </>
        )}
      </p>

      <ul className="mt-2 space-y-1">
        {attached.map((document) => (
          <li key={document.document_id} className="flex flex-wrap items-baseline gap-2">
            <span className="text-[11.5px]">{document.filename}</span>
            <code className="font-mono text-[11px] break-all opacity-80">
              {document.document_id}
            </code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultPanel({
  result,
  attached,
  sourceSent,
}: {
  result: AgentRunResult;
  attached: DocumentUploadOut[];
  sourceSent: boolean;
}) {
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

      {/* Above the agent's own words on purpose. Whether the file was read is
          the question someone who attached one is holding while they read
          everything else, and an answer further down the panel would be found
          after the summary had already been believed. */}
      <DocumentOutcome result={result} attached={attached} sourceSent={sourceSent} />

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
  token,
  documents,
  onDocumentStored,
  attachedDocuments,
  onAttachDocument,
  onDetachDocument,
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
  token: string | null;
  documents: DocumentUploadOut[];
  onDocumentStored: (document: DocumentUploadOut) => void;
  attachedDocuments: DocumentUploadOut[];
  onAttachDocument: (document: DocumentUploadOut) => void;
  onDetachDocument: (documentId: string) => void;
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
              <WaysIn
                source={
                  <SourceControls
                    url={sourceUrl}
                    headerValue={sourceHeader}
                    onUrl={onSourceUrl}
                    onHeader={onSourceHeader}
                    check={check}
                    onCheck={onCheck}
                  />
                }
                upload={
                  <DocumentUpload
                    token={token}
                    stored={documents}
                    onStored={onDocumentStored}
                    attached={attachedDocuments}
                    onAttach={onAttachDocument}
                    onDetach={onDetachDocument}
                  />
                }
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
            <div className="mt-4 rounded-lg border border-fail-border bg-fail-soft p-3 text-[12.5px] leading-relaxed text-fail">
              <p>{state.message}</p>
              {/* A failed run produced no result, so there is nothing that
                  could say whether the documents were read — which is worth
                  stating, because the attached list is still sitting on screen
                  saying they went with it. The two status codes the document
                  contract spends are named when they come up: a 404 is the one
                  answer given both to an id that is not yours and to an id that
                  does not exist, and the API deliberately does not tell the two
                  apart. */}
              {state.documentsSent > 0 ? (
                <p className="mt-1.5">
                  {state.documentsSent} document id{state.documentsSent === 1 ? "" : "s"} went
                  with this run. It produced no result, so nothing here says whether{" "}
                  {state.documentsSent === 1 ? "it was" : "any of them were"} read.
                  {state.httpStatus === 404 ? (
                    <>
                      {" "}
                      A 404 is also what an id answers when it does not exist or is not your
                      tenant&apos;s — the API gives the same reply to both, so check the ids
                      before reading anything more into it.
                    </>
                  ) : null}
                  {state.httpStatus === 502 ? (
                    <>
                      {" "}
                      A 502 here is the blob store being unreachable, so the documents could not
                      be fetched. Nothing is wrong with the ids.
                    </>
                  ) : null}
                </p>
              ) : null}
            </div>
          ) : null}

          {state.status === "done" ? (
            <ResultPanel
              result={state.result}
              attached={state.attached}
              sourceSent={state.sourceSent}
            />
          ) : null}
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

  // Uploaded documents are held for the page, not for the card that happened to
  // be open when the upload finished. Cards close when another opens, and a
  // document id that vanished because someone looked at a second agent would be
  // lost for good — the console has no way to list documents back.
  const [documents, setDocuments] = useState<DocumentUploadOut[]>([]);

  /**
   * The ids the next run will carry, in the order they were attached.
   *
   * Ids rather than documents, because ids are what the request carries: a list
   * of objects here would be a second copy of the truth, and the one that got
   * out of step would be the one on screen. Anything attached is by definition
   * something `documents` already holds, so the objects are looked back up
   * rather than stored twice.
   *
   * This is memory, not a library. Nothing in the console can list a tenant's
   * documents back, so a reload leaves the uploads on the platform and the ids
   * unreachable from here — which the upload panel says in as many words rather
   * than letting the list imply a permanence it does not have.
   */
  const [attachedIds, setAttachedIds] = useState<string[]>([]);

  const recordDocument = useCallback((document: DocumentUploadOut) => {
    setDocuments((previous) =>
      previous.some((existing) => existing.document_id === document.document_id)
        ? previous
        : [document, ...previous],
    );
  }, []);

  const attachDocument = useCallback((document: DocumentUploadOut) => {
    setAttachedIds((previous) =>
      previous.includes(document.document_id) ? previous : [...previous, document.document_id],
    );
  }, []);

  const detachDocument = useCallback((documentId: string) => {
    setAttachedIds((previous) => previous.filter((id) => id !== documentId));
  }, []);

  /**
   * The attached ids resolved back to what was uploaded, for display.
   *
   * An id with no document behind it is dropped rather than rendered as a bare
   * id: it cannot happen while `documents` only grows, and if it ever does, a
   * row naming no file is not something a person can act on.
   */
  const attachedDocuments = useMemo(() => {
    const byId = new Map(documents.map((document) => [document.document_id, document]));
    return attachedIds.flatMap((id) => {
      const document = byId.get(id);
      return document ? [document] : [];
    });
  }, [attachedIds, documents]);

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
            httpStatus: null,
            documentsSent: 0,
          },
        }));
        return;
      }

      const spec = specs[agentId];
      const fields = spec?.status === "ready" ? spec.spec.fields : [];
      const payload = toPayload(fields, drafts[agentId] ?? {});

      // Frozen before the request goes out, and reported against afterwards.
      // What the run carried is a fact about the request; reading it back off
      // the page when the answer arrives would let a removal made while the
      // agent was working rewrite what the run was given.
      const sent = attachedDocuments;
      const source = sourceBody();

      setBusy(true);
      setStates((prev) => ({ ...prev, [agentId]: { status: "running" } }));

      const outcome = await api.runAgent(
        token,
        agentId,
        payload,
        source,
        sent.map((document) => document.document_id),
      );
      setStates((prev) => ({
        ...prev,
        [agentId]: outcome.ok
          ? { status: "done", result: outcome.data, attached: sent, sourceSent: source !== null }
          : {
              status: "error",
              message: outcome.message,
              httpStatus: outcome.status ?? null,
              documentsSent: sent.length,
            },
      }));
      setBusy(false);
    },
    [attachedDocuments, drafts, sourceBody, specs, token],
  );

  const ranCount = useMemo(
    () => Object.values(states).filter((state) => state.status === "done").length,
    [states],
  );

  return (
    <ConsolePage
      title="Agents"
      description="Set the inputs, run any agent against the connected environment, and read exactly what it produced — the same runner the MCP server uses."
      actions={
        /* The way out of the catalog and into the builder.
           
           It belongs here rather than only in the sidebar because this is the
           page where someone forms the thought. They have just read what the
           fourteen agents do, found that none of them is quite the job they
           have, and the next thing they want is to put three of them in a row
           themselves. A nav item halfway down a sidebar does not meet that
           thought; a button at the top of the page they are already reading
           does.
           
           It is a link, not a button that navigates — so it opens in a new tab
           on a middle click, can be copied, and tells the browser where it
           goes. The Studio takes over the whole screen, which is a big enough
           change of context that being able to open it in a second tab and keep
           the catalog in the first one is worth having. */
        <Link
          href="/console/studio"
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-[6px] bg-navy px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-navy-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
        >
          <Icon name="bolt" size={14} />
          Build your own agent
        </Link>
      }
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
        from a model. A document gets in one of two ways, and setting up a run shows both: point
        a run at a <strong>data source</strong> — a GET endpoint of yours returning statement
        lines and application fields as JSON — and the figures that come back are real answers
        about your data with no document-AI key involved; or <strong>upload a file</strong>,
        which is scanned before anything is kept, refused outright if no scanner can be
        reached, and then attached to the run by its id, which the platform resolves against
        your own tenant. The result then counts what the run&apos;s source actually carried,
        which is how you tell a file that reached the run from one that is only stored — it
        stops there, and nothing in the response says what the agent made of it. The fields on
        each card are{" "}
        <strong>overrides</strong>, not inputs: most have a real source, and leaving one blank
        reads it from there rather than substituting a constant.{" "}
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
                  token={token}
                  documents={documents}
                  onDocumentStored={recordDocument}
                  attachedDocuments={attachedDocuments}
                  onAttachDocument={attachDocument}
                  onDetachDocument={detachDocument}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </ConsolePage>
  );
}
