"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ConsolePage } from "@/components/console/ConsoleShell";
import { RunGraph, toStepGraph } from "@/components/console/RunGraph";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { Badge, StatusBadge, Tag } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/Field";
import { DataModeBanner, InlineNote } from "@/components/ui/States";
import { StatTile } from "@/components/ui/Stat";
import { DefinitionRow, Panel } from "@/components/ui/Surface";
import { api, type RunOut, type RunStepOut, runDuration } from "@/lib/api";
import { AGENTS_BY_ID } from "@/lib/agents";
import {
  formatCount,
  formatDuration,
  formatInr,
  formatTimeIst,
  formatTokens,
} from "@/lib/format";
import { useToken } from "@/lib/session";
import { useResource } from "@/lib/useResource";

function StepCard({ step, index }: { step: RunStepOut; index: number }) {
  const [expanded, setExpanded] = useState(index < 2);
  const failedValidators = step.validators.filter((v) => v.result === "fail");

  return (
    <li className="relative min-w-0 pl-8">
      <span
        aria-hidden="true"
        className="absolute top-5 left-[11px] h-[calc(100%-0.5rem)] w-px bg-line"
      />
      <span
        aria-hidden="true"
        className={`absolute top-4 left-1.5 block h-3 w-3 border-2 ${
          step.status === "ok"
            ? "border-brand bg-surface"
            : step.status === "failed"
              ? "border-fail bg-fail"
              : "border-line-strong bg-surface"
        }`}
      />
      <article className="mb-3 min-w-0 gv-card">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
          <span
            className="font-mono text-[11px] text-ink-3"
            data-numeric=""
          >{`${String(index + 1).padStart(2, "0")}`}</span>
          <h3 className="font-mono text-[13px] font-medium text-ink">{step.name}</h3>
          <StatusBadge status={step.status} />
          {step.prompt_version ? <Tag>{step.prompt_version}</Tag> : null}
          <span className="ml-auto flex items-center gap-3 font-mono text-[11.5px] text-ink-3">
            <span data-numeric="">{formatDuration(step.latency_ms)}</span>
            <span data-numeric="">{formatInr(step.cost_inr)}</span>
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="text-ink-2 underline underline-offset-2 hover:text-ink"
            >
              {expanded ? "collapse" : "expand"}
            </button>
          </span>
        </header>

        {expanded ? (
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
            <div className="min-w-0 bg-surface p-4">
              <p className="gv-eyebrow mb-2">Input · redacted</p>
              <pre className="max-h-56 overflow-auto rounded-md border border-line bg-surface-2 p-2.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-ink-2">
                {step.redacted_input}
              </pre>
              <dl className="mt-3">
                <DefinitionRow term="Model">
                  <span className="font-mono text-[12px]">{step.model ?? "—"}</span>
                </DefinitionRow>
                <DefinitionRow term="Tokens in / out" mono>
                  {formatTokens(step.input_tokens)} / {formatTokens(step.output_tokens)}
                </DefinitionRow>
                <DefinitionRow term="Started" mono>
                  {formatTimeIst(step.started_at)}
                </DefinitionRow>
              </dl>
            </div>

            <div className="min-w-0 bg-surface p-4">
              <p className="gv-eyebrow mb-2">Output</p>
              <pre className="max-h-56 overflow-auto rounded-md border border-line bg-surface-2 p-2.5 font-mono text-[11.5px] leading-relaxed text-ink-2">
                {JSON.stringify(step.output, null, 2)}
              </pre>

              <p className="gv-eyebrow mt-4 mb-2">Validators</p>
              <ul className="flex flex-wrap gap-1.5">
                {step.validators.map((validator) => (
                  <li key={validator.name}>
                    <span
                      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[10.5px] ${
                        validator.result === "pass"
                          ? "border-pass-border bg-pass-soft text-pass"
                          : "border-fail-border bg-fail-soft text-fail"
                      }`}
                      title={validator.detail}
                    >
                      <Icon name={validator.result === "pass" ? "check" : "cross"} size={10} />
                      {validator.name}
                    </span>
                  </li>
                ))}
              </ul>
              {failedValidators.length > 0 ? (
                <p className="mt-2 text-[12px] text-fail">
                  {failedValidators.length} validator failed. The step output was rejected and
                  the run escalated.
                </p>
              ) : null}

              {step.citations.length > 0 ? (
                <>
                  <p className="gv-eyebrow mt-4 mb-2">Citations</p>
                  <ul className="space-y-1">
                    {step.citations.map((citation, citationIndex) => (
                      <li key={`${citation.document_id}-${citationIndex}`}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 border border-line bg-surface-2 px-2 py-1.5 text-left text-[12px] text-ink-2 hover:border-brand hover:text-ink"
                          title="Opens the document viewer with the page overlay, once the document service is connected."
                        >
                          <span className="text-brand">
                            <Icon name="book" size={12} />
                          </span>
                          <span className="font-mono text-[11px]">{citation.document_id}</span>
                          <span className="text-ink-3">page {citation.page}</span>
                          {citation.label ? (
                            <span className="truncate">{citation.label}</span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </article>
    </li>
  );
}

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const runId = params?.id ?? "";
  const [token] = useToken();
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);

  // `null`, not a worked example. A run record is the evidence that one agent
  // did one thing — its prompt versions, its validators, its citations. A
  // stand-in for that is not a placeholder, it is a fabricated execution
  // record, and somebody would eventually cite one.
  const run = useResource<RunOut | null>(
    `run:${runId}:${token ?? "none"}`,
    (signal) => api.getRun(token, runId, signal),
    null,
  );

  const data = run.data;
  const steps = data?.steps ?? [];
  const agent = data ? AGENTS_BY_ID[data.agent_id] : undefined;
  const graphSteps = useMemo(() => toStepGraph(steps), [steps]);
  const totalTokens = steps.reduce(
    (sum, step) => sum + step.input_tokens + step.output_tokens,
    0,
  );

  const act = (action: "approve" | "reject" | "request_info") => {
    if (!data) return;
    if (!note.trim()) {
      setOutcome("A note is mandatory. Every decision in this console is signed with one.");
      return;
    }
    setOutcome(null);
    void api.actOnTask(token, data.id, action, note).then((result) => {
      setOutcome(
        result.ok
          ? `Signalled ${action}. The workflow has resumed.`
          : `Could not signal ${action}: ${result.message}`,
      );
    });
  };

  // There is no partial version of this screen. Without the run record every
  // tile, every step card and the decision panel would be reporting on
  // something this console never read, so none of them is drawn.
  if (!data) {
    return (
      <ConsolePage
        title={runId ? `Run ${runId}` : "Run"}
        description="This run could not be read from the API."
        actions={
          <Link href="/console/runs" className="gv-link text-[13px]">
            All runs
          </Link>
        }
      >
        <DataModeBanner
          mode={run.mode}
          failure={run.failure}
          onRetry={run.reload}
          what="this run"
        />
        {run.mode === "loading" ? (
          <div
            className="gv-skeleton h-[220px] w-full"
            role="status"
            aria-label="Loading the run"
          />
        ) : (
          <Panel title="Nothing to show">
            <p className="text-[13px] leading-relaxed text-ink-2">
              A run record is evidence: the prompt version behind each step, the validators that
              passed, the documents each answer cites. None of that was returned, so none of it
              is drawn. The note above carries the reason and a way to try again.
            </p>
          </Panel>
        )}
      </ConsolePage>
    );
  }

  return (
    <ConsolePage
      title={`Run ${data.id}`}
      description={
        agent ? (
          <>
            {agent.name} ·{" "}
            <Link href={`/agents/${agent.id}`} className="gv-link">
              agent specification
            </Link>
          </>
        ) : (
          data.agent_id
        )
      }
      actions={
        <Link href="/console/runs" className="gv-link text-[13px]">
          All runs
        </Link>
      }
    >
      <DataModeBanner
        mode={run.mode}
        failure={run.failure}
        onRetry={run.reload}
        what="this run"
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile
          label="Status"
          value={<StatusBadge status={data.status} />}
          note={data.escalated ? "Waiting on a human" : "No escalation"}
        />
        {/* Derived from the timestamps, because the API does not send a
            duration. It read "—" before — a dash where the answer was two
            fields away. */}
        <StatTile label="Elapsed" value={formatDuration(runDuration(data))} />
        <StatTile label="Cost" value={formatInr(data.cost_inr)} accent="brand" />
        <StatTile label="Tokens" value={formatTokens(totalTokens)} />
        <StatTile label="Steps" value={formatCount(steps.length)} accent="blue" />
      </div>

      {/* The graph goes first because it answers "where did this run go?" in one
          look. The step cards stay beneath it and stay complete: the drawer
          shows one step at a time, so until it carries the whole record — the
          full redacted input, every validator detail, the citation viewer — the
          cards are still the only place the whole run can be read. */}
      <section aria-label="Run graph">
        <RunGraph
          steps={graphSteps}
          runId={data.id}
          title={agent ? agent.name : data.agent_id}
        />
      </section>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <Panel
          title="Step timeline"
          description="Each step records its prompt version, redacted input, output, validator results, tokens, rupee cost, latency and citations."
          bodyClassName="p-4"
        >
          {steps.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-ink-3">
              No steps recorded for this run.
            </p>
          ) : (
            <ol className="relative">
              {steps.map((step, index) => (
                <StepCard key={step.id} step={step} index={index} />
              ))}
            </ol>
          )}
        </Panel>

        <div className="space-y-3">
          <Panel title="Run context">
            <dl>
              <DefinitionRow term="Run id" mono>
                {data.id}
              </DefinitionRow>
              <DefinitionRow term="Tenant">{data.tenant}</DefinitionRow>
              <DefinitionRow term="Agent" mono>
                {data.agent_id}
              </DefinitionRow>
              <DefinitionRow term="Application" mono>
                {data.application_id ? (
                  <Link
                    href={`/console/applications/${data.application_id}`}
                    className="gv-link"
                  >
                    {data.application_id}
                  </Link>
                ) : (
                  "—"
                )}
              </DefinitionRow>
              <DefinitionRow term="Started" mono>
                {formatTimeIst(data.started_at)}
              </DefinitionRow>
              <DefinitionRow term="Risk band">
                {data.band ?? <span className="text-ink-3">not applicable</span>}
              </DefinitionRow>
            </dl>
            {agent ? (
              <div className="mt-4 flex items-start gap-3 rounded-md border border-line bg-surface-2 p-3">
                <span className="mt-0.5 shrink-0 text-brand">
                  <AgentIcon id={agent.id} size={20} />
                </span>
                <p className="text-[12.5px] leading-relaxed text-ink-2">
                  {agent.advisoryOnly ? (
                    <>
                      <Badge tone="brand">advisory only</Badge> This agent never takes an
                      irreversible action on its own.
                    </>
                  ) : (
                    <>
                      <Badge tone="amber">acts</Badge> This agent acts. Its guardrails are
                      enforced in code.
                    </>
                  )}
                </p>
              </div>
            ) : null}
          </Panel>

          <Panel
            title="Decision"
            description="Approve, reject or request more information. The note is mandatory and enters the audit chain with your identity."
          >
            <TextArea
              label="Note"
              required
              rows={4}
              value={note}
              onChange={setNote}
              placeholder="State the reason. This is read by the next person and by an auditor."
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => act("approve")}>
                Approve
              </Button>
              <Button variant="danger" size="sm" onClick={() => act("reject")}>
                Reject
              </Button>
              <Button size="sm" onClick={() => act("request_info")}>
                Request info
              </Button>
            </div>
            {/* The outcome of pressing Approve is the whole point of pressing
                it, and it appears only as text below the buttons. Without a
                live region a screen-reader user presses the button and is told
                nothing at all — including when the press was refused for a
                missing note. Polite rather than assertive: the message lands
                after a deliberate action, so it can wait for a gap. */}
            <div role="status" aria-live="polite">
              {outcome ? (
                <div className="mt-3">
                  <InlineNote tone="amber">{outcome}</InlineNote>
                </div>
              ) : null}
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
              These map to Temporal workflow signals with SLA timers at 24 and 72 hours. A
              credit decision cannot be approved by a collections role.
            </p>
          </Panel>
        </div>
      </div>
    </ConsolePage>
  );
}
