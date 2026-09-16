/**
 * The tier marker, and the card plane that goes with it.
 *
 * P0 / P1 / P2 are the catalog's build order. The marker encodes rank three
 * ways so none of them has to carry it alone: the number of filled bars
 * (three, two, one), the plane the card sits on (elevated, raised, flat), and
 * the literal label. Colour only reinforces what the count and the word
 * already say, which is what keeps P0 reading as more important without
 * shouting — and keeps the distinction legible without hue.
 */

import type { AgentTier } from "@/lib/agents";

/** The three bar heights, shortest first. Literal classes so Tailwind sees them. */
const BARS = ["h-[5px]", "h-[8px]", "h-[11px]"] as const;

type TierLook = {
  /** How many of the three bars are filled. */
  rank: 1 | 2 | 3;
  pill: string;
  bar: string;
  /** Card variant classes: the plane this tier's card sits on. */
  plane: string;
};

const TIER_LOOK: Record<AgentTier, TierLook> = {
  /** The credit core: brand-bordered, raised, all three bars. */
  P0: {
    rank: 3,
    pill: "border-brand-200 bg-brand-50 text-brand",
    bar: "bg-brand",
    plane: "gv-card-elevated hover:border-brand focus-within:border-brand",
  },
  /** The workhorse plane: a white card with the resting shadow. */
  P1: {
    rank: 2,
    pill: "border-line bg-surface-2 text-ink-2",
    bar: "bg-brand-400",
    plane: "",
  },
  /**
   * The intelligence layer: the same card sitting flat on the page. The
   * resting shadow is taken away and handed back on hover and focus, so the
   * card still lifts like every other one.
   */
  P2: {
    rank: 1,
    pill: "border-line bg-transparent text-ink-3",
    bar: "bg-brand-300",
    plane: "shadow-none hover:shadow-floating focus-within:shadow-floating",
  },
};

/** The card plane for a tier. Used by `AgentCard`. */
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
            className={`w-[3px] rounded-[1px] ${height} ${index < look.rank ? look.bar : "bg-brand-100"}`}
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
