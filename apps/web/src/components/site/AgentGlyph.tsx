/**
 * AgentGlyph — a miniature motif per agent, drawn to the same rules as the
 * icon set in `src/components/icons/AgentIcon.tsx`: stroke only, 1.4 units,
 * square caps, no fill, no raster asset anywhere.
 *
 * The icon says what the agent IS. The glyph says what it DOES: a document
 * scan, a transaction sparkline, a consented pipe, a risk gauge, a payment
 * timeline, a voice waveform. It is drawn on a 160x40 field rather than the
 * icon's 24x24 square, because these are small diagrams rather than symbols.
 *
 * Colour: the drawing inherits `currentColor` from its container, so the card
 * can move it from brand-400 at rest to brand at hover in one transition.
 * Structural parts — axes, tracks, frames, the things that are not the
 * measurement — sit in a muted group one step back. The only semantic colour
 * in the set is the risk gauge, where GREEN / AMBER / RED is the catalog's
 * actual banding rather than decoration; it is decorative markup either way,
 * always `aria-hidden`, and never the only way a card is identified.
 *
 * MOTION: three of the fourteen move, and only while the card is hovered or
 * holds keyboard focus. See `FLOW` below for which three and why the other
 * eleven stay still. Nothing here moves at rest, because fourteen motifs
 * animating down a listing is a page that twitches rather than a page that
 * explains, and nothing moves at all for a reader who has asked for less
 * motion — the still drawing was always the complete one.
 */

import type { ReactNode } from "react";

/** A stroked circle on the 160x40 field. Stroke-only, like everything else. */
function circle(cx: number, cy: number, r: number): string {
  return `M${cx + r} ${cy}a${r} ${r} 0 1 1-${r * 2} 0 ${r} ${r} 0 0 1 ${r * 2} 0`;
}

/**
 * The structural layer: axes, frames, tracks, anything not being measured.
 *
 * It takes the agent's own hue rather than the brand's navy. These were
 * `stroke-brand-200` and `stroke-brand-300`, which was invisible until the
 * catalog moved onto the categorical palette: on an orange or pink card the
 * measured line took the agent's hue while the axes it was drawn against
 * stayed faintly navy, so a single motif was wearing two unrelated families.
 *
 * `AgentCard` publishes the four `--plate-*` properties on its root link, and
 * custom properties inherit, so the glyph sees them without being passed
 * anything. The fallbacks are the old navy values, which matter if this
 * component is ever rendered outside a card that publishes a plate — it would
 * otherwise lose its structural strokes entirely and the motif would read as a
 * line floating in space.
 */
const MUTED =
  "stroke-[color:var(--plate-border,var(--color-brand-200))] transition-colors duration-200 ease-gv group-hover:stroke-[color:var(--plate-accent,var(--color-brand-300))]";

/**
 * A line that CARRIES work, as opposed to one that measures it.
 *
 * Most of these motifs are readings: a balance history, a FOIR meter, a
 * turnover reconciliation, a throughput curve. A reading does not move — the
 * number it draws is settled — and animating one would say the opposite of
 * what it means. Three motifs are different, because the thing they draw is
 * something in transit and the transit is the point:
 *
 *   · `aa_data` — the pipe between the two parties, which carries data only
 *     while the consent artefact sitting in the middle of it holds;
 *   · `case_allocation` — cases leaving the ranked queue for their channels;
 *   · `doc_intelligence` — the scan crossing the page, which is a read head
 *     moving and nothing else.
 *
 * On those, hovering or keyboard-focusing the card turns that one line into a
 * travelling dash. It borrows `gv-dash`, the same keyframe the console's run
 * graph uses for a live edge, so a line carrying work looks the same wherever
 * it appears in the product. The dash period is 7 because that keyframe steps
 * the offset by 14 units, and a period that does not divide it makes the loop
 * visibly jump at the seam.
 *
 * `motion-safe:` and nothing else. The stylesheet's reduced-motion block can
 * only switch off the classes it names, and it cannot name these; asking for
 * the animation to exist only where motion is welcome is the version that
 * cannot be forgotten.
 */
