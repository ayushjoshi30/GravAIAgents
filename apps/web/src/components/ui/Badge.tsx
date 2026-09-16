import type { ReactNode } from "react";
import type { AgentTier } from "@/lib/agents";

/**
 * Status badges. Semantic colour is spent only where pass, attention or
 * failure is the actual meaning; everything else now reaches the twelve-family
 * categorical palette rather than making do with brand and grey.
 *
 * Every tone that carries state is paired with a word — the badge always has a
 * label — and `dot` adds a second, non-colour signal. Nothing here is ever the
 * only indication of a state.
 *
 * WHAT IS NOT ON THE LIST, AND WHY. There is no `green` or `rose` tone,
 * because green and rose mean a run proceeded and a run stopped: `pass` and
 * `fail` already say that, and a second spelling of the same colour is an
 * invitation to use it for something that is not an outcome. `amber` keeps its
 * semantic value for the same reason — risk, or a rule that can reject. Teal
 * and navy are reachable through `accent` and `brand`, which is where the
 * platform's one real claim lives: teal is a language model reasoning, navy is
 * deterministic code with a fixed answer. Neither is decoration, in a diagram
 * or anywhere else.
 *
 * Every categorical tone pairs the hue's `-soft` plate with its `-strong` text
 * rather than its base value. The base step is tuned to be read on white, and
 * on its own soft plate it is the palette's documented contrast failure.
 */

export type Tone =
  | "neutral"
  | "brand"
  | "blue"
  | "accent"
  | "amber"
  | "pass"
  | "fail"
  | "outline"
  | "solid"
  | "inverse"
  | "violet"
  | "indigo"
  | "cyan"
  | "pink"
  | "orange"
  | "slate"
  | "hue";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-line bg-surface-3 text-ink-2",
  brand: "border-brand-200 bg-brand-50 text-brand",
  /**
   * AN ALIAS OF THE BRAND, NOT THE PALETTE'S BLUE. This name predates the
   * categorical hues and every page that already says `tone="blue"` means the
   * navy wordmark by it, so it keeps pointing there. It is called out because
   * the six names below it — violet, indigo, cyan, pink, orange, slate — do
   * resolve to `--gv-hue-<name>-*`, and `blue` sitting among them reads as if
   * it does too. It does not: the palette's own blue is what a Bank Statement
   * agent card wears, and a badge that has to match one should take `hue` from
   * the surface rather than reach for this.
   */
  // The palette's blue, not the brand's.
  //
  // This was an alias of `brand` — the same three navy classes, under a
  // second name. That was harmless until this file gained violet, indigo,
  // cyan, pink, orange and slate, all of which resolve to --gv-hue-*: `blue`
  // then sat inside a set whose convention it did not follow, so writing
  // tone="blue" beside tone="cyan" would hand you navy, and a "blue" badge
  // next to the blue agent card would not match it.
  //
  // Safe to change: `brand` already carries navy under a name that says so,
  // and this tone had no usages anywhere in the app. `Meter` in Stat.tsx has
  // a "blue" of its own with its own map, which this does not touch.
  blue: "border-[var(--gv-hue-blue-border)] bg-[var(--gv-hue-blue-soft)] text-[var(--gv-hue-blue-strong)]",
  accent: "border-accent/25 bg-accent-soft text-accent",
  amber: "border-amber-border bg-amber-soft text-amber",
  pass: "border-pass-border bg-pass-soft text-pass",
  fail: "border-fail-border bg-fail-soft text-fail",
  outline: "border-line-strong bg-transparent text-ink-2",
  /** Filled brand. One per view at most — a hero kicker, a "new" marker. */
  solid: "border-brand bg-brand text-white shadow-brand",
  /** For use on the inverse band only. */
  inverse: "border-white/25 bg-white/10 text-white",

  /* The categorical hues, for a badge that names a category rather than a
     state: a family, a channel, a section of the site. */
  violet:
    "border-[var(--gv-hue-violet-border)] bg-[var(--gv-hue-violet-soft)] text-[var(--gv-hue-violet-strong)]",
  indigo:
    "border-[var(--gv-hue-indigo-border)] bg-[var(--gv-hue-indigo-soft)] text-[var(--gv-hue-indigo-strong)]",
  cyan: "border-[var(--gv-hue-cyan-border)] bg-[var(--gv-hue-cyan-soft)] text-[var(--gv-hue-cyan-strong)]",
  pink: "border-[var(--gv-hue-pink-border)] bg-[var(--gv-hue-pink-soft)] text-[var(--gv-hue-pink-strong)]",
  orange:
    "border-[var(--gv-hue-orange-border)] bg-[var(--gv-hue-orange-soft)] text-[var(--gv-hue-orange-strong)]",
  slate:
    "border-[var(--gv-hue-slate-border)] bg-[var(--gv-hue-slate-soft)] text-[var(--gv-hue-slate-strong)]",

  /**
   * Whatever hue the surrounding surface is wearing. An agent card, a hued
   * band or a `Card` with a `hue` publishes the four plate properties, and a
   * badge inside picks them up without being told the colour a second time —
   * which is what stops a badge and its card disagreeing after the generated
   * catalog moves an agent to another family. The fallbacks are the neutral
   * tone, so a badge placed on a surface with no hue still draws.
   */
  hue: "border-[var(--plate-border,var(--gv-line))] bg-[var(--plate,var(--gv-surface-3))] text-[var(--plate-strong,var(--gv-ink-2))]",
};

