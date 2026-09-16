"use client";

/**
 * How a node looks on the canvas.
 *
 * The visual job is to answer three questions at a glance, because these are
 * the ones a person actually has while looking at a workflow:
 *
 *   - what does this do?                   the label and the plate
 *   - does it reason or does it compute?   the kind, because that is the
 *     difference between a figure you can rely on and prose you cannot
 *   - is anything wrong with it?           a red border and a marker, before
 *     it is ever run
 *
 * A branching node draws one output handle per branch, labelled, so a
 * connection cannot be made without saying which outcome it follows. Making
 * that a property to fill in afterwards is how branches end up unconnected.
 */

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AgentIcon } from "@/components/icons/AgentIcon";

export interface StudioNodeData {
  label: string;
  type: string;
  deterministic: boolean;
  summary?: string;
  branches?: string[];
  /** A node that hands the decision to a person. Drawn in navy, never teal. */
  gate?: boolean;
  problems?: { severity: "error" | "warning"; message: string }[];
  trace?: {
    status: "ok" | "running" | "failed" | "skipped" | "halted" | "queued";
    durationMs?: number;
    costInr?: number;
  };
  [key: string]: unknown;
}

/**
 * `bg-surface` is white in this codebase and a recessed grey in the handoff, so
 * the deterministic plate and chip use `surface-3` — the grey that was drawn.
 */
const KIND = {
  model: { chip: "bg-teal-tint text-teal-ink", plate: "bg-teal-tint text-teal-ink", mark: "AI" },
  deterministic: { chip: "bg-surface-3 text-ink-2", plate: "bg-surface-3 text-ink-2", mark: "=" },
  human: { chip: "bg-navy-tint text-navy-ink", plate: "bg-navy text-white", mark: "☺" },
} as const;

const TRACE = {
  ok: { label: "ok", cls: "text-ok", dot: "bg-ok" },
  running: { label: "running", cls: "text-teal", dot: "bg-teal animate-pulse-dot" },
  failed: { label: "failed", cls: "text-bad", dot: "bg-bad" },
  skipped: { label: "skipped · branch not taken", cls: "text-ink-4", dot: "bg-ink-4" },
  halted: { label: "halted · awaiting approval", cls: "text-navy", dot: "bg-navy" },
  queued: { label: "queued", cls: "text-ink-4", dot: "bg-ink-4" },
} as const;

/* Handles are styled inline rather than with utilities. React Flow ships its
   own `.react-flow__handle` rule, and the only Tailwind answer to it is the
   important modifier — whose spelling changed between Tailwind 3 and 4, so the
   leading-`!` classes this file used before generated nothing and the handles
   have quietly been React Flow's defaults. An inline style beats a class
   without depending on which spelling the compiler accepts. */
const TARGET_HANDLE = {
  width: 12,
  height: 12,
  left: -7,
  top: 22,
  background: "var(--color-ink-4)",
  border: "2px solid #fff",
} as const;

const SOURCE_HANDLE = { right: -7, top: 22 } as const;

function StudioNodeImpl({ data, selected }: NodeProps) {
  // React Flow types node data as an open record, so the shape is asserted here
  // rather than in the signature: a component typed on the narrower props is no
  // longer assignable to `NodeTypes`, which is what `NODE_TYPES` has to satisfy.
  const node = data as StudioNodeData;

  const kind = node.gate ? "human" : node.deterministic ? "deterministic" : "model";
  const k = KIND[kind];
  const error = node.problems?.find((problem) => problem.severity === "error");
  const warning = node.problems?.find((problem) => problem.severity === "warning");
  const trace = node.trace ? TRACE[node.trace.status] : null;

  const state = error
    ? "gv-node-failed"
    : selected
      ? "gv-node-selected"
      : node.trace?.status === "running"
        ? "gv-node-running"
        : kind === "human"
          ? "gv-node-gate"
          : "";

  const isInput = node.type === "input";
  const isOutput = node.type === "output";
  const isAgent = node.type.startsWith("agent.");

  /* The gate's tint is applied separately from the border state, because a
     selected gate is still a gate: folding the two together turned a selected
     one back into an ordinary white node. */
  return (
    <div
      className={`gv-node w-[228px] box-border select-none ${state} ${
        kind === "human" ? "bg-navy-tint text-navy-ink" : ""
      } ${node.trace?.status === "skipped" ? "gv-node-skipped" : ""}`}
      data-node-type={node.type}
      data-status={node.trace?.status ?? "idle"}
    >
      {!isInput ? <Handle type="target" position={Position.Left} style={TARGET_HANDLE} /> : null}

      <div className="flex items-start gap-2.5 px-3 pt-2.5 pb-2">
        {/* The plate carries the kind's colour. For an agent node it also carries
            that agent's own artwork, which this codebase already draws and which
            says more in the same 26px than the letters "AI" do. */}
        <span
          className={`inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px] font-display text-[13px] font-bold ${k.plate}`}
        >
          {isAgent ? (
            <AgentIcon id={node.type.slice("agent.".length)} size={16} />
          ) : (
            k.mark
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[13px] font-semibold ${
              kind === "human" ? "text-navy-ink" : "text-ink"
            }`}
          >
            {node.label}
          </span>
          <span className="block truncate font-mono text-[10.5px] text-ink-3">{node.type}</span>
        </span>
        {error || warning ? (
          <span
            title={(error ?? warning)!.message}
            className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${
              error ? "bg-bad" : "bg-warn"
            }`}
          >
            !
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 px-3 pb-2">
        <span className={`rounded-[3px] px-1.5 text-[10px] font-semibold ${k.chip}`}>{kind}</span>
        {trace ? (
          <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${trace.cls}`}>
            <span className={`h-[7px] w-[7px] rounded-full ${trace.dot}`} aria-hidden="true" />
            {trace.label}
          </span>
        ) : null}
        {node.trace?.durationMs !== undefined ? (
          <span className="ml-auto font-mono text-[10.5px] text-ink-3" data-numeric="">
            {node.trace.durationMs < 1000
              ? `${node.trace.durationMs}ms`
              : `${(node.trace.durationMs / 1000).toFixed(1)}s`}
            {node.trace.costInr ? ` · ₹${node.trace.costInr.toFixed(2)}` : ""}
          </span>
        ) : null}
      </div>

      {node.summary ? (
        <p className="border-t border-line-2 px-3 py-[7px] text-[11.5px] leading-snug text-ink-2">
          {node.summary}
        </p>
      ) : null}

      {node.branches?.length ? (
        <div className="border-t border-line-2">
          {node.branches.map((branch) => (
            <div
              key={branch}
              className="relative flex items-center justify-end px-3 py-[5px] font-mono text-[10.5px] text-ink-2"
            >
              {branch}
              <Handle
                id={branch}
                type="source"
                position={Position.Right}
                className="gv-handle"
                style={{ top: "50%", right: -7 }}
                data-branch={branch}
              />
            </div>
          ))}
        </div>
      ) : !isOutput ? (
        <Handle
          type="source"
          position={Position.Right}
          className="gv-handle"
          style={SOURCE_HANDLE}
        />
      ) : null}
    </div>
  );
}

export const StudioNode = memo(StudioNodeImpl);

export const NODE_TYPES = { studio: StudioNode };
