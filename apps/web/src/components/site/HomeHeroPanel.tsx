import type { ReactNode } from "react";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { Badge } from "@/components/ui/Badge";

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

/** The agent name, its plate and its status, as one row. */
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
        <span className="gv-icon-plate gv-icon-plate-solid gv-icon-plate-sm">
          <AgentIcon id={id} size={16} />
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

/** The tick on a finished step, or the pip on the one still running. */
function StepMark({ done }: { done: boolean }) {
  return (
    <span
      className={`relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-surface ${
        done ? "border-brand-200 text-brand" : "border-brand-300"
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

          {/* The step list, on a sunken plane, with a connection line down the
              ticks so the four steps read as one sequence. */}
          <div className="gv-well mt-3.5 p-3.5">
            <p className="gv-eyebrow">Document intelligence</p>
            <div className="relative mt-2.5">
              {/* The connection line down the ticks: one sequence, not four
                  unrelated rows. */}
              <span
                className="absolute top-3 bottom-3 left-[8.5px] w-px bg-line-strong"
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
            <p className="gv-micro mt-2.5">
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
              between the two published band edges. */}
          <div className="gv-figure mt-3.5 p-4">
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
              <div className="min-w-0">
                <p className="gv-label text-ink-3">P(30+ DPD in 6 months)</p>
                <p className="gv-metric-sm mt-1 text-ink" data-numeric="">
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
            <p className="gv-micro">Credit Appraisal Agent · same run</p>
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
