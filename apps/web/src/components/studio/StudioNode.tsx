"use client";

/**
 * How a node looks on the canvas.
 *
 * The visual job is to answer four questions at a glance, because these are the
 * ones a person actually has while looking at a workflow:
 *
 *   - what kind of thing is this?          the coloured plate, before the
 *     title has been read
 *   - what does it do?                     the registry's own sentence
 *   - does it reason or does it compute?   the chip, because that is the
 *     difference between a figure you can rely on and prose you cannot
 *   - is anything wrong with it?           a red border and a marker, before
 *     it is ever run
 *
 * A branching node is drawn as a diamond rather than a card, with its branches
 * named beside the points they leave from, so a connection cannot be made
 * without saying which outcome it follows. Making that a property to fill in
 * afterwards is how branches end up unconnected.
 *
 * TWO COLOUR CHANNELS, AND ONLY ONE OF THEM IS A CLAIM.
 *
 * The plate carries the node's hue, taken from the generated catalog. That is
 * identity, not meaning: it says "this is the KYC agent" faster than the title
 * can be read, and across a canvas of twenty nodes it is what makes the shape
 * of a workflow legible at a zoom where no text is.
 *
 * The thing that actually matters in a lending workflow — did a language model
 * produce this figure, or did code — is printed as a word. Every node carries a
 * chip reading "model", "code" or "human", teal or navy behind it — or, for a
 * type this build has never heard of, "unknown" in the palette's neutral, since
 * a console that guesses at that question is worse than one that admits to it.
 *
 * HOW THE TWO CHANNELS WERE KEPT FROM FIGHTING: the catalog gives a few nodes a
 * teal or a navy hue of their own (MCP Tool is teal, Document Source is navy), so on
 * those the plate and the claim would say different things if the plate were
 * the claim. It never is, here or on the sketchpad — the plate is a soft wash
 * with no word on it, and the claim is a word in a bordered pill directly
 * beneath the title. A word beats a wash, so the claim wins by construction
 * rather than by the plate being suppressed, and the MCP Tool's teal plate
 * cannot be misread when the chip under it says "code" in navy.
 *
 * The Human Approval node no longer takes the solid navy fill this canvas used
 * to give it. Navy here means "code decided", and a human gate is the one step
 * where a person does, so that fill was quietly making the opposite of the
 * claim it was reaching for — and it was also the only signal, which a reader
 * who cannot separate navy from white never had. It now takes its catalog hue
 * like every other node, says "human" in the chip, and prints the registry's
 * own caveat: "A genuine halt: the run ends as `awaiting_approval` rather than
 * continuing." That is three signals where there was one, and none of them is
 * a colour on its own. The `.gv-node-gate` rule still exists in the theme for
 * the run graph; this file simply no longer asks for it.
 */

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AgentIcon, Icon, type IconName } from "@/components/icons/AgentIcon";
import type { CSSProperties } from "react";
import { hueStyle } from "@/components/build/blocks";
import { NODE_BY_TYPE } from "@/lib/nodeCatalog";

/** The node type the engine uses for a step that hands the decision to a person. */
export const GATE_TYPE = "human_approval";

export interface StudioNodeData {
  label: string;
  type: string;
  /**
   * True when running this node calls the language model.
   *
   * This — not `deterministic` — is the distinction the chip makes, because it
   * is the thing the claim is about: a model reasoned, or code decided.
   *
   * Undefined is a third and honest state rather than a missing boolean. The
   * console fetches its library from the API, so a node type that neither the
   * API nor the generated catalog knows arrives with nothing to say here, and
   * the chip has to say that rather than pick one of the two claims.
   */
  usesLlm?: boolean;
  summary?: string;
  /** The registry's own statement of what this node cannot do. Printed unsoftened. */
  caveat?: string;
  branches?: string[];
  problems?: { severity: "error" | "warning"; message: string }[];
  trace?: {
    status: "ok" | "running" | "failed" | "skipped" | "halted" | "queued";
    durationMs?: number;
    costInr?: number;
  };
  [key: string]: unknown;
}

/**
 * A node's place in the twelve-family categorical palette.
 *
 * SLATE IS THE REAL FALLBACK, NOT A THEORETICAL ONE. The console fetches its
 * node library from the API, which is deployed separately from this front end
 * and may know node types that were added after `lib/nodeCatalog.ts` was last
 * generated. Such a node must still draw: it takes the palette's neutral, so it
 * reads as uncoloured rather than borrowing some other node's identity, and its
 * title, its type and its plate letter still say exactly what it is. Inventing
 * a hue for it — hashing the type into the palette, say — would put a node in a
 * family the engine never placed it in, which is the kind of quiet fiction this
 * product exists to avoid.
 */
