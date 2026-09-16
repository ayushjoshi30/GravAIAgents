"use client";

/**
 * A run drawn as a graph.
 *
 * The step cards below this on the run page are a complete record but a poor
 * picture: you cannot see from a stack of cards where the time went, which step
 * cost the money, or where the run stopped. The graph answers those three
 * questions in one look and hands the detail to the drawer beside it.
 *
 * One honesty constraint shapes the whole file. The API records a run as an
 * ordered list of steps; it does not record which step depended on which. So
 * this cannot draw a dependency graph, and pretending otherwise would put a
 * fork on screen that nothing in the data supports. It draws the recorded
 * sequence, and says on the card that that is what it is. When the API grows a
 * `depends_on` field, `toStepLike` starts reading it and the layout fans out on
 * its own — that is why `dependsOn` is a list here rather than a single parent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunStepOut } from "@/lib/api";
import { formatInr } from "@/lib/format";

export interface StepLike {
  id: string;
  name: string;
  /** What executed the step. Shown as the node's second line. */
  tool: string;
  kind: "model" | "deterministic" | "human";
  status: "complete" | "running" | "queued" | "failed" | "gate";
  result: string;
  latencyMs?: number;
  costInr?: number;
  tokens?: string;
  promptVersion?: string;
  inputs: string[];
  outputs: string[];
  /**
   * Validators carry their outcome rather than being a list of names. The
   * handoff drew every validator as a green tick, which on a step whose output
   * was rejected is the one lie this graph cannot afford to tell: a failed
   * validator is the reason the run escalated, and it has to look like one.
   */
  validators: { name: string; passed: boolean; detail?: string }[];
  citations: string[];
  dependsOn: string[];
}

/** A one-line result for the node face, taken from the output if it offers one. */
function readSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const record = output as Record<string, unknown>;
  if (typeof record.summary === "string" && record.summary.trim()) return record.summary;
  const keys = Object.keys(record);
  if (keys.length === 0) return null;
  return `${keys.length} field${keys.length === 1 ? "" : "s"}: ${keys.slice(0, 3).join(", ")}`;
}