const SIZE_CLASS = {
  sm: "px-2 py-0.5 text-[11.5px] leading-[18px]",
  md: "px-2.5 py-1 text-[12.5px] leading-[18px]",
} as const;

export function Badge({
  children,
  tone = "neutral",
  className,
  dot = false,
  size = "sm",
  icon,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  dot?: boolean;
  size?: "sm" | "md";
  /** A 12-14px glyph in front of the label. Always decorative. */
  icon?: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap ${TONE_CLASS[tone]} ${SIZE_CLASS[size]} ${className ?? ""}`}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
      {icon ? (
        <span className="-ml-0.5 flex shrink-0 items-center" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}

/**
 * A metadata chip that is not a status: a count, a category, a "14 agents".
 * Squarer than a badge on purpose, so the two never read as the same thing.
 *
 * The tones are the badge's, minus everything that carries state: a chip is
 * never a verdict, so `pass`, `fail`, `amber`, `solid` and `inverse` are
 * deliberately out of reach here. What is left is the neutral, the brand and
 * the categorical hues, including `hue` for a chip that should wear whatever
 * colour its surrounding card is already wearing.
 */
export type ChipTone = "neutral" | "brand" | "violet" | "indigo" | "cyan" | "pink" | "orange" | "slate" | "hue";

const CHIP_TONE: Record<ChipTone, string> = {
  neutral: "border-line bg-surface-2 text-ink-2",
  brand: "border-brand-200 bg-brand-50 text-brand",
  violet: TONE_CLASS.violet,
  indigo: TONE_CLASS.indigo,
  cyan: TONE_CLASS.cyan,
  pink: TONE_CLASS.pink,
  orange: TONE_CLASS.orange,
  slate: TONE_CLASS.slate,
  hue: TONE_CLASS.hue,
};

export function Chip({
  children,
  className,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  tone?: ChipTone;
}) {
  const toneClass = CHIP_TONE[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] font-medium ${toneClass} ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

/**
 * The same navy → indigo → slate ramp `AgentTierMark` draws, so the two ways
 * this site prints a tier agree. They did not before: `blue` is an alias of
 * the brand, so P0 and P1 were rendering as the same badge and only the letter
 * told them apart.
 */
const TIER_TONE: Record<AgentTier, Tone> = {
  P0: "brand",
  P1: "indigo",
  P2: "slate",
};

export function TierBadge({ tier }: { tier: AgentTier }) {
  return <Badge tone={TIER_TONE[tier]}>{tier}</Badge>;
}

const STATUS_TONE: Record<string, Tone> = {
  succeeded: "pass",
  approved: "pass",
  healthy: "pass",
  operational: "pass",
  live: "pass",
  active: "pass",
  ok: "pass",
  connected: "pass",
  disbursed: "pass",
  kyc_verified: "pass",
  failed: "fail",
  rejected: "fail",
  revoked: "fail",
  breached: "fail",
  unreachable: "fail",
  escalated: "amber",
  degraded: "amber",
  retrying: "amber",
  candidate: "amber",
  deviation_pending: "amber",
  documents_pending: "amber",
  sandbox_only: "amber",
  external_dependency: "amber",
  pending: "amber",
  running: "brand",
  underwriting: "brand",
  credit_review: "brand",
  bre_evaluated: "brand",
  received: "neutral",
  queued: "neutral",
  cancelled: "neutral",
  skipped: "neutral",
  deactivated: "neutral",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  return (
    <Badge tone={tone} dot>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

export function RiskBandBadge({ band }: { band: string | null }) {
  if (!band) return <span className="text-ink-3">—</span>;
  const tone: Tone = band === "GREEN" ? "pass" : band === "RED" ? "fail" : "amber";
  return (
    <Badge tone={tone} dot>
      {band}
    </Badge>
  );
}

/** A monospaced chip for scopes, identifiers and tags. */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
      {children}
    </span>
  );
}