export function hueOf(type: string): string {
  return NODE_BY_TYPE[type]?.hue ?? "slate";
}

/**
 * The plate, in the node's own hue. Shared by the canvas and the node rail so
 * the two cannot drift: a node looks the same before it is placed as after.
 *
 * WHY THE COLOUR COMES THROUGH CUSTOM PROPERTIES. Tailwind builds its
 * stylesheet by reading the source for complete class names, so
 * `bg-${hue}-soft` produces no style at all — the class is assembled in the
 * browser, long after the stylesheet was written, and the failure is silent. A
 * lookup of literal class strings per hue would compile, but it is a second
 * copy of the hue mapping that goes stale the first time a node is added. So
 * the class name is constant, `bg-[var(--plate)]`, and the varying part is set
 * inline by `hueStyle` — the same helper the sketchpad's nodes use, imported
 * rather than reimplemented so there is one answer to this and not two.
 *
 * The size is inline for the same reason: it is a prop, so it cannot be a class.
 */
export function NodePlate({
  type,
  label,
  size = 26,
}: {
  type: string;
  label: string;
  size?: number;
}) {
  const catalog = NODE_BY_TYPE[type];
  const agentId = type.startsWith("agent.") ? type.slice("agent.".length) : "";
  const glyph = Math.round(size * 0.62);

  return (
    <span
      aria-hidden="true"
      style={{ ...hueStyle(hueOf(type)), width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center rounded-[6px] border border-[var(--plate-border)] bg-[var(--plate)]"
    >
      {agentId ? (
        <AgentIcon id={agentId} size={glyph} className="text-[var(--plate-accent)]" />
      ) : catalog ? (
        // Cast rather than guarded: `Icon` draws a generic mark for a name it
        // does not know, so an icon added to the registry after this catalog was
        // generated degrades to a placeholder instead of throwing.
        <Icon name={catalog.icon as IconName} size={glyph} className="text-[var(--plate-accent)]" />
      ) : (
        // No catalog entry, so no artwork to draw. The node's own initial is the
        // one honest mark available — it is the label the API sent, not a guess
        // at what kind of node this is. `--plate-strong` is the step that holds
        // contrast for text sitting on the soft plate.
        <span
          className="font-display font-bold text-[var(--plate-strong)]"
          style={{ fontSize: Math.round(size * 0.46) }}
        >
          {((label || type).trim().charAt(0) || "?").toUpperCase()}
        </span>
      )}
    </span>
  );
}

/**
 * Model, code, a person — or, where this build does not know, that.
 *
 * These two hues are the only ones on this canvas that are a claim rather than
 * a label, so they are fixed rather than taken from the node's own hue: teal
 * means a language model reasoned inside this step, navy means code reached a
 * fixed answer. The text is what carries it; the colour only agrees with the
 * text, which is why the chip still reads correctly in grayscale.
 *
 * A human gate is neither, and colouring it navy would enlist "code decided"
 * for the one step where a person does. It takes the node's own hue instead —
 * violet, from the catalog — so teal and navy keep meaning exactly one thing
 * each.
 */
export function KindChip({ type, usesLlm }: { type: string; usesLlm?: boolean }) {
  const gate = type === GATE_TYPE;

  /* Neither the API's library nor the generated catalog has heard of this node
     type, so nothing in this build may claim it either way. "Code" would have
     been the more dangerous of the two guesses: navy is this palette's promise
     that a figure was reached by deterministic code, and printing that over
     what may equally have been model output is the one mistake a lending
     console cannot make. Slate and the word "unknown" say what is actually
     known, which is nothing, and the card's own sentence says the same thing
     at greater length directly below. */
  const unknown = !gate && usesLlm === undefined;

  const tone = gate
    ? "border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-strong)]"
    : unknown
      ? "border-[var(--gv-hue-slate-border)] bg-[var(--gv-hue-slate-soft)] text-[var(--gv-hue-slate-strong)]"
      : usesLlm
        ? "border-[var(--gv-hue-teal-border)] bg-[var(--gv-hue-teal-soft)] text-[var(--gv-hue-teal-strong)]"
        : "border-[var(--gv-hue-navy-border)] bg-[var(--gv-hue-navy-soft)] text-[var(--gv-hue-navy-strong)]";

  const word = gate ? "human" : unknown ? "unknown" : usesLlm ? "model" : "code";
  const said = gate
    ? " — a person decides this step"
    : unknown
      ? " — this build cannot say whether a language model reasons in this step"
      : usesLlm
        ? " — a language model reasons in this step"
        : " — code decides this step";

  return (
    <span
      /* Only the gate needs the node's hue; the other two tones are literal
         tokens, so the custom properties are set only where they are read. */
      style={gate ? hueStyle(hueOf(type)) : undefined}
      className={`inline-flex flex-none items-center rounded-full border px-1.5 py-px text-[9.5px] font-semibold tracking-[0.06em] uppercase ${tone}`}
    >
      {word}
      {/* The chip is one word wide and the distinction is the point of the
          product, so the ears get the whole sentence rather than the shorthand. */}
      <span className="sr-only">{said}</span>
    </span>
  );
}

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

/** The dot-and-word a run leaves on a node. Shared by both shapes. */
function TraceLine({ node }: { node: StudioNodeData }) {
  const trace = node.trace ? TRACE[node.trace.status] : null;
  if (!trace) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${trace.cls}`}>
      <span className={`h-[7px] w-[7px] rounded-full ${trace.dot}`} aria-hidden="true" />
      {trace.label}
    </span>
  );
}

/** The `!` a problem hangs on a node, carrying its message in the title. */
function ProblemMark({ node }: { node: StudioNodeData }) {
  const error = node.problems?.find((problem) => problem.severity === "error");
  const warning = node.problems?.find((problem) => problem.severity === "warning");
  const problem = error ?? warning;
  if (!problem) return null;
  return (
    <span
      title={problem.message}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${
        error ? "bg-bad" : "bg-warn"
      }`}
    >
      !<span className="sr-only">{`${error ? "Error" : "Warning"}: ${problem.message}`}</span>
    </span>
  );
}

