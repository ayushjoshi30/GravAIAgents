/**
 * The tier marker, and the card plane that goes with it.
 *
 * P0 / P1 / P2 are the catalog's build order. The marker encodes rank four
 * ways so none of them has to carry it alone: the number of filled bars
 * (three, two, one), the plane the card sits on (elevated, raised, flat), the
 * hue the pill is drawn in, and the literal label. Colour only reinforces what
 * the count and the word already say, which is what keeps P0 reading as more
 * important without shouting — and keeps the distinction legible with no hue
 * at all, for a reader who cannot separate these three.
 *
 * WHY THESE THREE HUES. A tier is a rank, so its colours have to read as a
 * descending ramp rather than as three unrelated families: navy is the brand
 * itself and stays where P0 already was, indigo steps once away from it, and
 * slate is the palette's neutral. None of the three is green, amber or rose,
 * because those three carry outcome — a tier is a classification, not a
 * verdict, and a P0 pill in green would say "this passed" to every reader who
 * has learned the rest of the product.
 *
 * The values come from the categorical palette in `globals.css` and are named
 * here as complete class strings. A tier is known at author time, so literal
 * classes are safe; it is only a hue chosen at RUNTIME that has to travel
 * through custom properties, because Tailwind cannot build a class name it
 * never saw in the source.
 */

import type { AgentTier } from "@/lib/agents";

/** The three bar heights, shortest first. Literal classes so Tailwind sees them. */
const BARS = ["h-[5px]", "h-[8px]", "h-[11px]"] as const;

type TierLook = {
  /** How many of the three bars are filled. */
  rank: 1 | 2 | 3;
  pill: string;
  bar: string;
  /** The unfilled bars: the hue's own edge step, so the track stays in family. */
  track: string;
  /** Card variant classes: the plane this tier's card sits on. */
  plane: string;
};

const TIER_LOOK: Record<AgentTier, TierLook> = {
  /** The credit core: the brand's own navy, raised, all three bars. */
  P0: {
    rank: 3,
    pill:
      "border-[var(--gv-hue-navy-border)] bg-[var(--gv-hue-navy-soft)] text-[var(--gv-hue-navy-strong)]",
    bar: "bg-[var(--gv-hue-navy)]",
    track: "bg-[var(--gv-hue-navy-border)]",
    plane: "gv-card-elevated",
  },
  /** The workhorse plane: a white card with the resting shadow, one step off navy. */
  P1: {
    rank: 2,
    pill:
      "border-[var(--gv-hue-indigo-border)] bg-[var(--gv-hue-indigo-soft)] text-[var(--gv-hue-indigo-strong)]",
    bar: "bg-[var(--gv-hue-indigo)]",
    track: "bg-[var(--gv-hue-indigo-border)]",
    plane: "",
  },
  /**
   * The intelligence layer: the palette's neutral, and the same card sitting
   * flat on the page. The resting shadow is taken away and handed back on
   * hover and focus, so the card still lifts like every other one.
   */
  P2: {
    rank: 1,
    pill:
      "border-[var(--gv-hue-slate-border)] bg-[var(--gv-hue-slate-soft)] text-[var(--gv-hue-slate-strong)]",
    bar: "bg-[var(--gv-hue-slate)]",
    track: "bg-[var(--gv-hue-slate-border)]",
    plane: "shadow-none hover:shadow-floating focus-within:shadow-floating",
  },
};

/**
 * The card plane for a tier. Used by `AgentCard`.
 *
 * This returns elevation only, and never a border colour. A catalog card now
 * takes its edge from the agent's own hue, and a second border-colour utility
 * arriving from here would land on the same element and leave the winner to
 * whichever order Tailwind happened to emit the two rules in — a bug that
 * surfaces as one tier's cards quietly wearing the wrong edge.
 */
export function tierPlane(tier: AgentTier): string {
  return TIER_LOOK[tier].plane;
}

export function AgentTierMark({ tier, className }: { tier: AgentTier; className?: string }) {
  const look = TIER_LOOK[tier];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-1.5 py-1 leading-none ${look.pill} ${className ?? ""}`}
    >
      <span className="flex items-end gap-[2px]" aria-hidden="true">
        {BARS.map((height, index) => (
          <span
            key={height}
            className={`w-[3px] rounded-[1px] ${height} ${index < look.rank ? look.bar : look.track}`}
          />
        ))}
      </span>
      <span className="font-mono text-[11px] font-semibold tracking-[0.06em]">
        <span className="sr-only">Tier </span>
        {tier}
      </span>
    </span>
  );
}