function entries(value: unknown, limit: number): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .slice(0, limit)
    .map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`);
}

/**
 * One recorded step as the graph wants it.
 *
 * `kind` is derived from whether the step record names a model, because that is
 * the only thing in the record that distinguishes reasoning from arithmetic.
 * A human approval is not representable in `RunStepOut` at all, so no step from
 * this source is ever drawn as a gate — inferring one from a step called
 * "approval" would be a guess dressed as a fact.
 */
export function toStepLike(step: RunStepOut, index: number, all: RunStepOut[]): StepLike {
  const status: StepLike["status"] =
    step.status === "failed" ? "failed" : step.status === "skipped" ? "queued" : "complete";

  const previous = index > 0 ? all[index - 1] : undefined;

  return {
    id: step.id,
    name: step.name,
    tool: step.model ?? step.prompt_version ?? "",
    kind: step.model ? "model" : "deterministic",
    status,
    result:
      step.status === "skipped"
        ? "Skipped"
        : step.status === "failed"
          ? "Failed"
          : (readSummary(step.output) ?? "Complete"),
    latencyMs: step.latency_ms,
    costInr: step.cost_inr,
    tokens:
      step.input_tokens || step.output_tokens
        ? `${step.input_tokens} in · ${step.output_tokens} out`
        : undefined,
    promptVersion: step.prompt_version ?? undefined,
    // The redacted input is one blob of JSON rather than a field map, so it is
    // shown whole and clipped by the drawer rather than pulled apart here.
    inputs: step.redacted_input ? [step.redacted_input] : [],
    outputs: entries(step.output, 8),
    validators: step.validators.map((validator) => ({
      name: validator.name,
      passed: validator.result === "pass",
      detail: validator.detail,
    })),
    citations: step.citations.map(
      (citation) =>
        `${citation.document_id} · page ${citation.page}${citation.label ? ` — ${citation.label}` : ""}`,
    ),
    dependsOn: previous ? [previous.id] : [],
  };
}

export function toStepGraph(steps: RunStepOut[]): StepLike[] {
  return steps.map((step, index) => toStepLike(step, index, steps));
}

const W = 200;
// 96 in the handoff, which was drawn against its own tighter type scale. This
// codebase's body face sets four lines taller than that and the cost row fell
// off the bottom of every node.
const H = 108;
const GX = 40;
const GY = 12;

/**
 * Longest-path layering: a node sits one column right of its deepest parent.
 * Written to survive data it was not drawn for — a parent that is not in the
 * list, or a step that arrives before the one it depends on — because a layout
 * helper that throws takes the whole run page down with it.
 */
function layout(steps: StepLike[]) {
  const known = new Set(steps.map((step) => step.id));
  const layerOf: Record<string, number> = {};

  for (const step of steps) {
    const parents = step.dependsOn.filter((id) => known.has(id) && id !== step.id);
    layerOf[step.id] = parents.length
      ? Math.max(...parents.map((id) => (layerOf[id] ?? 0) + 1))
      : 0;
  }

  const depth = Math.max(0, ...Object.values(layerOf)) + 1;
  const layers: StepLike[][] = Array.from({ length: depth }, () => []);
  for (const step of steps) layers[layerOf[step.id]].push(step);

  const rows = Math.max(1, ...layers.map((layer) => layer.length));
  const pos: Record<string, { x: number; y: number }> = {};
  layers.forEach((layer, column) => {
    layer.forEach((step, row) => {
      pos[step.id] = {
        x: column * (W + GX),
        y: (row + (rows - layer.length) / 2) * (H + GY) + 16,
      };
    });
  });

  return {
    pos,
    layers,
    width: depth * (W + GX) - GX,
    height: rows * (H + GY) + 32,
  };
}

/** State colour lives on the node border and the dot, never on the surface. */
const VISUAL = {
  complete: { node: "", dot: "bg-navy", text: "text-ink-2" },
  running: { node: "gv-node-running", dot: "bg-teal animate-pulse-dot", text: "text-teal-ink" },
  queued: { node: "gv-node-queued", dot: "border-[1.5px] border-ink-4", text: "text-ink-4" },
  failed: { node: "gv-node-failed", dot: "bg-bad", text: "text-bad-ink" },
  gate: { node: "gv-node-gate", dot: "bg-white border-[1.5px] border-navy", text: "text-navy-ink" },
} as const;

// `bg-surface` is white in this codebase and a recessed grey in the handoff, so
// the deterministic marker uses `surface-3` — the grey that was drawn.
const KIND = {
  model: "bg-teal-tint text-teal-ink",
  deterministic: "bg-surface-3 text-ink-2",
  human: "bg-navy-tint text-navy-ink",
} as const;

const KIND_CHIP = {
  model: "gv-chip-teal",
  deterministic: "gv-chip-slate",
  human: "gv-chip-navy",
} as const;

export function RunGraph({
  steps,
  runId,
  title,
  /** Said plainly under the graph unless the caller has already said it. */
  note = "Drawn in recorded order. The API does not yet record which step depended on which, so this is the run's sequence rather than a dependency graph.",
}: {
  steps: StepLike[];
  runId: string;
  title?: string;
  note?: string;
}) {
  const { pos, layers, width, height } = useMemo(() => layout(steps), [steps]);
  const [selected, setSelected] = useState<string | null>(null);
  const [replayLayer, setReplayLayer] = useState<number | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Replay is motion and nothing else — it walks the run one column at a time.
  // Someone who has asked for less of it gets the button disabled and told why,
  // rather than a button that silently declines to do anything.
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // A replay left running after the page has gone is a timer holding a dead
  // component. Clearing on unmount is the whole reason this is a ref.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const replay = useCallback(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (timer.current) clearTimeout(timer.current);
    let index = 0;
    setReplayLayer(0);
    const tick = () => {
      index += 1;
      if (index >= layers.length) {
        setReplayLayer(null);
        return;
      }
      setReplayLayer(index);
      timer.current = setTimeout(tick, 800);
    };
    timer.current = setTimeout(tick, 800);
  }, [layers.length]);

  if (steps.length === 0) {
    return (
      <p className="gv-card p-6 text-center text-[13px] text-ink-3">
        No steps were recorded for this run, so there is nothing to draw.
      </p>
    );
  }

  const stateOf = (step: StepLike): StepLike["status"] => {
    if (replayLayer === null) return step.status;
    const column = layers.findIndex((layer) => layer.includes(step));
    if (column < replayLayer) return step.kind === "human" ? "gate" : "complete";
    return column === replayLayer ? "running" : "queued";
  };

  const total = steps.reduce((sum, step) => sum + (step.costInr ?? 0), 0);
  const current = steps.find((step) => step.id === selected) ?? steps[steps.length - 1];

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="gv-card min-w-0 flex-[1_1_560px] overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-line-2 px-4 py-3 text-[13px] text-ink-3">
          <span className="gv-id text-navy">{runId}</span>
          {title ? <span className="min-w-0 truncate">{title}</span> : null}
          <span className="font-mono" data-numeric="">
            {formatInr(total)}
          </span>
          <button
            type="button"
            onClick={replay}
            disabled={reducedMotion}
            title={
              reducedMotion
                ? "Replay steps through the run one column at a time. This browser is set to reduce motion, so it is switched off."
                : undefined
            }
            className="ml-auto h-[30px] rounded-[4px] border border-line-strong bg-white px-3 text-[13px] font-medium text-ink hover:border-ink-4 disabled:cursor-not-allowed disabled:text-ink-4 disabled:hover:border-line-strong"
          >
            {replayLayer === null ? "Replay run" : `Step ${replayLayer + 1} of ${layers.length}`}
          </button>
        </div>

        <div className="overflow-auto bg-surface-2 [background-image:radial-gradient(#dfe3ea_1px,transparent_1px)] [background-size:20px_20px]">
          <div className="relative mx-auto" style={{ width, height }}>
            <svg width={width} height={height} className="absolute inset-0" aria-hidden="true">
              {steps.flatMap((step) =>
                step.dependsOn.map((parentId) => {
                  const from = pos[parentId];
                  const to = pos[step.id];
                  if (!from || !to) return null;
                  const x1 = from.x + W;
                  const y1 = from.y + H / 2;
                  const x2 = to.x;
                  const y2 = to.y + H / 2;
                  const mid = (x1 + x2) / 2;
                  const state = stateOf(step);
                  return (
                    <path
                      key={`${parentId}-${step.id}`}
                      d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                      className={
                        state === "running"
                          ? "gv-edge gv-edge-live"
                          : state === "queued"
                            ? "gv-edge gv-edge-queued"
                            : "gv-edge"
                      }
                    />
                  );
                }),
              )}
            </svg>

            {steps.map((step) => {
              const state = stateOf(step);
              const visual = VISUAL[state];
              const on = step.id === current?.id;
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => setSelected(step.id)}
                  aria-pressed={on}
                  className={`gv-node absolute box-border p-2.5 ${visual.node} ${on ? "gv-node-selected" : ""}`}
                  style={{ left: pos[step.id].x, top: pos[step.id].y, width: W, height: H }}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-semibold">{step.name}</span>
                    <span
                      className={`box-border h-2 w-2 shrink-0 rounded-full ${visual.dot}`}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="block truncate font-mono text-[11px] text-ink-3">
                    {step.tool}
                  </span>
                  <span className={`mt-1.5 block truncate text-xs ${visual.text}`}>
                    {state === "running" ? "Running…" : state === "queued" ? "Queued" : step.result}
                  </span>
                  <span className="mt-1 flex justify-between font-mono text-[11px] text-ink-3">
                    <span data-numeric="">
                      {step.latencyMs ? `${(step.latencyMs / 1000).toFixed(1)}s` : ""}
                    </span>
                    <span className={`rounded-[3px] px-1 ${KIND[step.kind]}`}>{step.kind}</span>
                    <span data-numeric="">
                      {step.costInr ? formatInr(step.costInr) : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {note ? (
          <p className="border-t border-line-2 px-4 py-2.5 text-[11.5px] leading-relaxed text-ink-3">
            {note}
          </p>
        ) : null}
      </div>

      {current ? (
        <aside
          aria-label="Step detail"
          className="gv-card min-w-0 max-w-[400px] flex-[1_1_300px] p-5"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-base font-semibold">{current.name}</div>
              <div className="truncate font-mono text-xs text-ink-3">{current.tool}</div>
            </div>
            <span className={`gv-chip ${KIND_CHIP[current.kind]} text-[11px] font-semibold`}>
              {current.kind}
            </span>
          </div>

          <div className="mt-3.5 grid grid-cols-3 gap-2.5 rounded-[6px] bg-surface-2 p-3 text-xs">
            <div>
              <div className="text-ink-3">Latency</div>
              <div className="font-mono" data-numeric="">
                {current.latencyMs ? `${(current.latencyMs / 1000).toFixed(1)}s` : "—"}
              </div>
            </div>
            <div>
              <div className="text-ink-3">Cost</div>
              <div className="font-mono" data-numeric="">
                {current.costInr ? formatInr(current.costInr) : "—"}
              </div>
            </div>
            <div>
              <div className="text-ink-3">Tokens</div>
              <div className="font-mono" data-numeric="">
                {current.tokens ?? "—"}
              </div>
            </div>
          </div>

          <Section title="Input · redacted" items={current.inputs} mono muted />
          <Section title="Outputs" items={current.outputs} mono />

          {current.validators.length ? (
            <>
              <p className="gv-eyebrow mt-3.5">Validators</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {current.validators.map((validator) => (
                  <span
                    key={validator.name}
                    title={validator.detail}
                    className={`gv-chip font-mono text-[11px] ${
                      validator.passed ? "gv-chip-green" : "gv-chip-red"
                    }`}
                  >
                    {validator.passed ? "✓" : "✗"} {validator.name}
                  </span>
                ))}
              </div>
            </>
          ) : null}

          <Section title="Citations" items={current.citations} muted />

          {current.promptVersion ? (
            <p className="mt-3.5 text-xs text-ink-3">
              Prompt version <span className="font-mono">{current.promptVersion}</span> · the
              redacted input and the raw output are held in the audit record.
            </p>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

function Section({
  title,
  items,
  muted,
  mono,
}: {
  title: string;
  items: string[];
  muted?: boolean;
  mono?: boolean;
}) {
  if (!items.length) return null;
  return (
    <>
      <p className="gv-eyebrow mt-3.5">{title}</p>
      <ul
        className={`mt-1.5 max-h-44 overflow-auto pl-4 leading-relaxed ${
          mono ? "font-mono text-[11.5px]" : "text-[13px]"
        } ${muted ? "text-ink-2" : "text-ink"}`}
      >
        {items.map((item, index) => (
          <li key={`${index}-${item.slice(0, 32)}`} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </>
  );
}