/** What a run cost, printed only once there is a run to print it from. */
function CostLine({ node }: { node: StudioNodeData }) {
  if (node.trace?.durationMs === undefined) return null;
  return (
    <span className="ml-auto font-mono text-[10.5px] text-ink-3" data-numeric="">
      {node.trace.durationMs < 1000
        ? `${node.trace.durationMs}ms`
        : `${(node.trace.durationMs / 1000).toFixed(1)}s`}
      {node.trace.costInr ? ` · ₹${node.trace.costInr.toFixed(2)}` : ""}
    </span>
  );
}

/**
 * The registry's own limitation, where it states one.
 *
 * Amber is the reserved risk hue doing the job it is reserved for: this is the
 * platform saying, before the node is ever run, that it cannot do the whole of
 * what its name implies. The sentence is the engine's, printed unsoftened.
 */
function Caveat({ text }: { text: string }) {
  return (
    <p className="mx-3 mb-2 rounded-[4px] border border-amber-border bg-amber-soft px-2 py-1.5 text-[10.5px] leading-[1.4] text-amber-strong">
      {text}
    </p>
  );
}

function StudioNodeImpl({ data, selected }: NodeProps) {
  // React Flow types node data as an open record, so the shape is asserted here
  // rather than in the signature: a component typed on the narrower props is no
  // longer assignable to `NodeTypes`, which is what `NODE_TYPES` has to satisfy.
  const node = data as StudioNodeData;

  const error = node.problems?.some((problem) => problem.severity === "error");
  const isInput = node.type === "input";
  const isOutput = node.type === "output";

  const state = error
    ? "gv-node-failed"
    : selected
      ? "gv-node-selected"
      : node.trace?.status === "running"
        ? "gv-node-running"
        : "";

  return (
    <div
      // The card's edge carries the node's own hue, as the reference does.
      //
      // The icon plate alone was doing all the colour work, which is a 26px
      // square on a 228px card: enough to tell you what a node is once you are
      // reading it, not enough to tell you from across a graph of fifteen. The
      // border is the largest thing on a card that can be tinted without
      // turning the card itself into a colour field and making the text on it
      // harder to read.
      //
      // `state` still wins. A failed, selected or running node gets its border
      // from `gv-node-*`, declared after this rule, so the hue never obscures
      // the three states that actually change what someone does next — which
      // is the whole reason the palette is allowed to exist at all.
      // `--node-edge` rather than a border utility: see the note on `.gv-node`
      // in gravai-theme.css for why the difference matters. In short, a utility
      // would outrank the failed and selected states and paint over them.
      style={{ ...hueStyle(hueOf(node.type)), "--node-edge": "var(--plate-border)" } as CSSProperties}
      className={`gv-node w-[228px] box-border select-none ${state} ${
        node.trace?.status === "skipped" ? "gv-node-skipped" : ""
      }`}
      data-node-type={node.type}
      data-status={node.trace?.status ?? "idle"}
    >
      {!isInput ? <Handle type="target" position={Position.Left} style={TARGET_HANDLE} /> : null}

      <div className="flex items-start gap-2.5 px-3 pt-2.5 pb-2">
        <NodePlate type={node.type} label={node.label} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-ink">{node.label}</span>
          {/* The coarse category, in the reference's own grey, replacing two
              heavier things that used to sit here.
              
              It printed the engine's full type — `agent.doc_intelligence` — in
              mono, and then a bordered MODEL/CODE chip on the row below. Both
              were defensible and together they were too much furniture: three
              lines of chrome above a two-line description, on a card whose job
              is to be recognised at a glance while someone reads the graph.
              
              The full type is not lost. It is the `title` here, so it is one
              hover away, and it is on the element as `data-node-type`, which is
              what the config panel, the trace and every error message key
              against. Someone who needs the exact string is someone already
              working on that node, and they have the panel open.
              
              WHAT THE WORD SAYS. `model` means a language model reasons in this
              step; `code` means it reaches a fixed answer. That distinction is
              the platform's central claim, so it keeps a word of its own rather
              than being folded into the hue — the hue says which node this is,
              not whether it thinks. */}
          <span
            className="block truncate text-[10.5px] text-ink-3"
            title={node.type}
          >
            {node.usesLlm ? "model" : "code"}
          </span>
        </span>
        <ProblemMark node={node} />
      </div>

      {/* Only rendered when a run has something to say. An empty strip of
          padding under every node on an idle canvas is 8px of nothing, fifteen
          times over. */}
      {node.trace || node.cost ? (
        <div className="flex items-center gap-1.5 px-3 pb-2">
          <TraceLine node={node} />
          <CostLine node={node} />
        </div>
      ) : null}

      {node.summary ? (
        <p className="border-t border-line-2 px-3 py-[7px] text-[11.5px] leading-snug text-ink-2">
          {node.summary}
        </p>
      ) : null}

      {node.caveat ? <Caveat text={node.caveat} /> : null}

      {!isOutput ? (
        <Handle type="source" position={Position.Right} className="gv-handle" style={SOURCE_HANDLE} />
      ) : null}
    </div>
  );
}

