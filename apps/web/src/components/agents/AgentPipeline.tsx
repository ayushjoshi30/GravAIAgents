"use client";

/**
 * An animated explanation of what one agent actually does — a run, not a list.
 *
 * Every stage drawn here is read from the agent catalog's own `detail` — its
 * declared inputs, the tools it is allowed to call, the AI capabilities it
 * consumes and the top-level keys of its output contract. Nothing is written
 * out by hand.
 *
 * That constraint is the whole point. A hand-drawn diagram per agent, or a
 * recorded screen capture, is a second description of the system that starts
 * accurate and goes quietly wrong the first time an agent gains a tool — and a
 * diagram nobody can tell is stale is worse than no diagram, because it is
 * believed. Rendering from the catalog means the picture is wrong only when the
 * catalog is wrong, and the catalog is what the API, the MCP surface and the
 * docs site already read.
 *
 * It is drawn rather than filmed for the same reason: a video would be an asset
 * to re-record, it would not respond to a reduced-motion preference, a screen
 * reader could not read it, and it would cost a megabyte to say what a few
 * hundred bytes of markup says.
 *
 * WHAT THE ANIMATION IS FOR. It used to light the stages in turn, which said
 * "there are stages" and little else. It now walks one run end to end: the
 * inputs are taken up, a mark crosses the rail into each stage, the stage holds
 * it for as long as that kind of work deserves, the run reaches the agent's own
 * escalation check, and it leaves either as the output contract alone or as the
 * output contract AND a decision handed to a person. Someone who watches one
 * cycle should be able to say what the agent does without reading a word, and
 * every moving thing answers "what is happening here" rather than decorating
 * the panel. Nothing shimmers, because on a credit product a surface that
 * shimmers for its own sake reads as unserious.
 *
 * THE ONE THING THE COLOUR MEANS: teal is the language model thinking; navy is
 * deterministic code. This is the platform's central claim — that a probability
 * comes from a versioned scorecard and only the sentence around it comes from a
 * model — so the picture has to make that visible at a glance rather than
 * asserting it in prose underneath. Green and amber appear at exactly one place
 * in the drawing, the two exits, where they mean an outcome: proceeded, or
 * handed to a person. The travelling mark itself is neutral ink on purpose —
 * it is the unit of work in transit, and colouring it teal or navy would have
 * it making a claim about compute it is not doing.
 *
 * WHERE THE AGENT'S OWN COLOUR IS ALLOWED. The panel's frame, its header bar,
 * its icon plate and its heading take the agent's hue from the generated node
 * catalog, so the page reads as that agent's page and the panel matches the
 * card the reader clicked to get here. The hue stops at the diagram's edge. A
 * third family inside the drawing would cost the reader the only distinction
 * the drawing exists to make.
 *
 * WHY THE HUE IS SET AS CUSTOM PROPERTIES RATHER THAN CLASSES. Tailwind builds
 * its stylesheet by reading the source for complete class names, so
 * `border-${hue}-border` produces no style at all — the class is assembled in
 * the browser long after the stylesheet was written, and the failure is silent.
 * `hueStyle` is the project's answer: constant class names reading constant
 * custom properties, whose values vary. It is imported rather than
 * reimplemented so the marketing card, the studio node and this panel resolve a
 * hue the same way.
 *
 * It was written for the console and now also runs on the public site, at the
 * top of every /agents/[id] page and once on the /agents index. That move is
 * what the `specLink` prop, the drawn transport mark and the reduced-motion
 * check below are for: a logged-in operator will forgive a control that is
 * merely terse, but a prospective customer reading an auditability claim will
 * not forgive an interface that overstates itself, and a pause button over a
 * picture that was never moving is exactly that kind of small untruth.
 */

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { hueStyle } from "@/components/build/blocks";
import type { Agent, AgentDetail } from "@/lib/agents";
import { NODE_BY_TYPE } from "@/lib/nodeCatalog";

/** One stage on the rail. */
interface Stage {
  label: string;
  /** The full text, for the title attribute — nothing is lost, only shortened. */
  full: string;
  /** True when a language model or another AI capability does this work. */
  model: boolean;
}

/**
 * Shorten a catalog string to something that fits a pill.
 *
 * Cuts where these strings put their qualifier — an opening parenthesis, an
 * opening brace, a comma, a spaced dash — rather than at a character count that
 * would slice a word in half. The untouched original always travels along in
 * `title`, so shortening never loses anything.
 *
 * `[` is deliberately NOT a cut point. Output keys are spelled
 * `documents[].type`, `documents[].confidence`, `documents[].route`; cutting at
 * the bracket collapses all of them to the word "documents" and the Produces
 * column becomes the same word five times, which looks like a rendering bug and
 * tells the reader nothing.
 */
