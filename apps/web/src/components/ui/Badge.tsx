import type { ReactNode } from "react";
import type { AgentTier } from "@/lib/agents";

/**
 * Status badges. Brand-dominant: most states are a brand tint, and semantic
 * colour is spent only where pass, attention or failure is the actual meaning.
 *
 * Every tone that carries state is paired with a word — the badge always has a
 * label — and `dot` adds a second, non-colour signal. Nothing here is ever the
 * only indication of a state.
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
  | "inverse";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-line bg-surface-3 text-ink-2",
  brand: "border-brand-200 bg-brand-50 text-brand",
  blue: "border-brand-200 bg-brand-50 text-brand",
  accent: "border-accent/25 bg-accent-soft text-accent",
  amber: "border-amber-border bg-amber-soft text-amber",
  pass: "border-pass-border bg-pass-soft text-pass",
  fail: "border-fail-border bg-fail-soft text-fail",
  outline: "border-line-strong bg-transparent text-ink-2",
  /** Filled brand. One per view at most — a hero kicker, a "new" marker. */
  solid: "border-brand bg-brand text-white shadow-brand",
  /** For use on the inverse band only. */
  inverse: "border-white/25 bg-white/10 text-white",
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
 */
export function Chip({
  children,
  className,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  tone?: "neutral" | "brand";
}) {
  const toneClass =
    tone === "brand"
      ? "border-brand-200 bg-brand-50 text-brand"
      : "border-line bg-surface-2 text-ink-2";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] font-medium ${toneClass} ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

const TIER_TONE: Record<AgentTier, Tone> = {
  P0: "brand",
  P1: "blue",
  P2: "neutral",
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
