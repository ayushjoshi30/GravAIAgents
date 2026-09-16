import type { ReactNode } from "react";
import { hueStyle } from "@/components/build/blocks";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { Badge } from "@/components/ui/Badge";
import { NODE_BY_TYPE } from "@/lib/nodeCatalog";

/**
 * The hero's product visual: one agent run, drawn as a control plane.
 *
 * It is a stylised piece of UI, not a live dashboard — but every figure in it
 * is one the platform really returns. The numbers are transcribed from the
 * recorded sandbox run in `src/lib/agent-samples.json`, the same run quoted by
 * `src/lib/agent-usecase.ts`:
 *
 *   document intelligence  8 documents, 29 pages, 6 extracted / 2 digitised,
 *                          0.0% unclassified, application 18302
 *   credit appraisal       EMI ₹21,742.42, FOIR 39.7% against a 55.0% cap,
 *                          recommendation "refer"
 *   risk scoring           P(30+ DPD in 6 months) 6.58%, band AMBER, with the
 *                          published band edges at 6% and 15%
 *
 * Nothing in here moves on its own. The only motion in the system is a
 * 150-300ms transition, and a panel that animated by itself would be claiming
 * to be a live feed.
 *
 * COLOUR, AND THE THREE THINGS IT IS ALLOWED TO MEAN HERE.
 *
 *   1. An agent's own hue, taken from the generated node catalog — teal for
 *      Document Intelligence, amber for Risk, indigo for Credit Appraisal.
 *      It is never chosen in this file, so the agent that is teal here is the
 *      same agent that is teal on the catalog page, in the agents menu and on
 *      the studio canvas.
 *   2. An outcome: green proceeded, amber is risk or a rule that can reject,
 *      red stopped. That is the risk band scale and the status pills, and
 *      nothing else on this panel may borrow those three.
 *   3. The model / code channel, drawn by `ChannelMark`: teal where a language
 *      model did the reasoning, navy where deterministic code reached a fixed
 *      answer. This is the platform's central claim, so it is printed as a
 *      word and the hue only reinforces it.
 *
 * Drawing rules: every glyph is inline SVG on a 24x24 grid with 1.4-unit
 * square-capped strokes, matching `AgentIcon`. No raster asset, no chart
 * library — the band scale and the connectors are CSS and markup.
 */

const APPLICATION_ID = "18302";

/* The risk axis. RED is unbounded above 15%, so the drawing stops at 20% and
   says so in words underneath. */
const SCALE_MAX = 20;
const GREEN_MAX = 6;
const AMBER_MAX = 15;
const PROBABILITY = 6.58;

const axis = (value: number) => `${((value / SCALE_MAX) * 100).toFixed(1)}%`;

/**
 * An agent's hue, read from the catalog `scripts/gen_node_catalog.py`
 * generates. An id the catalog does not know falls back to the neutral slate
 * rather than to a colour invented here.
 */
function agentHue(id: string): string {
  return NODE_BY_TYPE[`agent.${id}`]?.hue ?? "slate";
}

type PillTone = "brand" | "pass" | "amber";

const PILL_TONE: Record<PillTone, string> = {
  brand: "border-brand-200 bg-brand-50 text-brand",
  pass: "border-pass-border bg-pass-soft text-pass",
  amber: "border-amber-border bg-amber-soft text-amber",
};

/** A status pill. The word carries the state; the colour only reinforces it. */
function StatusPill({
  tone,
  glyph,
  children,
}: {
  tone: PillTone;
  glyph: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] leading-[16px] font-medium whitespace-nowrap ${PILL_TONE[tone]}`}
    >
      <span className="flex items-center" aria-hidden="true">
        {glyph}
      </span>
      {children}
    </span>
  );
}

/**
 * Which half of the platform did this piece of work: a language model, or
 * code with a fixed answer.
 *
 * Teal against navy is the distinction the whole product is built on, so it
 * is spelled out on the busiest surface on the site rather than left for a
 * reader to infer from a shade. The label is the signal and the hue is the
 * second channel, which is also what makes it readable without colour.
 */
type Channel = "model" | "code";

/**
 * Each mark is filled with its family's `-border` step rather than its `-soft`
 * one, because a soft plate is the ground these marks land on and a chip
 * cannot be a chip against its own colour. The teal mark sits on the document
 * agent's teal well, where `-soft` was the identical value and the mark had no
 * edge at all; the navy one sits on `.gv-figure`, whose tint and `brand-50`
 * differ by about one per cent. The `-border` step separates from both, and
 * `-strong` on it still clears 4.5:1 at this size — 5.9:1 for teal, 9.2:1 for
 * navy. The risk band above uses the same step as a fill for the same reason.
 */
const CHANNEL: Record<Channel, { label: string; className: string }> = {
  model: {
    label: "Language model",
    className:
      "border-[var(--gv-hue-teal-border)] bg-[var(--gv-hue-teal-border)] text-[var(--gv-hue-teal-strong)]",
  },
  code: {
    label: "Deterministic code",
    className: "border-brand-200 bg-brand-200 text-brand-700",
  },
};

function ChannelMark({ channel }: { channel: Channel }) {
  const look = CHANNEL[channel];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded border px-1.5 py-[3px] font-mono text-[10px] font-semibold tracking-[0.04em] whitespace-nowrap ${look.className}`}
    >
      <span className="h-1.5 w-1.5 rounded-[1px] bg-current" aria-hidden="true" />
      {look.label}
    </span>
  );
}

