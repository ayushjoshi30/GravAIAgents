"use client";

/**
 * An animated explanation of what one agent actually does.
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
 * THE ONE THING THE COLOUR MEANS: teal is the language model thinking; navy is
 * deterministic code. This is the platform's central claim — that a probability
 * comes from a versioned scorecard and only the sentence around it comes from a
 * model — so the picture has to make that visible at a glance rather than
 * asserting it in prose underneath.
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
import { useEffect, useId, useRef, useState } from "react";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import type { Agent } from "@/lib/agents";

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

function Pill({
  stage,
  index,
  count,
  playing,
}: {
  stage: Stage;
  index: number;
  count: number;
  playing: boolean;
}) {
  // Every stage shares one keyframe and differs only by delay, so the lit
  // window walks the rail in step with the travelling dot without a timer.
  const delay = `${(index / Math.max(count, 1)) * 3.6}s`;

  return (
    <li
      title={stage.full}
      className={`relative z-10 flex items-center gap-1.5 rounded-[6px] border bg-white px-2 py-1 text-[11px] leading-tight whitespace-nowrap ${
        playing ? "gv-stage" : ""
      } ${stage.model ? "border-teal-tint text-teal-ink" : "border-line-2 text-ink-2"}`}
      style={playing ? { animationDelay: delay } : undefined}
      data-model={stage.model}
    >
      <span
        aria-hidden="true"
        className={`gv-dot h-1.5 w-1.5 ${stage.model ? "bg-teal" : "bg-navy-mid"}`}
      />
      {stage.label}
    </li>
  );
}

function Column({
  eyebrow,
  items,
  align = "left",
  playing,
  emit,
  row,
  more,
}: {
  eyebrow: string;
  items: { label: string; full: string }[];
  align?: "left" | "right";
  playing: boolean;
  /** Outputs appear as the run finishes; inputs are simply there from the start. */
  emit?: boolean;
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
            className={`rounded-[4px] bg-surface-2 px-1.5 py-1 text-[11px] leading-tight text-ink-2 ${
              row ? "max-w-full truncate" : "truncate"
            } ${emit && playing ? "gv-emit" : ""}`}
            // Stagger only. The keyframe already decides WHEN in the cycle an
            // output appears; adding that offset here as well pushed it past
            // the end of the six seconds and the outputs never lit at all.
            style={emit && playing ? { animationDelay: `${index * 0.12}s` } : undefined}
          >
            {item.label}
          </li>
        ))}
      </ul>
      {more && more > 0 ? (
        <p className="mt-1 text-[10.5px] text-ink-3">
          and {more} more
        </p>
      ) : null}
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
  const stages = stagesFor(agent);
  const detail = agent.detail;
  const headingId = useId();

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

  // A reduced-motion preference must STOP the animation, not slow it, and the
  // stylesheet already does that properly — every keyframe here is switched off
  // with `animation: none`, the packet is hidden and the outputs are restored to
  // full strength so what is left is a complete still diagram rather than a
  // half-faded one.
  //
  // This asks the same question again in JavaScript for the one thing a
  // stylesheet cannot reach: the control. A play/pause button over a picture
  // that was never moving is an interface making a claim about itself that is
  // not true, and this panel's entire argument is that the product does not do
  // that. So when motion is refused the button goes, and the packet is never
  // mounted at all rather than mounted and hidden.
  const [stillness, setStillness] = useState(false);
  const host = useRef<HTMLDivElement>(null);

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

  const inputs = (detail.inputs ?? []).map((text) => ({ label: shorten(text, 26), full: text }));
  const outputKeys = detail.outputKeys ?? [];
  const outputs = outputKeys
    .slice(0, compact ? 3 : 5)
    .map((text) => ({ label: shorten(text, 26), full: text }));
  const outputsHidden = Math.max(0, outputKeys.length - outputs.length);

  const models = stages.filter((stage) => stage.model).length;
  const hidden = Math.max(0, (detail.aiServices?.length ?? 0) + (detail.tools?.length ?? 0) - stages.length);

  // The sentence a screen reader gets. It has to carry the same information the
  // picture does, which means naming the stages rather than saying "a diagram".
  //
  // It names them in FULL rather than in the shortened form on the pills. The
  // pills are shortened because a pill is a fixed width; a sentence is not, and
  // the reader who most needs this sentence is the one who cannot hover a pill
  // to see the `title` that carries the rest of the string.
  //
  // It also has to admit the truncation. The rail draws at most five stages and
  // prints "and N more steps" beside them, but `role="img"` hides that line
  // along with the rest of the subtree — so without this clause the voice
  // collections panel read out five stages and gave no sign that four more
  // existed, which is a more confident claim than the sighted reader gets.
  const description =
    `${agent.name} pipeline. Takes ${inputs.length} input${inputs.length === 1 ? "" : "s"}. ` +
    `Then: ${stages.map((s) => `${s.full}${s.model ? " (an AI capability)" : " (deterministic code)"}`).join(", ") || "no declared stages"}. ` +
    (hidden > 0 ? `${hidden} further stage${hidden === 1 ? " is" : "s are"} declared but not drawn. ` : "") +
    `Produces ${outputKeys.length} output field${outputKeys.length === 1 ? "" : "s"}. ` +
    (detail.escalateWhen?.length ? `Escalates to a person when: ${detail.escalateWhen[0]}.` : "Does not escalate.");

  return (
    <div ref={host} className="gv-panel overflow-hidden" role="group" aria-labelledby={headingId}>
      <div className="flex items-center gap-2 border-b border-line-2 px-3 py-2">
        <span className="gv-icon-plate-sm shrink-0">
          <AgentIcon id={agent.id} size={14} />
        </span>
        <p id={headingId} className="gv-eyebrow flex-1 truncate">
          How it works
          {/* Fourteen panels on the console grid, and now one on the public
              index beside a page full of other headings, all labelled "How it
              works". Sighted readers tell them apart by the icon and the name
              beside them; this is the same disambiguation for anyone moving
              through the page by region or by label. */}
          <span className="sr-only"> — {agent.name}</span>
        </p>

        {/* The diagram answers "what does this do" at a glance. The full
            specification — its rules, its evaluation gates, every condition
            that sends it to a person — is a page of prose, and belongs on a
            page rather than on a card in a grid of fourteen. */}
        {/* Shown only on the wide card. `sm:` would be the wrong test again —
            it asks about the window when the constraint is the card, and on a
            narrow card this link pushes the heading into an ellipsis. */}
        {compact || !specLink ? null : (
          <Link
            href={`/agents/${agent.id}`}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-navy hover:text-navy-ink"
            title={`The full specification for ${agent.name}`}
          >
            Full spec
            <Icon name="external" size={10} />
          </Link>
        )}

        <span
          className="gv-chip gv-chip-teal"
          title="Stages where an AI capability does the work, rather than deterministic code"
        >
          {models} model {models === 1 ? "step" : "steps"}
        </span>
        {/* Withdrawn, not disabled, when the reader has asked for less motion:
            there is genuinely nothing to pause, and a disabled control is a
            puzzle rather than an answer. Focus styling comes from the global
            `:focus-visible` rule, so the button is reachable and visibly
            focused without anything local. */}
        {stillness ? null : (
          <button
            type="button"
            onClick={() => setWanted((value) => !value)}
            aria-label={
              wanted
                ? `Pause the ${agent.name} pipeline animation`
                : `Play the ${agent.name} pipeline animation`
            }
            // No `aria-pressed`. The label already changes with the state, and
            // a toggle that announces "Pause the animation, pressed" is telling
            // the reader two contradictory things at once — the label names the
            // action the button will take, the state names the one it is in.
            // One or the other; the label is the more useful of the two here.
            className="rounded-[4px] p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            <TransportMark paused={!wanted} />
          </button>
        )}
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
        className={
          compact
            ? "grid gap-2.5 p-3"
            : "grid gap-3 p-3 min-[900px]:grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)_minmax(0,0.8fr)] min-[900px]:items-center"
        }
        data-playing={playing}
      >
        <Column eyebrow="Reads" items={inputs} playing={playing} row={compact} />

        <div className="relative py-2">
          {/* The rail and the packet travelling along it. The packet is the unit
              of work moving between stages; it is the only continuous motion. */}
          <span
            aria-hidden="true"
            className="absolute top-1/2 right-0 left-0 h-px -translate-y-1/2 bg-line-2"
          />
          {playing ? (
            <span
              aria-hidden="true"
              className="gv-packet absolute top-1/2 left-0 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-teal"
            />
          ) : null}

          <ul
            className={`relative flex flex-wrap items-center gap-1.5 ${
              compact ? "justify-start" : "justify-center"
            }`}
          >
            {stages.length === 0 ? (
              <li className="rounded-[6px] border border-line-2 bg-white px-2 py-1 text-[11px] text-ink-3">
                no declared stages
              </li>
            ) : (
              stages.map((stage, index) => (
                <Pill
                  key={`${stage.label}-${index}`}
                  stage={stage}
                  index={index}
                  count={stages.length}
                  playing={playing}
                />
              ))
            )}
          </ul>

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
          playing={playing}
          emit
          row={compact}
          more={outputsHidden}
        />
      </div>

      {detail.escalateWhen?.length ? (
        <p
          className="flex items-start gap-2 border-t border-line-2 bg-navy-tint px-3 py-2 text-[11.5px] leading-relaxed text-navy-ink"
          title={detail.escalateWhen.join("\n")}
        >
          <span aria-hidden="true" className="mt-px shrink-0">
            <Icon name="inbox" size={12} />
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
