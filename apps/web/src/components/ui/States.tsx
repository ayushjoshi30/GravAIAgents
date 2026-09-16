"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { FAILURE_COPY, type ApiFailure } from "@/lib/api";
import type { DataMode } from "@/lib/useResource";

/**
 * The honesty layer.
 *
 * Until recently this console kept a hand-written dossier of applications,
 * runs, audit entries and usage figures, and dropped back to it whenever the
 * API could not be reached — under an amber banner that admitted it. The
 * dossier is gone. This is a lending-compliance product: a screen of
 * realistic-looking applications, risk bands and chain hashes that is actually
 * invented is a genuine hazard, because someone will screenshot it, quote a
 * number out of it, or believe a chain was verified when nothing was verified.
 * A page that says plainly "not connected" is worth more than one that looks
 * alive and is lying.
 *
 * So the failure state below carries no data of its own. It reports what went
 * wrong — with the HTTP status and the correlation id when the failure carries
 * them, because those are what let someone find the request in the API's own
 * logs — and offers the two things that can actually fix it: a token, or
 * another attempt.
 */

/**
 * What a screen shows when its request did not come back.
 *
 * Three cases stay distinct wherever this is used, because collapsing them
 * throws away information a reader needs:
 *   no token        — nothing was even asked for; the fix is in Settings
 *   request failed  — this banner, with the status and correlation id
 *   returned empty  — NOT a failure, and it must never be dressed as one
 *
 * `role="status"` rather than `role="alert"`: a screen reader should hear this
 * when it reaches it, not have its user interrupted mid-sentence by a token
 * that expired.
 */
export function ApiFailureBanner({
  failure,
  onRetry,
  what,
}: {
  failure: ApiFailure | null;
  onRetry?: () => void;
  what: string;
}) {
  if (!failure) return null;
  const offerToken = failure.kind === "no-token" || failure.kind === "unauthenticated";
  // "No token" and "not shipped yet" are states of the world, not faults, so
  // they do not get the fault colour. Everything else did go wrong.
  const expected = failure.kind === "no-token" || failure.kind === "not-implemented";

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-line-2 bg-surface-3 px-3.5 py-2.5"
    >
      <p className="flex min-w-0 items-baseline gap-2 text-[12.5px] leading-relaxed text-ink-2">
        <span
          className={`mt-1.5 block h-2 w-2 shrink-0 rounded-full ${expected ? "bg-ink-4" : "bg-bad"}`}
          aria-hidden="true"
        />
        <span className="min-w-0">
          <span className="font-medium text-ink">Could not load {what}.</span>{" "}
          {FAILURE_COPY[failure.kind]}
          {failure.status ? (
            <span className="font-mono text-[11.5px] text-ink-3"> (HTTP {failure.status})</span>
          ) : null}
          {failure.correlationId ? (
            <span className="font-mono text-[11.5px] text-ink-3">
              {" "}
              correlation {failure.correlationId}
            </span>
          ) : null}
        </span>
      </p>
      <span className="flex shrink-0 items-center gap-3">
        {offerToken ? (
          <Link href="/console/settings" className="gv-link text-[12.5px]">
            Set a token
          </Link>
        ) : null}
        {onRetry ? (
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The same three states, for the screens that want the live case stated too.
 *
 * `DataMode`'s third value is still spelled "example" in `lib/useResource.ts`.
 * There is no example left for it to name: it now means only "the request did
 * not succeed", and every caller here reads it that way. Renaming the value is
 * a follow-up in a file this change does not own — and it was never a licence
 * to leave the word "example" in front of a reader in the meantime.
 */
export function DataModeBanner({
  mode,
  failure,
  onRetry,
  what = "data",
}: {
  mode: DataMode;
  failure?: ApiFailure | null;
  onRetry?: () => void;
  what?: string;
}) {
  if (mode === "loading") {
    return (
      <div
        className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3.5 py-2.5"
        role="status"
      >
        <span
          className="block h-2 w-2 animate-pulse rounded-full bg-brand-300"
          aria-hidden="true"
        />
        <p className="text-[12.5px] text-ink-3">Loading {what}…</p>
      </div>
    );
  }

  if (mode === "live") {
    return (
      <div
        className="flex items-center gap-2.5 rounded-lg border border-pass-border bg-pass-soft px-3.5 py-2.5"
        role="status"
      >
        <span className="block h-2 w-2 rounded-full bg-pass" aria-hidden="true" />
        <p className="text-[12.5px] text-ink-2">
          <span className="font-semibold text-pass">Live data</span> — served by the GravAI API
          for your token.
        </p>
      </div>
    );
  }

  return (
    <ApiFailureBanner
      failure={
        failure ?? { ok: false, kind: "unreachable", message: FAILURE_COPY.unreachable }
      }
      onRetry={onRetry}
      what={what}
    />
  );
}

export function EmptyState({
  title,
  children,
  action,
  icon,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="gv-card-flat px-6 py-12 text-center">
      {icon ? (
        <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand">
          {icon}
        </span>
      ) : null}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {children ? (
        <div className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-3">
          {children}
        </div>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * The sentence a screen prints where rows would have been when the request
 * failed.
 *
 * It exists so that "we asked and there is nothing" and "we asked and never
 * found out" never read the same. An empty book and an unknown book are
 * different facts, and only one of them is safe to act on.
 */
export function UnknownRatherThanEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="px-6 py-12 text-center text-[13px] leading-relaxed text-ink-3">{children}</p>
  );
}

export function InlineNote({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "amber" | "brand";
  children: ReactNode;
}) {
  const toneClass = {
    neutral: "border-line bg-surface-2 text-ink-2",
    amber: "border-amber-border bg-amber-soft text-ink-2",
    brand: "border-brand-200 bg-brand-50 text-ink-2",
  }[tone];
  return (
    <p className={`rounded-lg border px-3.5 py-2.5 text-[12.5px] leading-relaxed ${toneClass}`}>
      {children}
    </p>
  );
}
