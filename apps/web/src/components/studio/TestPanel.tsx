"use client";

/**
 * TEST mode: give the workflow an input, run it, read what every node did.
 *
 * The trace is the point of this screen. A multi-agent workflow that returns a
 * wrong answer is nearly impossible to debug from the answer alone — what you
 * need is which node produced which value, what it was given, what it cost and
 * where the run branched. So every node is listed, including the ones that were
 * skipped, and a skipped node says which branch it was on rather than
 * disappearing.
 */

import { useState } from "react";
import { Icon } from "@/components/icons/AgentIcon";
import { Badge, Tag } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StatTile } from "@/components/ui/Stat";
import { formatInr } from "@/lib/format";
import type { NodeTrace, RunResult } from "@/lib/studio";

const STATUS_TONE: Record<string, { mark: string; className: string }> = {
  ok: { mark: "✓", className: "text-pass" },
  failed: { mark: "✕", className: "text-fail" },
  skipped: { mark: "–", className: "text-ink-3" },
  halted: { mark: "⏸", className: "text-amber" },
};

function Duration({ ms }: { ms: number }) {
  return (
    <span className="font-mono text-[11.5px] text-ink-3" data-numeric="">
      {ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}
    </span>
  );
}

function Payload({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text || text === "{}" || text === "null") return null;
  return (
    <div className="mt-2">
      <p className="gv-eyebrow mb-1">{label}</p>
      <pre className="gv-scroll-x max-h-56 overflow-auto rounded-lg border border-line bg-sunken p-2.5 font-mono text-[11px] leading-relaxed text-ink-2">
        {text}
      </pre>
    </div>
  );
}

