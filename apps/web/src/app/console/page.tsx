"use client";

import Link from "next/link";
import { Chip, Eyebrow, Figure, Skeleton } from "@/components/console/primitives";
import { ApiFailureBanner, UnknownRatherThanEmpty } from "@/components/ui/States";
import { api } from "@/lib/api";
import { formatCount, formatInrCompact } from "@/lib/format";
import { useToken } from "@/lib/session";
import { useResource } from "@/lib/useResource";

/**
 * Overview — the four things a person checks before they start.
 *
 * The subtitle names them in the order they matter: what is in flight, what the
 * agents have been doing, what it has cost against the rate card, and how much
 * document-processing quota is left. Each comes from its own endpoint, so one
 * being unavailable does not blank the other three. A console that goes
 * entirely dark because one service is slow tells the reader less than one that
 * says which service.
 *
 * WHY THERE ARE NO NUMBERS WITHOUT A TOKEN. This page used to fill itself with
 * a written-out book — applications in flight, spend to date, a quota figure —
 * whenever the API could not be reached, behind a small amber note. The note
 * was not enough. A figure on a dashboard is read, quoted and screenshotted
 * long before anybody reads the banner above it, and "48 applications in
 * flight" is exactly the kind of number that ends up in a status update. A tile
 * with no answer now says it has no answer.
 *
 * The tiles preserve the difference between three silences: no token was set,
 * so nobody asked; the request was made and failed, and the banner carries the
 * status and correlation id; the request succeeded and the tenant genuinely has
 * nothing, which is the only one that is an empty state. Collapsing them loses
 * the single piece of information a person needs to know what to do next.
 */

const NO_SUMMARY: Record<string, number> = {};
const NO_ROWS: never[] = [];

/**
 * Statuses that mean the application is no longer somebody's problem.
 *
 * Listed as what to EXCLUDE rather than what to include, so a status the API
 * gains later is counted as in flight by default. Over-counting work that is
 * finished is a smaller error than silently dropping work that is not.
 */
const SETTLED = new Set(["closed", "rejected", "disbursed", "withdrawn"]);

function Tile({
  label,
  value,
  note,
  loading,
  unknown,
}: {
  label: string;
  value: string;
  note?: string;
  loading: boolean;
  /** True when the figure could not be established — which is not the same as zero. */
  unknown: boolean;
}) {
  if (loading) {
    return (
      <div className="rounded-lg border border-line bg-surface p-4">
        <Skeleton h={11} w="58%" />
        <div className="mt-3">
          <Skeleton h={26} w="42%" />
        </div>
      </div>
    );
  }

  if (unknown) {
    return (
      <div className="rounded-lg border border-line bg-surface p-4">
        <Eyebrow>{label}</Eyebrow>
        <div className="mt-2">
          <UnknownRatherThanEmpty>not established</UnknownRatherThanEmpty>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <Figure label={label} value={value} note={note} />
    </div>
  );
}

export default function ConsoleOverviewPage() {
  const [token] = useToken();

  const summary = useResource("overview:summary", (signal) => api.applicationSummary(token, signal), NO_SUMMARY);
  const runs = useResource("overview:runs", (signal) => api.listRuns(token, {}, signal), NO_ROWS);
  const usage = useResource("overview:usage", (signal) => api.usage(token, {}, signal), NO_ROWS);
  const governor = useResource("overview:governor", (signal) => api.governor(token, signal), NO_ROWS);

  const panels = [summary, runs, usage, governor];
  const loading = panels.some((panel) => panel.mode === "loading");

  // `useResource` still spells its failure mode "example", left over from when a
  // failure meant "show the written-out book instead". Nothing is substituted
  // any more, so the value now means only that the request did not succeed.
  const failed = (panel: { mode: string }) => panel.mode === "example";

  const inFlight = Object.entries(summary.data)
    .filter(([status]) => !SETTLED.has(status))
    .reduce((total, [, count]) => total + count, 0);

  const spend = usage.data.reduce((total, row) => total + (row.cost_inr ?? 0), 0);
  const quotaLeft = governor.data.reduce((total, row) => total + (row.available ?? 0), 0);

  const firstFailure = panels.find((panel) => failed(panel) && panel.failure)?.failure ?? null;

  return (
    <div className="gv-page">
      <header className="gv-page-head">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="gv-page-title">Overview</h1>
            <p className="gv-page-sub">
              Applications, agent activity, spend against the rate card and the
              document-processing quota, for the tenant your token belongs to.
            </p>
          </div>
          <Link href="/console/usage" className="gv-link shrink-0 text-[13px]">
            Usage dashboards
          </Link>
        </div>
      </header>

      {/* One banner for the page rather than one per tile: four copies of the
          same correlation id is noise, and each tile already says for itself
          whether it has an answer. */}
      {firstFailure ? (
        <ApiFailureBanner failure={firstFailure} what="this tenant's summary" />
      ) : null}

      <section aria-label="Tenant summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          label="Applications in flight"
          value={formatCount(inFlight)}
          note="open, excluding settled"
          loading={loading}
          unknown={!token || failed(summary)}
        />
        <Tile
          label="Agent runs recorded"
          value={formatCount(runs.data.length)}
          note="every run, escalations included"
          loading={loading}
          unknown={!token || failed(runs)}
        />
        <Tile
          label="Spend against the rate card"
          value={formatInrCompact(spend)}
          loading={loading}
          unknown={!token || failed(usage)}
        />
        <Tile
          label="Document quota available"
          value={formatCount(quotaLeft)}
          note="tokens left in the bucket"
          loading={loading}
          unknown={!token || failed(governor)}
        />
      </section>

      <section className="mt-6 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-ink">Decisions waiting on a person</h2>
            <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-ink-2">
              Credit decisions are escalated by design rather than by exception, so items sitting
              in the queue are the system working as intended. Every action there requires a note,
              and every note enters the audit chain with your identity against it.
            </p>
          </div>
          <Link href="/console/review" className="gv-link shrink-0 text-[13px]">
            Open the review queue
          </Link>
        </div>
      </section>

      {!token ? (
        <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-relaxed text-ink-2">
          <Chip tone="slate">No token</Chip>
          <span>
            Nothing above has been asked for yet. These figures are per tenant, so they need the
            token that identifies one —{" "}
            <Link href="/console/settings" className="gv-link">
              add one in Settings
            </Link>
            .
          </span>
        </p>
      ) : null}
    </div>
  );
}