/**
 * A branch point.
 *
 * The diamond is drawn as an SVG rather than a rotated box so the text under it
 * stays upright and legible. Each branch gets its own handle at its own point
 * of the diamond, with the branch's name printed beside that point — which is
 * what makes the two outputs tellable apart before either is connected, and
 * tellable apart without colour once they are.
 */
function StudioBranchNodeImpl({ data, selected }: NodeProps) {
  const node = data as StudioNodeData;
  const branches = node.branches ?? [];
  const error = node.problems?.some((problem) => problem.severity === "error");

  /* The diamond's own points, in node coordinates. The right point takes the
     first branch and the bottom point the second, which is why a two-way split
     reads as a split; a third and beyond stack down the right edge. A Condition
     has exactly two and a Router has as many as its configuration declares. */
  const point = (index: number) =>
    index === 0
      ? { x: 126, y: 60 }
      : index === 1
        ? { x: 66, y: 114 }
        : { x: 126, y: 60 + (index - 1) * 22 };

  /* A Router declares as many branches as its configuration lists, so the head
     grows to hold them rather than letting the third one land on the title. */
  const headHeight = branches.length > 2 ? 60 + (branches.length - 1) * 22 + 18 : 132;

  /* Selection, a failure and a run in progress are all shown as a thicker and
     differently coloured edge rather than a colour change alone, so the state
     is still visible to someone who cannot separate the base hue from navy. */
  const outline = error
    ? "var(--gv-fail)"
    : selected
      ? "var(--gv-brand)"
      : node.trace?.status === "running"
        ? "var(--gv-accent)"
        : "var(--plate-border)";
  const outlineWidth = error || selected || node.trace?.status === "running" ? 3 : 2;

  return (
    <div
      className={`w-[204px] select-none ${node.trace?.status === "skipped" ? "opacity-50" : ""}`}
      /* The four hue properties are set once at the top of the node, because
         here the SVG below reads them through `fill`/`stroke` as well as the
         plate class does — `fill="var(--plate)"` resolves a custom property the
         same way a background does. */
      style={hueStyle(hueOf(node.type))}
      data-node-type={node.type}
      data-status={node.trace?.status ?? "idle"}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="gv-handle"
        style={{
          width: 12,
          height: 12,
          left: 0,
          top: 54,
          right: "auto",
          bottom: "auto",
          transform: "none",
        }}
      />

      <div className="relative w-[204px]" style={{ height: headHeight }}>
        <svg
          width="132"
          height="120"
          viewBox="0 0 132 120"
          className="absolute top-0 left-0 block"
          role="img"
          /* The shape itself is the information a sighted reader gets and a
             screen reader would not: this node splits the run. The name and the
             type are already in the text below, and every edge carries its own
             branch name, so the description says only what the drawing adds. */
          aria-label={`Branch point${
            branches.length > 0 ? `, splitting into ${branches.join(" and ")}` : ""
          }`}
        >
          <polygon
            points="66,6 126,60 66,114 6,60"
            fill="var(--plate)"
            stroke={outline}
            strokeWidth={outlineWidth}
          />
        </svg>

        <span
          className="pointer-events-none absolute top-[48px] left-[54px] text-[var(--plate-accent)]"
          aria-hidden="true"
        >
          <Icon name={(NODE_BY_TYPE[node.type]?.icon ?? "activity") as IconName} size={24} />
        </span>

        {/* The branch names, printed at the points their edges leave from.
            This is what keeps the two outputs distinguishable without relying
            on the edge tint: the name is on the diamond whether or not the
            branch has been connected, and whether or not it has ever run. */}
        {branches.map((branch, index) => {
          const at = point(index);
          return (
            <span
              // Keyed by position, not by name: the engine treats two branches
              // with the same label as an error, and this canvas is where that
              // mistake is made and corrected, so it has to survive drawing it.
              key={`${index}-${branch}`}
              className="absolute max-w-[64px] truncate rounded-[3px] border border-line bg-surface px-1 font-mono text-[10px] leading-[14px] text-ink-2"
              style={{ left: at.x + 11, top: at.y - 7 }}
            >
              {branch}
            </span>
          );
        })}

        {branches.map((branch, index) => {
          const at = point(index);
          return (
            <Handle
              key={`${index}-${branch}`}
              id={branch}
              type="source"
              position={index === 1 ? Position.Bottom : Position.Right}
              className="gv-handle"
              title={`${branch} branch`}
              style={{
                width: 12,
                height: 12,
                left: at.x - 6,
                top: at.y - 6,
                right: "auto",
                bottom: "auto",
                transform: "none",
              }}
              data-branch={branch}
            />
          );
        })}
      </div>

      <div className="flex items-center justify-center gap-1.5">
        <span className="truncate text-center text-[13px] font-semibold text-ink">{node.label}</span>
        <ProblemMark node={node} />
      </div>
      <p className="truncate text-center font-mono text-[10.5px] text-ink-3">{node.type}</p>

      <p className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
        {/* A Condition and a Router are both code with a fixed answer, but the
            diamond says nothing about that on its own, so it carries the same
            chip a card does rather than being the one shape whose rule you have
            to already know. */}
        <KindChip type={node.type} usesLlm={node.usesLlm} />
        <TraceLine node={node} />
      </p>

      {/* The registry's sentence, on a diamond exactly as on a card. A branch
          point is the node a reader most needs explained, and there is nowhere
          else on the canvas it is written. */}
      {node.summary ? (
        <p className="mt-1 text-center text-[11px] leading-[1.4] text-ink-2">{node.summary}</p>
      ) : null}

      {/* A caveat belongs to the node, not to the shape it is drawn as. No
          branching node in today's registry carries one, but dropping it for
          one of the two shapes is how a limitation the engine states quietly
          stops being stated. */}
      {node.caveat ? (
        <p className="mt-1 rounded-[4px] border border-amber-border bg-amber-soft px-2 py-1 text-center text-[10px] leading-[1.35] text-amber-strong">
          {node.caveat}
        </p>
      ) : null}
    </div>
  );
}

export const StudioNode = memo(StudioNodeImpl);
export const StudioBranchNode = memo(StudioBranchNodeImpl);

export const NODE_TYPES = { studio: StudioNode, studioBranch: StudioBranchNode };