/**
 * The agent name, its plate and its status, as one row.
 *
 * The plate is the agent's catalog hue rather than a house colour, which is
 * what lets a reader recognise the same agent three screens later.
 */
function AgentHead({
  id,
  name,
  meta,
  pill,
}: {
  id: string;
  name: string;
  meta: string;
  pill: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          style={hueStyle(agentHue(id))}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]"
        >
          <AgentIcon id={id} size={17} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-semibold text-ink">{name}</p>
          <p className="gv-micro mt-0.5 truncate font-mono">{meta}</p>
        </div>
      </div>
      {pill}
    </div>
  );
}

type Step = { label: string; value: string; done: boolean };

const STEPS: Step[] = [
  { label: "Classified against declared type", value: "8 of 8", done: true },
  { label: "Routed to extract or digitise", value: "6 / 2", done: true },
  { label: "Fields returned with a citation each", value: "29 pages", done: true },
  { label: "Unclassified after routing", value: "0.0%", done: true },
];

/**
 * The tick on a finished step, or the pip on the one still running. The check
 * glyph is what says "finished"; the plate is the agent's hue, so the four
 * steps read as belonging to the agent above them.
 */
function StepMark({ done }: { done: boolean }) {
  return (
    <span
      className={`relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-surface ${
        done
          ? "border-[var(--plate-border)] text-[var(--plate-accent)]"
          : "border-[var(--plate-accent)]"
      }`}
      aria-hidden="true"
    >
      {done ? <Icon name="check" size={11} /> : <span className="gv-pip gv-pip-brand" />}
    </span>
  );
}

/** The dashed line and arrowhead that carry the run to the next agent. */
function Connector({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      <svg
        width="14"
        height="30"
        viewBox="0 0 14 30"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="square"
        aria-hidden="true"
        focusable="false"
        className="ml-[0.4375rem] shrink-0 text-brand-300"
      >
        <path d="M7 1v20" strokeDasharray="3 3" />
        <path d="M3.5 19 7 23l3.5-4" />
      </svg>
      <span className="gv-micro">{label}</span>
    </div>
  );
}