function TraceRow({ entry }: { entry: NodeTrace }) {
  const [open, setOpen] = useState(false);
  const tone = STATUS_TONE[entry.status] ?? STATUS_TONE.skipped;

  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2"
      >
        <span className={`w-4 shrink-0 text-center text-[13px] ${tone.className}`}>{tone.mark}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-ink">{entry.title}</span>
          <span className="block truncate text-[11.5px] text-ink-3">
            {entry.error || entry.summary || entry.node_type}
          </span>
        </span>
        {entry.branch ? <Tag>{entry.branch}</Tag> : null}
        {entry.status !== "skipped" ? <Duration ms={entry.duration_ms} /> : null}
        <Icon
          name="chevron"
          size={11}
          className={`shrink-0 text-ink-3 transition-transform ${open ? "-rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div className="border-t border-line bg-surface-2 px-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tag>{entry.node_type}</Tag>
            {entry.attempts > 1 ? <Tag>{entry.attempts} attempts</Tag> : null}
            {entry.input_tokens + entry.output_tokens > 0 ? (
              <Tag>
                {entry.input_tokens} in / {entry.output_tokens} out
              </Tag>
            ) : null}
            <span className="ml-auto font-mono text-[11px] text-ink-3" data-numeric="">
              {formatInr(entry.cost_inr)}
            </span>
          </div>

          {entry.error ? (
            <p className="mt-2 rounded-lg border border-fail-border bg-fail-soft p-2.5 text-[12px] text-fail">
              {entry.error}
            </p>
          ) : null}

          <Payload label="Configuration" value={entry.inputs} />
          <Payload label="Output" value={entry.outputs} />
          <Payload label="Detail" value={entry.detail} />
        </div>
      ) : null}
    </li>
  );
}

export function TestPanel({
  inputText,
  onInputText,
  running,
  onRun,
  result,
  canRun,
  blockedReason,
}: {
  inputText: string;
  onInputText: (next: string) => void;
  running: boolean;
  onRun: () => void;
  result: RunResult | null;
  canRun: boolean;
  blockedReason: string;
}) {
  const [tab, setTab] = useState<"trace" | "state" | "output">("trace");

  // Counted from the trace rather than read from a field. The trace is the
  // record of what happened, so deriving from it cannot disagree with what the
  // rows below show — and a separate count that is absent renders "undefined".
  const ran = result?.trace.filter((entry) => entry.status === "ok").length ?? 0;
  const skipped = result?.trace.filter((entry) => entry.status === "skipped").length ?? 0;
  const nodeCount = `${ran}${skipped ? ` · ${skipped} skipped` : ""}`;

  let inputError: string | null = null;
  try {
    const parsed = JSON.parse(inputText || "{}");
    if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
      inputError = "The input must be a JSON object";
    }
  } catch (exc) {
    inputError = exc instanceof Error ? exc.message : "Not valid JSON";
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <p className="gv-eyebrow">Workflow input</p>
          <span className="text-[11px] text-ink-3">becomes the first facts</span>
        </div>
        <textarea
          rows={5}
          value={inputText}
          spellCheck={false}
          onChange={(event) => onInputText(event.target.value)}
          className="gv-field font-mono text-[11.5px] leading-relaxed"
          aria-invalid={inputError ? true : undefined}
        />
        {inputError ? <p className="mt-1.5 text-[11.5px] text-fail">{inputError}</p> : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={onRun}
            disabled={running || !canRun || Boolean(inputError)}
          >
            {running ? "Running…" : "▶ Run workflow"}
          </Button>
          {!canRun && blockedReason ? (
            <span className="text-[12px] text-fail">{blockedReason}</span>
          ) : null}
        </div>
      </div>

      {result ? (
        <>
          <div className="grid grid-cols-2 gap-2 border-b border-line px-4 py-3 sm:grid-cols-4">
            <StatTile
              label="Outcome"
              value={
                result.status === "completed"
                  ? "Completed"
                  : result.status === "awaiting_approval"
                    ? "Awaiting approval"
                    : result.status === "invalid"
                      ? "Invalid"
                      : "Failed"
              }
            />
            <StatTile label="Nodes" value={nodeCount} />
            <StatTile
              label="Duration"
              value={
                result.duration_ms < 1000
                  ? `${result.duration_ms}ms`
                  : `${(result.duration_ms / 1000).toFixed(1)}s`
              }
            />
            <StatTile label="Cost" value={formatInr(result.cost_inr)} />
          </div>

          <div className="flex items-center gap-1 border-b border-line px-3 py-2">
            {(["trace", "state", "output"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                aria-pressed={tab === key}
                className={`h-7 rounded-md px-2.5 text-[12px] font-medium capitalize transition-colors ${
                  tab === key ? "bg-brand-50 text-brand" : "text-ink-2 hover:bg-surface-2"
                }`}
              >
                {key}
              </button>
            ))}
            {result.status === "awaiting_approval" ? (
              <Badge tone="amber" dot>
                stopped for a person
              </Badge>
            ) : null}
          </div>

          <div className="gv-scroll-y min-h-0 flex-1 overflow-y-auto">
            {tab === "trace" ? (
              <ul>
                {result.trace.map((entry) => (
                  <TraceRow key={`${entry.node_id}-${entry.started_at}`} entry={entry} />
                ))}
              </ul>
            ) : null}

            {tab === "state" ? (
              <div className="px-4 py-3">
                <Payload label="Facts" value={result.state.facts} />
                {result.state.decisions.length > 0 ? (
                  <div className="mt-3">
                    <p className="gv-eyebrow mb-1.5">Decisions</p>
                    <ul className="space-y-1">
                      {result.state.decisions.map((decision) => (
                        <li
                          key={decision.name}
                          className="flex flex-wrap items-baseline gap-2 rounded-lg border border-line bg-sunken px-2.5 py-1.5"
                        >
                          <code className="font-mono text-[11.5px] text-ink">{decision.name}</code>
                          <span className="text-[12px] font-semibold text-ink">
                            {String(decision.value)}
                          </span>
                          {decision.deterministic ? (
                            <Tag>rule</Tag>
                          ) : (
                            <Tag>model</Tag>
                          )}
                          <span className="w-full text-[11.5px] text-ink-3">{decision.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {result.state.summaries.length > 0 ? (
                  <div className="mt-3">
                    <p className="gv-eyebrow mb-1.5">Summaries</p>
                    <ul className="space-y-1 text-[12px] leading-relaxed text-ink-2">
                      {result.state.summaries.map((summary, index) => (
                        <li key={index}>· {summary}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {result.state.warnings.length > 0 ? (
                  <ul className="mt-3 space-y-1 rounded-lg border border-amber-border bg-amber-soft p-3 text-[12px] text-amber-strong">
                    {result.state.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
                {result.state.errors.length > 0 ? (
                  <ul className="mt-3 space-y-1 rounded-lg border border-fail-border bg-fail-soft p-3 text-[12px] text-fail">
                    {result.state.errors.map((error, index) => (
                      <li key={index}>{error}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {tab === "output" ? (
              <div className="px-4 py-3">
                <Payload label="Final output" value={result.output} />
                {result.problems.length > 0 ? (
                  <ul className="mt-3 space-y-1 rounded-lg border border-amber-border bg-amber-soft p-3 text-[12px] text-amber-strong">
                    {result.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <p className="max-w-sm text-[12.5px] leading-relaxed text-ink-3">
            Run the workflow to see what each node received, produced, and cost — including the
            nodes a branch skipped.
          </p>
        </div>
      )}
    </div>
  );
}