function shorten(text: string, cap = 30): string {
  const head = text.split(/[({]|,| — /)[0].trim() || text.trim();
  return head.length > cap ? `${head.slice(0, cap - 1).trimEnd()}…` : head;
}

/**
 * The callable part of a `tools` entry, or null when the entry is prose.
 *
 * Entries are not uniform. Most are a plain id (`docai.extract`). Some name a
 * family in one string (`telephony.place / answer / stream / transfer`), so the
 * test has to be on the FIRST token rather than the whole string — otherwise a
 * real tool is dismissed as prose and drawn as "deterministic code", which
 * mislabels a telephony call as local computation. One is a module path with a
 * parenthetical, and one agent has no tools at all and says so in a sentence.
 */
function toolId(text: string): string | null {
  const first = text.trim().split(/\s+/)[0] ?? "";
  const callable = /^[\w./-]+$/.test(first) && /[./]/.test(first);
  return callable ? first : null;
}

/** `gravai_agents/risk_scoring/model.py` reads better as `model.py` on a pill. */
function toolLabel(id: string): string {
  return id.includes("/") ? (id.split("/").pop() ?? id) : id;
}

function stagesFor(agent: Agent): Stage[] {
  const detail = agent.detail;
  const stages: Stage[] = [];

  for (const service of detail.aiServices ?? []) {
    if (!service.trim()) continue;
    stages.push({ label: shorten(service, 22), full: service, model: true });
  }

  for (const tool of detail.tools ?? []) {
    if (!tool.trim()) continue;
    const id = toolId(tool);
    if (id) {
      stages.push({ label: shorten(toolLabel(id), 22), full: tool, model: false });
    } else {
      // Prose in the tools list means the work is done in code with no external
      // call — one agent's entry is literally "None beyond stored extractions".
      // Saying so is more useful than dropping the entry on the floor.
      stages.push({ label: "deterministic code", full: tool, model: false });
    }
  }

  // Five is as many as reads at a glance; the rest are counted, never hidden.
  return stages.slice(0, 5);
}

/**
 * Whether the catalog says this agent escalates on EVERY run rather than on a
 * condition — which changes what the animation is allowed to show.
 *
 * Credit Appraisal is the case that matters: its only escalation trigger is
 * "Always — a credit decision requires underwriter approval by design", and its
 * output contract names the field "escalate (always true)". Alternating a
 * clearing cycle with an escalating one would therefore draw a run that agent
 * cannot have, which is the one kind of mistake a page about auditability
 * cannot make. So the two catalog statements are both read, and either one is
 * enough: an agent that says "always" anywhere only ever takes the branch to a
 * person.
 *
 * This reads the catalog's wording rather than a flag because the catalog has
 * no flag. If one is ever added, this function is the single place that has to
 * change, and until then it fails in the safe direction — an agent whose
 * phrasing this does not recognise is drawn as conditional, which is what every
 * other agent in the catalog genuinely is.
 */
function alwaysEscalates(detail: AgentDetail): boolean {
  const byTrigger = (detail.escalateWhen ?? []).some((when) => /^always\b/i.test(when.trim()));
  const byContract = (detail.outputKeys ?? []).some((key) =>
    /^escalate\b[^)]*always true/i.test(key.trim()),
  );
  return byTrigger || byContract;
}

/* -------------------------------------------------------------------------
   The run, as a list of beats.
   ------------------------------------------------------------------------- */

/**
 * How long each kind of beat is held, in milliseconds.
 *
 * THESE ARE READING BEATS, NOT MEASURED LATENCIES, AND NONE OF THEM IS EVER
 * PRINTED. A model call really is a longer, heavier thing than reading a field
 * out of a stored extraction, and a picture where both get the same beat says
 * they are the same kind of work — so the rhythm carries a true distinction.
 * But the platform's own timings live in the recorded sandbox run behind
 * `lib/agent-usecase.ts`, they differ per agent, and a number invented here to
 * look plausible would be exactly the fabrication this product exists to avoid.
 * So the beats shape the animation and never appear as a figure: the only
 * numbers on this panel are counts taken from the catalog.
 */
const BEAT = {
  /** Before the first cycle, so the panel's first paint is the still diagram. */
  leadIn: 500,
  intake: 750,
  /** Crossing one connector between two stages. */
  transit: 300,
  /** A language model or another AI capability doing the work. */
  model: 1400,
  /** A tool call or local computation with a fixed answer. */
  code: 800,
  /** The agent's own escalation check, resolving. */
  verdict: 550,
  emit: 1000,
  handover: 1150,
  /** The pause between cycles, so the loop is a demonstration and not a drum. */
  rest: 1600,
} as const;

interface Frame {
  at: "intake" | "transit" | "stage" | "verdict" | "emit" | "handover" | "rest";
  /**
   * For `stage`, which stage. For `transit`, the stage being entered — and
   * `stages.length` means the mark is crossing into the escalation check.
   */
  index: number;
  /**
   * How many stages the run has REACHED, which is what draws the trail behind
   * the mark. A stage counts itself the moment the mark arrives rather than
   * when it leaves, because the connector the mark has just crossed is crossed
   * — counting on departure left the trail a beat behind the mark, so a stage
   * could sit lit with a grey connector leading into it.
   */
  done: number;
  /** The output contract has been written and is leaving. */
  returns: boolean;
  /** The decision has gone to a person. */
  person: boolean;
  ms: number;
}

/**
 * One frame list covering every cycle the loop plays, laid out once and then
 * simply indexed.
 *
 * Both cycles live in the SAME array rather than being regenerated when the
 * branch changes, because a list that rebuilds mid-loop is a list whose length
 * changes under the timer, and the modulo that wraps the loop would then skip
 * or repeat a beat at the seam. Flattened, advancing the run is `(step + 1) %
 * frames.length` and nothing else.
 */
function framesFor(stages: Stage[], cycles: boolean[]): Frame[] {
  const frames: Frame[] = [];

  for (const escalating of cycles) {
    const last = stages.length;
    frames.push({ at: "intake", index: -1, done: 0, returns: false, person: false, ms: BEAT.intake });

    stages.forEach((stage, index) => {
      frames.push({ at: "transit", index, done: index, returns: false, person: false, ms: BEAT.transit });
      frames.push({
        at: "stage",
        index,
        // Reached, not completed — see `done` above. The pill is drawn from
        // `live` first, so counting itself here costs it nothing while it works
        // and leaves it correctly behind the mark afterwards.
        done: index + 1,
        returns: false,
        person: false,
        ms: stage.model ? BEAT.model : BEAT.code,
      });
    });

    // The last connector runs from the final stage into the escalation check,
    // so it exists even for an agent with no drawn stages at all.
    frames.push({ at: "transit", index: last, done: last, returns: false, person: false, ms: BEAT.transit });
    frames.push({ at: "verdict", index: -1, done: last, returns: false, person: false, ms: BEAT.verdict });

    // The output contract is written on EVERY run, including one that
    // escalates — `escalate` is a field in that contract, not an alternative to
    // it. Drawing the handover as a path the output does not take would be a
    // tidier picture and a false one, so the escalating cycle lights the
    // returning exit first and then takes the branch to a person as well.
    frames.push({ at: "emit", index: -1, done: last, returns: true, person: false, ms: BEAT.emit });
    if (escalating) {
      frames.push({ at: "handover", index: -1, done: last, returns: true, person: true, ms: BEAT.handover });
    }
    frames.push({ at: "rest", index: -1, done: last, returns: true, person: escalating, ms: BEAT.rest });
  }

  return frames;
}

/* -------------------------------------------------------------------------
   The parts of the drawing.
   ------------------------------------------------------------------------- */

/**
 * The two claim colours, as complete class strings.
 *
 * Written out in full rather than assembled, for the same reason the hue goes
 * through a custom property: Tailwind cannot build a class name from a value
 * decided at runtime. These are chosen by a boolean the catalog supplies, so a
 * literal pair is safe here where an interpolated hue would not be.
 */
const TONE = {
  model: {
    rest: "border-teal-tint bg-white text-teal-ink",
    live: "border-teal bg-white text-teal-ink shadow-[0_0_0_3px_var(--color-teal-tint)]",
    done: "border-teal-tint bg-teal-tint text-teal-ink",
    dot: "bg-teal",
    bar: "bg-teal",
  },
  code: {
    rest: "border-line-2 bg-white text-ink-2",
    live: "border-navy bg-white text-navy-ink shadow-[0_0_0_3px_var(--color-navy-tint)]",
    done: "border-navy-line bg-navy-tint text-navy-ink",
    dot: "bg-navy-mid",
    bar: "bg-navy-mid",
  },
} as const;

/** The travelling mark, in px. Its width is subtracted from a connector's own. */
const MARK = 6;

/**
 * A connector between two stages, and the mark crossing it.
 *
 * The mark moves on a CSS transition rather than a keyframe, which is what lets
 * the beat length be a value rather than a stylesheet constant: the element is
 * always mounted at the left of its connector, and when the connector becomes
 * the live one React commits a new transform that the browser interpolates over
 * exactly the beat this step is worth. It also means a reader who has asked for
 * less motion is covered twice over — the global reduced-motion rule collapses
 * every transition, and the timer that would drive this never starts.
 */
function Connector({
  live,
  passed,
  ms,
  playing,
  width,
}: {
  live: boolean;
  /** The run has already crossed this connector in the current cycle. */
  passed: boolean;
  ms: number;
  playing: boolean;
  width: number;
}) {
  return (
    <span
      aria-hidden="true"
      className="relative flex shrink-0 items-center"
      style={{ width, height: 16 }}
    >
      <span
        className={`h-px w-full transition-colors duration-300 ${passed ? "bg-ink-4" : "bg-line-2"}`}
      />
      <span
        className="absolute top-1/2 left-0 rounded-full bg-ink-2"
        style={{
          width: MARK,
          height: MARK,
          opacity: live ? 1 : 0,
          transform: `translate(${live ? width - MARK : 0}px, -50%)`,
          // Only the transform transitions. The mark has to APPEAR at the start
          // of its connector rather than fade in from the middle of the last
          // one, so opacity is left to snap.
          transitionProperty: "transform",
          transitionTimingFunction: "linear",
          transitionDuration: live && playing ? `${ms}ms` : "0ms",
        }}
      />
    </span>
  );
}

/**
 * One stage, and the bar that shows how long the run is held by it.
 *
 * The bar is the dwell made visible. A model step and a field check look
 * identical as two lit pills; they do not look identical as two bars filling at
 * different speeds, and the difference between the two is the thing this
 * diagram is for. It fills in the stage's own claim colour, so the bar says
 * "this is a model working" and "this is code working" as well as "this is
 * taking longer".
 */
function Pill({
  stage,
  live,
  passed,
  ms,
  playing,
}: {
  stage: Stage;
  live: boolean;
  passed: boolean;
  ms: number;
  playing: boolean;
}) {
  const tone = stage.model ? TONE.model : TONE.code;

  return (
    <span
      title={stage.full}
      data-model={stage.model}
      className={`relative z-10 flex shrink-0 items-center gap-1.5 overflow-hidden rounded-[6px] border px-2 py-1 text-[11px] leading-tight whitespace-nowrap transition-[border-color,background-color,color,box-shadow] duration-200 ${
        live ? tone.live : passed ? tone.done : tone.rest
      }`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
      {stage.label}
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 bottom-0 h-[2px] origin-left ${tone.bar}`}
        style={{
          transform: live ? "scaleX(1)" : "scaleX(0)",
          transitionProperty: "transform",
          transitionTimingFunction: "linear",
          transitionDuration: live && playing ? `${ms}ms` : "0ms",
        }}
      />
    </span>
  );
}

/**
 * A person, drawn here because the interface set has no such mark.
 *
 * The nearest thing in it is `inbox`, which is where a handover ends up rather
 * than who it goes to, and the distinction matters on this panel: these agents
 * are advisory by design and the human in the loop is a feature of the product,
 * not an exception path. Same rules as every other icon in the codebase — a
 * 24-unit grid, a 1.4 stroke, square caps, no fill, `currentColor` — and the
 * shoulders are the same curve `AgentGlyph` uses for the KYC portrait, so the
 * person on this diagram and the person on the catalog card are one drawing.
 */
function PersonMark({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M15.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0" />
      <path d="M4.5 20c0-4.2 3.3-6.5 7.5-6.5s7.5 2.3 7.5 6.5" />
    </svg>
  );
}

/** The two exits, and the bracket that splits the run between them. */
function Branch({
  escalates,
  outputCount,
  returns,
  person,
  compact,
}: {
  escalates: boolean;
  outputCount: number;
  returns: boolean;
  person: boolean;
  compact: boolean;
}) {
  const fields = `${outputCount} field${outputCount === 1 ? "" : "s"}`;
  const exit =
    "flex h-5 items-center gap-1.5 rounded-[6px] border px-2 text-[11px] leading-none whitespace-nowrap transition-[border-color,background-color,color] duration-300";
  // Green is "it proceeded" and amber is "a person has it": the outcome
  // vocabulary, used at the only two places on this diagram where there is an
  // outcome to report. Neither appears anywhere else in the drawing.
  const returnTone = returns
    ? "border-pass-border bg-pass-soft text-green-ink"
    : "border-line-2 bg-white text-ink-3";
  const personTone = person
    ? "border-amber-border bg-amber-soft text-amber-strong"
    : "border-line-2 bg-white text-ink-3";

  // An agent the catalog gives no escalation trigger has one exit, and drawing
  // a fork it never takes would invent a branch. None of the fourteen is like
  // this today; the case exists so that adding such an agent draws a true
  // picture rather than an empty second arm.
  if (!escalates) {
    return (
      <span aria-hidden="true" className="flex shrink-0 items-center">
        <span className={`h-px w-4 ${returns ? "bg-ink-4" : "bg-line-2"}`} />
        <span className={`${exit} ${returnTone}`}>
          returns{compact ? "" : ` ${fields}`}
        </span>
      </span>
    );
  }

  return (
    <span aria-hidden="true" className="flex shrink-0 items-stretch">
      {/* The bracket. 44 units tall because the two exits below are 20 each
          with a 4 gap between them, so each arm meets its own exit rather than
          pointing vaguely at the pair. */}
      <svg
        width={16}
        height={44}
        viewBox="0 0 16 44"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="square"
        strokeLinejoin="miter"
        className="shrink-0 self-center"
      >
        <path d="M0 22h7" className={returns || person ? "stroke-ink-4" : "stroke-line-2"} />
        <path d="M7 22V11h9" className={returns ? "stroke-pass" : "stroke-line-2"} />
        <path d="M7 22v11h9" className={person ? "stroke-amber" : "stroke-line-2"} />
      </svg>
      <span className="flex flex-col justify-center gap-1">
        <span className={`${exit} ${returnTone}`}>returns{compact ? "" : ` ${fields}`}</span>
        <span className={`${exit} ${personTone}`}>
          <PersonMark size={11} />
          to a person
        </span>
      </span>
    </span>
  );
}

function Column({
  eyebrow,
  items,
  align = "left",
  lit,
  stagger,
  row,
  more,
}: {
  eyebrow: string;
  items: { label: string; full: string }[];
  align?: "left" | "right";
  /**
   * True once the run has reached this column: the inputs have been taken up,
   * or the output contract has been written. At rest the column is simply
   * there, which is what a column of catalog entries is.
   */
  lit: boolean;
  /**
   * Bring the items up one after another rather than together. Outputs are
   * written as the run finishes and reading them arrive in order says so;
   * inputs are handed over at once and staggering them would imply a sequence
   * the catalog does not claim.
   */
  stagger?: boolean;
  /** Lay the items out in a wrapping row rather than a column. */
  row?: boolean;
  /**
   * Catalog entries this column is not drawing.
   *
   * The rail already counts its dropped stages out loud. The columns did not,
   * so a compact panel showed three of Document Intelligence's eight output
   * keys with nothing to say the other five existed — a short list that reads
   * as a complete one. Counting them is the same rule the rail follows: an
   * entry may be too long to draw, but it may never be made to disappear.
   */
  more?: number;
}) {
  if (items.length === 0) return null;
  return (
    <div className={`min-w-0 ${!row && align === "right" ? "text-right" : ""}`}>
      <p className="gv-eyebrow mb-1.5">{eyebrow}</p>
      <ul className={row ? "flex flex-wrap gap-1" : "grid gap-1"}>
        {items.map((item, index) => (
          <li
            key={`${item.label}-${index}`}
            title={item.full}
            // The border is present at every state and merely changes colour,
            // because a border that appears on arrival would move the text by a
            // pixel on every cycle and a diagram that twitches is a diagram
            // nobody trusts.
            className={`rounded-[4px] border px-1.5 py-1 text-[11px] leading-tight transition-[border-color,background-color,color] duration-300 ${
              row ? "max-w-full truncate" : "truncate"
            } ${lit ? "border-line-strong bg-white text-ink" : "border-transparent bg-surface-2 text-ink-2"}`}
            style={stagger ? { transitionDelay: lit ? `${index * 70}ms` : "0ms" } : undefined}
          >
            {item.label}
          </li>
        ))}
      </ul>
      {more && more > 0 ? <p className="mt-1 text-[10.5px] text-ink-3">and {more} more</p> : null}
    </div>
  );
}

/**
 * The play / pause mark, drawn here rather than taken from the interface set.
 *
 * That set has neither shape, and the nearest thing in it — the close cross —
 * reads as "dismiss this panel" rather than "stop the animation". On a card in
 * the console that ambiguity cost a click; on a public page the panel is the
 * first thing a reader is asked to trust, and a control that looks like a
 * dismiss button is a bad first impression of a product whose whole pitch is
 * that it does what it says. Same rules as every other icon here: a 24-unit
 * grid, a 1.4 stroke, square caps, no fill, `currentColor`.
 */
function TransportMark({ paused }: { paused: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      {paused ? (
        <path d="M7 4l13 8-13 8z" />
      ) : (
        <>
          <path d="M9 5v14" />
          <path d="M15 5v14" />
        </>
      )}
    </svg>
  );
}

export function AgentPipeline({
  agent,
  compact = false,
  specLink = true,
}: {
  agent: Agent;
  compact?: boolean;
  /**
   * Whether to offer the "full spec" link out to /agents/[id].
   *
   * The detail page mounts this panel at the top of itself, and a link from a
   * page to the page you are already on is noise at best and, for anyone
   * navigating by link list, a dead end that looks like a mistake.
   */
  specLink?: boolean;
}) {
  const detail = agent.detail;
  const headingId = useId();

  /**
   * The agent's hue, from the GENERATED node catalog.
   *
   * Looked up rather than chosen, so the panel wears the same colour as the
   * agent's catalog card, its node on the studio canvas and its block in the
   * sketchpad — one agent, one colour, everywhere. `lib/nodeCatalog.ts` is
   * generated from the engine's own registry and a test fails if the two
   * disagree; picking a colour here would be a second, unguarded answer to a
   * question that already has one. The fallback is the palette's neutral, so an
   * agent this build's catalog has never heard of reads as uncoloured rather
   * than borrowing some other agent's identity.
   */
  const hue = NODE_BY_TYPE[`agent.${agent.id}`]?.hue ?? "slate";

  /**
   * The run, planned once per agent.
   *
   * `agent` is an entry in a module-level array, so this is computed on mount
   * and never again — which matters because the frame list is the timer's
   * dependency, and a list rebuilt on every render would restart the run on
   * every render.
   */
  const plan = useMemo(() => {
    const stages = stagesFor(agent);
    const triggers = agent.detail.escalateWhen ?? [];
    // Two cycles for a conditional agent, so the reader sees both the run that
    // clears and the run that goes to a person; one cycle where the catalog
    // admits only one of those outcomes.
    const cycles = triggers.length === 0 ? [false] : alwaysEscalates(agent.detail) ? [true] : [false, true];
    return { stages, frames: framesFor(stages, cycles), escalates: triggers.length > 0 };
  }, [agent]);

  const { stages, frames, escalates } = plan;

  // Fourteen cards animating at once would drain a battery to show work nobody
  // is looking at, so an off-screen card stops. But the default is ON, and the
  // observer only ever turns it OFF.
  //
  // That direction matters. Starting at false and waiting for the observer to
  // grant permission means that anywhere the callback does not arrive — and it
  // does not arrive in every embedded browser — the explainer is silently
  // static forever, with no error and nothing to debug. Defaulting to on makes
  // the observer a battery optimisation that can fail harmlessly, rather than a
  // gate the feature depends on.
  const [offScreen, setOffScreen] = useState(false);
  const [wanted, setWanted] = useState(true);

  /**
   * A reduced-motion preference must STOP the animation, not slow it.
   *
   * It is asked here, in JavaScript, because the motion is driven from
   * JavaScript and a stylesheet cannot reach a timer. The global reduced-motion
   * rule in `globals.css` already collapses every transition on the page, which
   * covers the mark and the dwell bars; this covers the thing that moves them,
   * and it covers the control. A play/pause button over a picture that was
   * never moving is an interface making a claim about itself that is not true,
   * and this panel's entire argument is that the product does not do that.
   *
   * There is no SMIL anywhere in this file and there must not be: an `<animate>`
   * element ignores both the stylesheet and this check, and it is the one source
   * of motion that would survive a reader asking for none.
   */
  const [stillness, setStillness] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  /**
   * Where the run has got to. -1 is "not started", which is also the first
   * paint: the panel appears as the complete still diagram and only then begins
   * to move, so nothing is lit before the preference below has been read.
   */
  const [step, setStep] = useState(-1);

  useEffect(() => {
    // Guarded because this also renders during static export, and because some
    // embedded browsers ship a `window` without `matchMedia`. Failing to find
    // the preference leaves the animation on, which is the CSS default too.
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStillness(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const node = host.current;
    if (!node || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => setOffScreen(!entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "120px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const playing = !offScreen && wanted && !stillness;

  // Asking for less motion does not pause the run where it stands, it unwinds
  // it: a frozen half-run would leave one stage lit and one exit taken, which
  // is a claim about a particular run rather than a picture of the agent. The
  // reader's own pause button is the opposite and freezes deliberately, because
  // that is what pausing means.
  useEffect(() => {
    if (stillness) setStep(-1);
  }, [stillness]);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const ms = step < 0 ? BEAT.leadIn : (frames[step]?.ms ?? BEAT.rest);
    const timer = window.setTimeout(() => {
      setStep((current) => (current + 1) % frames.length);
    }, ms);
    return () => window.clearTimeout(timer);
  }, [playing, step, frames]);

  const frame = step >= 0 ? frames[step] : undefined;
  const reached = frame?.done ?? 0;
  const returns = frame?.returns ?? false;
  const person = frame?.person ?? false;
  // The inputs stay taken up for the whole of a cycle and are released during
  // the pause, so the loop visibly starts over rather than blurring into the
  // cycle before it.
  const inputsLit = frame !== undefined && frame.at !== "rest";

  const inputs = (detail.inputs ?? []).map((text) => ({ label: shorten(text, 26), full: text }));
  const outputKeys = detail.outputKeys ?? [];
  const outputs = outputKeys
    .slice(0, compact ? 3 : 5)
    .map((text) => ({ label: shorten(text, 26), full: text }));
  const outputsHidden = Math.max(0, outputKeys.length - outputs.length);

  /**
   * The census counts what the CATALOG DECLARES, not what the rail found room
   * to draw.
   *
   * Those are not the same number. The rail stops at five stages, and because
   * the AI capabilities are laid down before the tools, an agent with several
   * of each loses its TOOL stages first — so counting the drawn pills told the
   * voice collections panel it had "1 code step" when its catalog entry names
   * five tools, and told the onboarding assistant it had two when it declares
   * four. Understating how much of an agent is deterministic code is precisely
   * the claim this panel exists to make correctly, so the chips are counted
   * from the catalog and the rail's own "and N more steps" line reconciles the
   * two: the chips total the drawn stages plus that remainder.
   *
   * Blank entries are dropped on both sides of the subtraction because
   * `stagesFor` drops them too. Counting them in only one place would print
   * "and 1 more step" for an empty string that can never be shown.
   */
  const declaredModel = (detail.aiServices ?? []).filter((service) => service.trim()).length;
  const declaredCode = (detail.tools ?? []).filter((tool) => tool.trim()).length;
  const hidden = Math.max(0, declaredModel + declaredCode - stages.length);

  // A connector is shorter on a narrow card for the same reason the labels are:
  // the constraint is the width of the CARD, not of the window.
  const connector = compact ? 14 : 22;

  // The sentence a screen reader gets. It has to carry the same information the
  // picture does, which means naming the stages rather than saying "a diagram",
  // and naming both exits rather than only the one a sighted reader happens to
  // catch the animation taking.
  //
  // It names the stages in FULL rather than in the shortened form on the pills.
  // The pills are shortened because a pill is a fixed width; a sentence is not,
  // and the reader who most needs this sentence is the one who cannot hover a
  // pill to see the `title` that carries the rest of the string.
  //
  // It also has to admit the truncation. The rail draws at most five stages and
  // prints "and N more steps" beside them, but `role="img"` hides that line
  // along with the rest of the subtree — so without this clause the voice
  // collections panel read out five stages and gave no sign that four more
  // existed, which is a more confident claim than the sighted reader gets.
  //
  // The escalation clause QUOTES the catalog entry after a colon, for the same
  // two reasons the visible strip below does. It used to splice the entry into
  // "On a run where …" with its first letter lowercased, and that fix was made
  // to the strip and missed here — so the strip read "Hands over to a person
  // when: Always — a credit decision requires underwriter approval by design"
  // while a screen reader was told "on a run where always — …", which turns the
  // one agent that escalates on EVERY run into a conditional. It also names the
  // remaining conditions by count, because the strip does and a reader who
  // cannot see the strip must not come away believing there is only one.
  const description =
    `${agent.name} pipeline. Takes ${inputs.length} input${inputs.length === 1 ? "" : "s"}. ` +
    `Then: ${stages.map((s) => `${s.full}${s.model ? " (an AI capability)" : " (deterministic code)"}`).join(", ") || "no declared stages"}. ` +
    (hidden > 0 ? `${hidden} further stage${hidden === 1 ? " is" : "s are"} declared but not drawn. ` : "") +
    `It then returns ${outputKeys.length} output field${outputKeys.length === 1 ? "" : "s"}. ` +
    (escalates
      ? `It hands over to a person when: ${detail.escalateWhen[0]}` +
        (detail.escalateWhen.length > 1
          ? `, and in ${detail.escalateWhen.length - 1} other case${detail.escalateWhen.length > 2 ? "s" : ""}`
          : "") +
        ". On such a run the output contract still returns; the decision goes to a person as well."
      : "It does not escalate.");

  return (
    <div
      ref={host}
      // The agent's own hue, reaching the frame, the header and the heading
      // through four custom properties set once here. It stops at the diagram,
      // which keeps teal and navy the only colours making a claim inside it.
      style={hueStyle(hue)}
      className="gv-panel overflow-hidden border-[var(--plate-border)]"
      role="group"
      aria-labelledby={headingId}
    >
      {/* The agent's colour as a SOLID RULE AND A SOLID PLATE, never as a wash
          across the header.

          A wash was the first attempt and it broke rule 2 on three of the
          fourteen. The generated catalog gives Risk amber, MSME Underwriting
          green and Case Allocation rose, and `--gv-hue-amber-soft` and
          `--gv-amber-soft` are not merely similar, they are the same value — so
          on the Risk page a tinted header and the amber escalation strip below
          the diagram were literally the same colour, one meaning "this is the
          Risk agent" and the other meaning "a person has to look at this". A
          tinted field is the one form the hue must not take here, because it is
          the form an outcome takes. Saturated colour in a 3px rule and a filled
          icon plate says whose page this is at least as loudly and cannot be
          mistaken for a verdict. */}
      <span aria-hidden="true" className="block h-[3px] w-full bg-[var(--plate-accent)]" />

      {/* The header WRAPS rather than letting anything in it truncate.
          Everything on this row is short and load-bearing — whose panel this
          is, how many of its steps are a model and how many are code, and the
          control that stops the motion — and the heading was the item that gave
          way, so a 375px page read "H…" beside two chips. Second line, all of
          it legible, is the better trade at every width. `ml-auto` on the right
          group keeps it against the edge on a single line and keeps it there
          when it takes a line of its own. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-[var(--plate-border)] bg-white px-3 py-2">
        <span className="gv-icon-plate gv-icon-plate-sm shrink-0 border-[var(--plate-accent)] bg-[var(--plate-accent)] text-white">
          <AgentIcon id={agent.id} size={14} />
        </span>
        <p id={headingId} className="gv-eyebrow shrink-0 whitespace-nowrap text-[var(--plate-strong)]">
          How it works
          {/* Fourteen panels on the console grid, and now one on the public
              index beside a page full of other headings, all labelled "How it
              works". Sighted readers tell them apart by the icon and the name
              beside them; this is the same disambiguation for anyone moving
              through the page by region or by label. */}
          <span className="sr-only"> — {agent.name}</span>
        </p>

        <span className="ml-auto flex items-center gap-2">
          {/* The diagram answers "what does this do" at a glance. The full
              specification — its rules, its evaluation gates, every condition
              that sends it to a person — is a page of prose, and belongs on a
              page rather than on a card in a grid of fourteen. */}
          {/* Shown only on the wide card. `sm:` would be the wrong test again —
              it asks about the window when the constraint is the card, and a
              250px card in a three-up grid has no room for it whatever the
              monitor is doing. */}
          {compact || !specLink ? null : (
            <Link
              href={`/agents/${agent.id}`}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--plate-strong)] hover:underline"
              title={`The full specification for ${agent.name}`}
            >
              Full spec
              <Icon name="external" size={10} />
            </Link>
          )}

          {/* The two chips are the diagram's legend as well as its census: the
              teal one names the colour the model steps are drawn in and the
              navy one names the colour the code steps are drawn in, so the
              claim the picture makes is also written down rather than left to a
              colour a colour-blind reader cannot separate. Only the teal chip
              survives on a narrow card, where the whole header is about the
              width of the two of them.

              EACH CHIP IS WITHDRAWN WHEN ITS COUNT IS ZERO, and the teal one
              needs that as much as the navy one. The Account Aggregator agent
              declares no AI capabilities at all — it is the one agent in the
              catalog that is entirely deterministic — and an unguarded teal
              chip put the words "0 model steps" on its page in the very colour
              that means a model is reasoning, which is a legend for something
              the drawing below does not contain. A chip that has to be read as
              a denial of itself is worse than no chip. */}
          {declaredModel === 0 ? null : (
            <span
              className="gv-chip gv-chip-teal"
              title="Stages this agent declares where an AI capability does the work, rather than deterministic code"
            >
              {declaredModel} model {declaredModel === 1 ? "step" : "steps"}
            </span>
          )}
          {compact || declaredCode === 0 ? null : (
            <span
              className="gv-chip gv-chip-navy"
              title="Stages this agent declares where deterministic code reaches a fixed answer"
            >
              {declaredCode} code {declaredCode === 1 ? "step" : "steps"}
            </span>
          )}

          {/* Withdrawn, not disabled, when the reader has asked for less
              motion: there is genuinely nothing to pause, and a disabled
              control is a puzzle rather than an answer. Focus styling comes
              from the global `:focus-visible` rule, so the button is reachable
              and visibly focused without anything local. */}
          {stillness ? null : (
            <button
              type="button"
              onClick={() => setWanted((value) => !value)}
              aria-label={
                wanted
                  ? `Pause the ${agent.name} pipeline animation`
                  : `Play the ${agent.name} pipeline animation`
              }
              // No `aria-pressed`. The label already changes with the state,
              // and a toggle that announces "Pause the animation, pressed" is
              // telling the reader two contradictory things at once — the label
              // names the action the button will take, the state names the one
              // it is in. One or the other; the label is the more useful here.
              className="rounded-[4px] p-1 text-[var(--plate-strong)] hover:bg-surface-2"
            >
              <TransportMark paused={!wanted} />
            </button>
          )}
        </span>
      </div>

      <div
        role="img"
        aria-label={description}
        // Three columns only when there is room for three columns.
        //
        // This is driven by `compact` — which the card sets from whether it is
        // open — and NOT by a `sm:` breakpoint. A viewport breakpoint asks how
        // wide the window is; the question here is how wide the CARD is, and a
        // collapsed card in a three-up grid is about 250px no matter how large
        // the monitor. Using `sm:` squeezed a three-column diagram into a third
        // of the page and truncated every label to three characters.
        className={`bg-white ${
          compact
            ? "grid gap-2.5 p-3"
            : "grid gap-3 p-3 min-[900px]:grid-cols-[minmax(0,0.8fr)_minmax(0,1.7fr)_minmax(0,0.8fr)] min-[900px]:items-center"
        }`}
        data-playing={playing}
      >
        <Column eyebrow="Reads" items={inputs} lit={inputsLit} row={compact} />

        <div className="relative py-2">
          {/* The rail. Each list item is one connector and the stage it feeds,
              kept together so a line break can never leave a connector dangling
              at the end of a row pointing at nothing. */}
          <ol
            className={`relative flex flex-wrap items-center gap-y-2 ${
              compact ? "justify-start" : "justify-center"
            }`}
          >
            {stages.length === 0 ? (
              <li className="rounded-[6px] border border-line-2 bg-white px-2 py-1 text-[11px] text-ink-3">
                no declared stages
              </li>
            ) : (
              stages.map((stage, index) => (
                <li key={`${stage.label}-${index}`} className="flex shrink-0 items-center">
                  <Connector
                    live={frame?.at === "transit" && frame.index === index}
                    passed={index < reached}
                    ms={BEAT.transit}
                    playing={playing}
                    width={connector}
                  />
                  <Pill
                    stage={stage}
                    live={frame?.at === "stage" && frame.index === index}
                    passed={index < reached}
                    ms={stage.model ? BEAT.model : BEAT.code}
                    playing={playing}
                  />
                </li>
              ))
            )}

            <li className="flex shrink-0 items-center">
              <Connector
                live={frame?.at === "transit" && frame.index === stages.length}
                // The last connector is tested against the frame rather than
                // against the stage count, because an agent whose stages are
                // all undrawable would otherwise have a count of zero and this
                // connector would read as travelled from the first beat of the
                // cycle — a trail behind a mark that has not set off.
                passed={frame?.at === "verdict" || returns}
                ms={BEAT.transit}
                playing={playing}
                width={connector}
              />
              <Branch
                escalates={escalates}
                outputCount={outputKeys.length}
                returns={returns}
                person={person}
                compact={compact}
              />
            </li>
          </ol>

          {hidden > 0 ? (
            <p className="mt-1.5 text-center text-[10.5px] text-ink-3">
              and {hidden} more {hidden === 1 ? "step" : "steps"}
            </p>
          ) : null}
        </div>

        <Column
          eyebrow="Produces"
          items={outputs}
          align="right"
          lit={returns}
          stagger
          row={compact}
          more={outputsHidden}
        />
      </div>

      {escalates ? (
        <p
          // AMBER, NOT NAVY. This strip used to take the brand's navy tint, and
          // navy inside a GravAI diagram means deterministic code reached a
          // fixed answer — which is the opposite of what a handover is. Amber is
          // the outcome vocabulary's middle term: not cleared, not stopped,
          // someone has to look. It is the same amber the escalating exit on the
          // rail lights, so the branch and the sentence explaining it are
          // visibly one thing.
          className="flex items-start gap-2 border-t border-amber-border bg-amber-soft px-3 py-2 text-[11.5px] leading-relaxed text-amber-strong transition-[box-shadow] duration-300"
          // An inset rule down the leading edge marks the beat where the run
          // actually takes this branch. It is inset so that arriving at the
          // strip costs no layout, and it is a second signal on top of the exit
          // pill rather than the only one, so a reader who never sees the
          // animation still has the sentence.
          style={{ boxShadow: person ? "inset 3px 0 0 0 var(--color-amber)" : undefined }}
          title={detail.escalateWhen.join("\n")}
        >
          {/* Solid amber behind the mark, not another wash. The strip's own
              ground is `amber-soft`, which on an amber-hued agent is the same
              value the panel's plate resolves to; a saturated block is the one
              thing no hue in this palette produces at this size, so the reader
              can tell an outcome from an identity at a glance on all fourteen
              pages. The design system allows a state colour on a chip, a dot, a
              bar or a border, which this is. */}
          <span
            aria-hidden="true"
            className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] bg-amber text-white"
          >
            <PersonMark size={12} />
          </span>
          <span className="min-w-0">
            {/* The escalation condition is quoted, not paraphrased.

                It used to run through `shorten`, which is right for a pill and
                wrong for a sentence: it cuts at the first comma, brace or
                spaced dash, which is exactly where these entries put the
                substance. "Any threat, third-party disclosure or
                misrepresentation is detected" became "any threat", and the
                credit appraisal agent — whose entry is "Always — a credit
                decision requires underwriter approval by design" — rendered as
                "hands over to a person when always", which says nothing and
                looks like a bug. Understating a guardrail on the page that
                exists to state the guardrails is the one failure this panel
                cannot afford.

                The lowercasing went with it. It was there to splice the entry
                into a sentence, but it lowercased the whole string, not the
                first letter: "Account Aggregator" (the RBI-licensed entity,
                not a description) became "account aggregator" and "the PSI
                threshold" became "psi". Ending the lead-in with a colon means
                the catalog's own capitalisation survives untouched. */}
            <strong className="font-semibold">Hands over to a person when:</strong>{" "}
            {detail.escalateWhen[0]}
            {detail.escalateWhen.length > 1
              ? ` — and in ${detail.escalateWhen.length - 1} other case${detail.escalateWhen.length > 2 ? "s" : ""}`
              : ""}
            .
          </span>
        </p>
      ) : null}
    </div>
  );
}