export function HomeHeroPanel({ className }: { className?: string }) {
  return (
    <figure className={`min-w-0 ${className ?? ""}`}>
      <section
        className="gv-panel overflow-hidden"
        aria-label={`Example agent run on application ${APPLICATION_ID}`}
      >
        {/* Window chrome: the three dots come from `.gv-chrome::before`. */}
        <div className="gv-chrome">
          <span className="mr-auto min-w-0 truncate font-mono text-[11.5px] text-ink-3">
            agent run · application {APPLICATION_ID}
          </span>
          <StatusPill tone="brand" glyph={<span className="gv-pip gv-pip-brand" />}>
            Running
          </StatusPill>
        </div>

        <div className="p-4 sm:p-5">
          <AgentHead
            id="doc_intelligence"
            name="Document Intelligence Agent"
            meta="classify_documents · 8 files"
            pill={
              <StatusPill tone="pass" glyph={<Icon name="check" size={11} />}>
                Complete
              </StatusPill>
            }
          />

          {/* The step list, on a sunken plane in the agent's own hue, with a
              connection line down the ticks so the four steps read as one
              sequence rather than as four unrelated rows. */}
          <div
            style={hueStyle(agentHue("doc_intelligence"))}
            className="gv-well mt-3.5 border-[var(--plate-border)] bg-[var(--plate)] p-3.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              <p className="gv-eyebrow text-[var(--plate-strong)]">Document intelligence</p>
              <ChannelMark channel="model" />
            </div>
            <div className="relative mt-2.5">
              <span
                className="absolute top-3 bottom-3 left-[8.5px] w-px bg-[var(--plate-border)]"
                aria-hidden="true"
              />
              <ol>
                {STEPS.map((step) => (
                  <li key={step.label} className="flex items-center gap-x-2.5 py-1.5">
                    <StepMark done={step.done} />
                    <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-2">
                      {step.label}
                    </span>
                    <span
                      className="shrink-0 pl-2 text-[12.5px] font-semibold text-ink"
                      data-numeric=""
                    >
                      {step.value}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            {/* Not `.gv-micro`: its ink-3 is tuned for white and lands at
                4.3:1 on a tinted plate. The same sentence one step darker
                clears 4.5:1 on every hue in the set. */}
            <p className="mt-2.5 text-[12.5px] leading-[1.5] text-ink-2">
              6 routed to extract, 2 to digitise. Nothing failed classification.
            </p>
          </div>

          <Connector label="Handed to scoring" />

          <AgentHead
            id="risk_scoring"
            name="Risk Agent"
            meta="score_risk · scorecard-v1-illustrative"
            pill={
              <StatusPill tone="pass" glyph={<Icon name="check" size={11} />}>
                Scored
              </StatusPill>
            }
          />

          {/* The risk readout: the figure, the band, and where the figure sits
              between the two published band edges. Every colour in this block
              is semantic — green proceeded, amber is the band that refers, red
              stopped — which is exactly why no decorative hue is allowed
              anywhere near it. */}
          <div className="gv-figure mt-3.5 p-4">
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="gv-label text-ink-3">P(30+ DPD in 6 months)</span>
                  <ChannelMark channel="code" />
                </p>
                <p className="gv-metric-sm mt-1.5 text-ink" data-numeric="">
                  {PROBABILITY}%
                </p>
              </div>
              <Badge tone="amber" size="md" icon={<Icon name="warning" size={12} />}>
                AMBER band
              </Badge>
            </div>

            <div className="relative mt-4">
              <div className="flex h-2.5 gap-px overflow-hidden rounded-[3px]">
                <span className="bg-pass-border" style={{ width: axis(GREEN_MAX) }} />
                <span className="bg-amber" style={{ width: axis(AMBER_MAX - GREEN_MAX) }} />
                <span className="bg-fail-border" style={{ width: axis(SCALE_MAX - AMBER_MAX) }} />
              </div>
              <span
                className="absolute top-[-4px] bottom-[-4px] w-[2px] rounded-full bg-ink ring-2 ring-white"
                style={{ left: axis(PROBABILITY) }}
                aria-hidden="true"
              />
            </div>
            <p className="gv-micro mt-3">
              GREEN below 6% · AMBER 6% to 15% · RED above 15%. Banded by a versioned
              scorecard, never by a language model.
            </p>
          </div>
        </div>

        {/* The same run's credit figures, as the panel's footer strip. */}
        <div className="border-t border-line bg-surface-2">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 sm:px-5">
            <p className="flex min-w-0 items-center gap-2">
              <span
                style={hueStyle(agentHue("credit_appraisal"))}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] border border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]"
              >
                <AgentIcon id="credit_appraisal" size={13} />
              </span>
              <span className="gv-micro truncate">Credit Appraisal Agent · same run</span>
            </p>
            <Badge tone="amber" dot>
              Refer to an underwriter
            </Badge>
          </div>
          <dl className="grid grid-cols-1 border-t border-line sm:grid-cols-2">
            <div className="px-4 py-3 sm:px-5">
              <dt className="gv-label text-ink-3">Proposed EMI</dt>
              <dd className="mt-1 text-[16px] font-semibold text-ink" data-numeric="">
                ₹21,742.42
              </dd>
            </div>
            <div className="border-t border-line px-4 py-3 sm:border-t-0 sm:border-l sm:px-5">
              <dt className="gv-label text-ink-3">FOIR</dt>
              <dd className="mt-1 text-[16px] font-semibold text-ink" data-numeric="">
                39.7%{" "}
                <span className="text-[12.5px] font-medium text-ink-3">of a 55.0% cap</span>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <figcaption className="gv-micro mt-3">
        A stylised view of one recorded run, not a live dashboard. Every figure shown is one
        the agents return.
      </figcaption>
    </figure>
  );
}