const FLOW = [
  "motion-safe:group-hover:[stroke-dasharray:3_4]",
  "motion-safe:group-hover:[animation:gv-dash_0.9s_linear_infinite]",
  "motion-safe:group-focus-within:[stroke-dasharray:3_4]",
  "motion-safe:group-focus-within:[animation:gv-dash_0.9s_linear_infinite]",
].join(" ");

/** A symmetric bar field, used for the two voice motifs. */
function Wave({
  heights,
  x0,
  step,
  center,
  mutedEdges = 0,
}: {
  heights: number[];
  x0: number;
  step: number;
  center: number;
  mutedEdges?: number;
}) {
  return (
    <>
      {heights.map((height, index) => {
        const x = x0 + index * step;
        const edge = mutedEdges > 0 && (index < mutedEdges || index >= heights.length - mutedEdges);
        return (
          <path
            key={x}
            className={edge ? MUTED : undefined}
            d={`M${x} ${center - height / 2}v${height}`}
          />
        );
      })}
    </>
  );
}

const GLYPHS: Record<string, ReactNode> = {
  /** A page under a scan line, resolving into extracted fields and a citation bracket. */
  doc_intelligence: (
    <>
      <g className={MUTED}>
        <path d="M13 18h11" />
        <path d="M13 24h8" />
        <path d="M52 11h13" />
        <path d="M52 21h13" />
        <path d="M52 31h13" />
      </g>
      <path d="M9 5h15l6 6v24H9z" />
      <path d="M24 5v6h6" />
      {/* The scan itself — the one part of this motif that is a movement. */}
      <path className={FLOW} d="M6 28h27" />
      <path d="M71 11h46" />
      <path d="M71 21h58" />
      <path d="M71 31h36" />
      <path d="M144 6h6v28h-6" />
    </>
  ),

  /** Balance behaviour as a sparkline, with the recurring credits ticked beneath it. */
  bank_statement_analytics: (
    <>
      <g className={MUTED}>
        <path d="M6 34h148" />
        <path d="M30 34v-9" />
        <path d="M78 34v-11" />
        <path d="M126 34v-10" />
      </g>
      <path d="M8 24l14-7 12 9 14-11 13 6 14-4 12 8 14-12 13 5 14-7 12 9" />
    </>
  ),

  /** A FOIR meter against its policy cap, and the rule results it has to explain. */
  credit_appraisal: (
    <>
      <g className={MUTED}>
        <path d="M44 13v14" />
        <path d="M50 13v14" />
        <path d="M56 13v14" />
        <path d="M62 13v14" />
        <path d="M8 33h54" />
        <path d="M76 5v30" />
        <path d="M104 10h46" />
        <path d="M104 20h46" />
        <path d="M104 30h34" />
      </g>
      <path d="M8 13v14" />
      <path d="M14 13v14" />
      <path d="M20 13v14" />
      <path d="M26 13v14" />
      <path d="M32 13v14" />
      <path d="M38 13v14" />
      <path d="M41 9l3-3 3 3" />
      <path d="M90 10l2.5 2.5 5-6" />
      <path d="M90 20l2.5 2.5 5-6" />
      <path d="M90 27l6 6" />
      <path d="M96 27l-6 6" />
    </>
  ),

  /**
   * The banded gauge. GREEN / AMBER / RED is the catalog's own banding of
   * probability of 30+ DPD, so the semantic colour is the meaning, not decor.
   * Features feed in from the left; the top drivers come out on the right.
   */
  risk_scoring: (
    <>
      <g className={MUTED}>
        <path d="M8 16h20" />
        <path d="M8 22h26" />
        <path d="M8 28h14" />
        <path d="M58 35v3" />
        <path d="M102 35v3" />
      </g>
      <path className="stroke-pass" d="M58 32A22 22 0 0 1 69 13" />
      <path className="stroke-amber" d="M69 13A22 22 0 0 1 91 13" />
      <path className="stroke-fail" d="M91 13A22 22 0 0 1 102 32" />
      <path d="M80 32l-3-16" />
      <path d={circle(80, 32, 2)} />
      <path d="M132 16h20" />
      <path d="M132 22h13" />
      <path d="M132 28h17" />
    </>
  ),

  /** Two parties, one pipe, and the consent artefact that is the only thing opening it. */
  aa_data: (
    <>
      <g className={MUTED}>
        <path d="M8 14h22v14H8z" />
      </g>
      <path d="M130 14h22v14h-22z" />
      {/* The consented pipe. It flows on both sides of the artefact because the
          artefact is what opens it, not a meter reading what came through. */}
      <path className={FLOW} d="M30 21h38" />
      <path className={FLOW} d="M92 21h38" />
      <path d="M70 17h20v12H70z" />
      <path d="M75 17v-3a5 5 0 0 1 10 0v3" />
    </>
  ),

  /** An identity document, a name matched across sources, and Aadhaar masked to the last four. */
  kyc_verification: (
    <>
      <g className={MUTED}>
        <path d="M8 8h44v24H8z" />
        <path d="M36 14h11" />
        <path d="M36 20h11" />
        <path d="M68 13h44" />
        <path d={circle(72, 32, 2)} />
        <path d={circle(80, 32, 2)} />
        <path d={circle(88, 32, 2)} />
      </g>
      <path d={circle(23, 18, 5)} />
      <path d="M16 29c0-4 3.2-6 7-6s7 2 7 6" />
      <path d="M68 23h34" />
      <path d="M118 24l3 3 7-8" />
      <path d="M98 29v6" />
      <path d="M104 29v6" />
      <path d="M110 29v6" />
      <path d="M116 29v6" />
    </>
  ),

  /** A ranked queue fanning into channels, inside the permitted calling window. */
  case_allocation: (
    <>
      <g className={MUTED}>
        <path d="M8 16h38" />
        <path d="M8 24h30" />
        <path d="M8 32h22" />
        <path d="M72 6h10v8H72z" />
        <path d="M72 16h10v8H72z" />
        <path d="M72 26h10v8H72z" />
      </g>
      <path d="M8 8h46" />
      <path d="M50 20h14" />
      <path d="M64 10v20" />
      <path d="M64 10h8" />
      <path d="M64 20h8" />
      <path d="M64 30h8" />
      {/* Cases leaving the queue for their channels. The ranked queue on the
          left is a reading and stays put; only the dispatch moves. */}
      <path className={FLOW} d="M88 10h24" />
      <path className={FLOW} d="M88 20h32" />
      <path className={FLOW} d="M88 30h18" />
      <path d={circle(142, 20, 9)} />
      <path d="M142 14v6l4 3" />
    </>
  ),

  /** The presentment calendar: salary credit in, pre-debit notice, then the debit. */
  smart_mandate: (
    <>
      <g className={MUTED}>
        <path d="M8 28h144" />
        <path d="M20 28v4" />
        <path d="M44 28v4" />
        <path d="M68 28v4" />
        <path d="M92 28v4" />
        <path d="M116 28v4" />
        <path d="M140 28v4" />
        <path d="M92 6h24" />
        <path d="M92 6v4" />
        <path d="M116 6v4" />
      </g>
      <path d="M44 28v-12" />
      <path d="M40 20l4-4 4 4" />
      <path d="M92 28v-12" strokeDasharray="3 3" />
      <path d="M111 12h10v10h-10z" />
    </>
  ),

  /** A live call: the waveform of a bounded, two-way conversation. */
  voice_collections: (
    <Wave
      heights={[8, 16, 26, 34, 22, 12, 28, 36, 24, 14, 30, 20, 10, 24, 32, 18, 12, 6]}
      x0={10}
      step={8}
      center={20}
      mutedEdges={2}
    />
  ),

  /** The same call, scored: a quoted span bracketed out of it, and the rubric beside it. */
  speech_analytics: (
    <>
      <g className={MUTED}>
        <path d="M100 6v28" />
        <path d="M110 34h32" />
        <path d="M142 16v14" />
      </g>
      <Wave
        heights={[10, 18, 22, 14, 20, 26, 16, 10, 18, 22]}
        x0={10}
        step={9}
        center={25}
        mutedEdges={0}
      />
      <path d="M37 6h28" />
      <path d="M37 6v4" />
      <path d="M65 6v4" />
      <path d="M110 16v14" />
      <path d="M118 16v14" />
      <path d="M126 16v14" />
      <path d="M134 16v14" />
    </>
  ),

  /** The applicant journey: steps cleared, the step in hand, and the conversation around it. */
  onboarding_assistant: (
    <>
      <g className={MUTED}>
        <path d="M12 24h96" />
        <path d={circle(100, 24, 4.5)} />
        <path d="M126 15h20" />
        <path d="M126 20h13" />
      </g>
      <path d={circle(16, 24, 4.5)} />
      <path d="M14 24l2 2 3-4" />
      <path d={circle(58, 24, 4.5)} />
      <path d="M120 8h32v18h-19l-7 6v-6h-6z" />
    </>
  ),

  /** Four independent views of one business, and how far apart they are. */
  msme_underwriting: (
    <>
      <g className={MUTED}>
        <path d="M8 34h144" />
        <path d="M24 6h84" />
        <path d="M24 6v4" />
        <path d="M108 6v4" />
        <path d="M144 16v10" />
        <path d="M150 16v10" />
      </g>
      <path d="M24 34v-20" />
      <path d="M52 34v-17" />
      <path d="M80 34v-23" />
      <path d="M108 34v-15" />
      <path d="M126 16v10" />
      <path d="M132 16v10" />
      <path d="M138 16v10" />
    </>
  ),

  /** Two segments each inside a stated rule, and the population consent excludes. */
  customer_data_intelligence: (
    <>
      <g className={MUTED}>
        <path d="M10 9h40v24H10z" />
        <path d="M60 9h40v24H60z" />
        <path d="M112 9h38v24h-38z" strokeDasharray="4 3" />
        <path d={circle(131, 21, 2)} />
        <path d="M127 17l8 8" />
        <path d="M135 17l-8 8" />
      </g>
      <path d={circle(22, 16, 2)} />
      <path d={circle(32, 25, 2)} />
      <path d={circle(40, 15, 2)} />
      <path d={circle(72, 15, 2)} />
      <path d={circle(82, 25, 2)} />
      <path d={circle(90, 17, 2)} />
    </>
  ),

  /** Throughput stepping up under a fixed ceiling — the platform's model of itself. */
  ops_research: (
    <>
      <g className={MUTED}>
        <path d="M10 34h142" />
        <path d="M10 34V6" />
      </g>
      <path d="M10 12h142" strokeDasharray="4 4" />
      <path d="M14 30h16v-5h16v-4h16v3h16v-6h16v4h16v-5h28" />
    </>
  ),
};

/** Anything the catalog adds later: a signal over a baseline, no invention. */
const FALLBACK: ReactNode = (
  <>
    <g className={MUTED}>
      <path d="M8 34h144" />
      <path d="M16 34v-8" />
      <path d="M40 34v-12" />
    </g>
    <path d="M12 26l28-9 28 6 28-11 28 7 28-8" />
  </>
);

export function AgentGlyph({ id, className }: { id: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 160 40"
      width="160"
      height="40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {GLYPHS[id] ?? FALLBACK}
    </svg>
  );
}
