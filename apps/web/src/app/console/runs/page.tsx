"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Chip, Eyebrow, Figure, Skeleton, type Tone } from "@/components/console/primitives";
import { Button } from "@/components/ui/Button";
import { SelectField, TextField } from "@/components/ui/Field";
import { ApiFailureBanner, UnknownRatherThanEmpty } from "@/components/ui/States";
import { type RunOut, api } from "@/lib/api";
import { AGENTS } from "@/lib/agents";
import { formatCount, formatDuration, formatInr, formatTimeIst } from "@/lib/format";
import { useToken } from "@/lib/session";
import { useResource } from "@/lib/useResource";

/**
 * Runs — every agent execution for this tenant.
 *
 * Same row grammar as Applications: identifier first and linked, state on a
 * chip, the supporting numbers on a second line that reflows. A running row
 * carries the pulsing teal dot, which is the one place in the console where
 * motion means something — teal is reserved for "an agent is working".
 */

/**
 * What stands in for the run history before the API answers: nothing at all.
 *
 * A written-out list of runs used to live here — plausible agent ids, plausible
 * costs, plausible escalations. On a compliance screen that is not a
 * placeholder, it is a claim that work happened. `/v1/runs` has not shipped in
 * every API build this console is pointed at, so the empty case is common, and
 * it is reported as what it is.
 */
const NO_RUNS: RunOut[] = [];

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "escalated", label: "Escalated" },
  { value: "failed", label: "Failed" },
];

const SORTS = [
  { value: "", label: "As the API returned them" },
  { value: "started_at", label: "Start time" },
  { value: "cost_inr", label: "Cost" },
  { value: "duration_ms", label: "Duration" },
  { value: "status", label: "Status" },
  { value: "agent_id", label: "Agent" },
  { value: "tenant", label: "Tenant" },
];

export default function RunsPage() {
  const [token] = useToken();
  const [status, setStatus] = useState("");
  const [agentId, setAgentId] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("");
  const [descending, setDescending] = useState(true);

  const runs = useResource(
    `runs-list:${token ?? "none"}`,
    (signal) => api.listRuns(token, { limit: 500 }, signal),
    NO_RUNS,
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = runs.data.filter((run) => {
      if (status && run.status !== status) return false;
      if (agentId && run.agent_id !== agentId) return false;
      if (!needle) return true;
      return (
        run.id.toLowerCase().includes(needle) ||
        run.tenant.toLowerCase().includes(needle) ||
        (run.application_id ?? "").toLowerCase().includes(needle)
      );
    });

    if (!sort) return rows;
    const direction = descending ? -1 : 1;
    return [...rows].sort((a, b) => direction * compare(a, b, sort));
  }, [runs.data, status, agentId, query, sort, descending]);

  const totals = useMemo(() => {
    const cost = filtered.reduce((sum, run) => sum + run.cost_inr, 0);
    const failures = filtered.filter((run) => run.status === "failed").length;
    const escalations = filtered.filter((run) => run.escalated).length;
    return { cost, failures, escalations };
  }, [filtered]);

  const loading = runs.mode === "loading";
  const failure = runs.failure;
  // Answered means the API came back with a list — possibly an empty one. Only
  // then is a count a fact rather than a guess dressed as one.
  const answered = !loading && !failure;
  const filtersApplied = Boolean(status || agentId || query.trim());
  // `not-implemented` is not a fault: `/v1/runs` is declared in the client and
  // ships later. Saying so is more use to a reader than "no runs found".
  const notShippedYet = failure?.kind === "not-implemented";

  return (
    <div className="gv-rise space-y-6">
      <header className="min-w-0">
        <Eyebrow>Agents · Runs</Eyebrow>
        <h1 className="gv-page-title mt-1.5">Runs</h1>
        <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-ink-2">
          Every agent run for this tenant, with its cost and elapsed time. Open one to see the
          step timeline, the prompt version behind each step and the citations it produced.
        </p>
      </header>

      <ApiFailureBanner failure={failure} onRetry={runs.reload} what="runs" />

      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <Figure
          label="Runs listed"
          value={answered ? formatCount(filtered.length) : "—"}
          note={
            !answered
              ? "Nothing has been counted, because nothing has been read."
              : filtersApplied
                ? `Matching these filters, out of ${formatCount(runs.data.length)} returned.`
                : "The most recent 500 runs the API returned for this token."
          }
        />
        <Figure
          label="Cost of these runs"
          value={answered ? formatInr(totals.cost) : "—"}
          note="Summed over the rows below, priced against the rate card rows that carry a unit price."
        />
        <Figure
          label="Escalated"
          value={answered ? formatCount(totals.escalations) : "—"}
          tone={answered && totals.escalations > 0 ? "amber" : undefined}
          note="Handed to a person by design, not failed. They appear in the decision queue."
        />
        <Figure
          label="Failed"
          value={answered ? formatCount(totals.failures) : "—"}
          tone={answered && totals.failures > 0 ? "red" : undefined}
          note="Still failing after the retry policy had finished with them."
        />
      </div>

      <div className="gv-card grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <TextField
          label="Search"
          value={query}
          onChange={setQuery}
          placeholder="Run id, tenant or application"
          type="search"
        />
        <SelectField label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
        <SelectField
          label="Agent"
          value={agentId}
          onChange={setAgentId}
          options={[
            { value: "", label: "All agents" },
            ...AGENTS.map((agent) => ({ value: agent.id, label: agent.name })),
          ]}
        />
        <SelectField label="Sort by" value={sort} onChange={setSort} options={SORTS} />
        <div className="flex items-end">
          {/* Disabled never hides: the title says which choice is missing. */}
          <Button
            onClick={() => setDescending((value) => !value)}
            disabled={!sort}
            aria-label={descending ? "Sort ascending instead" : "Sort descending instead"}
            title={
              sort
                ? descending
                  ? "Sorting highest first. Press to reverse."
                  : "Sorting lowest first. Press to reverse."
                : "Pick a sort field before choosing a direction."
            }
          >
            {descending ? "Descending" : "Ascending"}
          </Button>
        </div>
      </div>

      <section aria-label="Agent runs" className="gv-card overflow-hidden">
        {loading ? (
          <RowSkeletons />
        ) : failure ? (
          <UnknownRatherThanEmpty>
            {notShippedYet
              ? "Nothing to list: the runs endpoint has not shipped in the API build this console is pointed at, so there is no run history to read yet. That is not the same as this tenant having run nothing."
              : "No runs are listed because the request above did not succeed. Whether this tenant has run an agent is unknown from here, and an unknown history is not a blank one."}
          </UnknownRatherThanEmpty>
        ) : filtered.length === 0 ? (
          <UnknownRatherThanEmpty>
            {filtersApplied
              ? "No run matches these filters. Widening the status or the agent will bring more back."
              : "This tenant has not run an agent yet. A run appears here the moment one is started from the catalog, from the lending platform over REST, or from a model host over the tool layer."}
          </UnknownRatherThanEmpty>
        ) : (
          <ul>
            {filtered.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunRow({ run }: { run: RunOut }) {
  const running = run.status === "running";
  return (
    <li className="gv-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <Link href={`/console/runs/${run.id}`} className="gv-id text-navy hover:underline">
          {run.id}
        </Link>
        {/* The agent id is not a link: there is no per-agent page yet, and a
            link to the catalog would promise a destination it does not reach.
            The agent filter above does the job the link would have done. */}
        <span className="gv-id text-ink-3">{run.agent_id}</span>
      </div>

      <span className="flex shrink-0 items-center gap-1.5">
        {run.band ? <Chip tone={bandTone(run.band)}>{run.band}</Chip> : null}
        <Chip tone={statusTone(run.status)}>
          {running ? <span className="gv-dot gv-dot-live" aria-hidden="true" /> : null}
          {run.status}
        </Chip>
      </span>

      <dl className="col-span-2 flex flex-wrap gap-x-4 gap-y-0.5">
        <Pair label="Started" value={formatTimeIst(run.started_at)} />
        <Pair label="Tenant" value={run.tenant} />
        <div className="flex items-baseline gap-1.5">
          <dt className="text-[11px] text-ink-4">Application</dt>
          <dd>
            {run.application_id ? (
              <Link
                href={`/console/applications/${run.application_id}`}
                className="gv-id text-navy hover:underline"
              >
                {run.application_id}
              </Link>
            ) : (
              <span className="font-mono text-[11.5px] text-ink-3">not attached</span>
            )}
          </dd>
        </div>
        <Pair label="Cost" value={formatInr(run.cost_inr)} />
        <Pair label="Duration" value={formatDuration(run.duration_ms)} />
      </dl>
    </li>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-[11px] text-ink-4">{label}</dt>
      <dd className="font-mono text-[11.5px] text-ink-2">{value}</dd>
    </div>
  );
}

function RowSkeletons() {
  return (
    <ul aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <li key={index} className="gv-row grid gap-2 px-4 py-3">
          <Skeleton h={14} w="min(55%, 320px)" />
          <Skeleton h={11} w="min(70%, 420px)" />
        </li>
      ))}
    </ul>
  );
}

function statusTone(status: string): Tone {
  switch (status) {
    case "succeeded":
      return "green";
    case "failed":
      return "red";
    case "escalated":
      return "amber";
    case "running":
      return "teal";
    default:
      return "slate";
  }
}

function bandTone(band: string): Tone {
  if (band === "GREEN") return "green";
  if (band === "RED") return "red";
  return "amber";
}

function compare(a: RunOut, b: RunOut, key: string): number {
  switch (key) {
    case "cost_inr":
      return a.cost_inr - b.cost_inr;
    case "duration_ms":
      return a.duration_ms - b.duration_ms;
    case "status":
      return a.status.localeCompare(b.status);
    case "agent_id":
      return a.agent_id.localeCompare(b.agent_id);
    case "tenant":
      return a.tenant.localeCompare(b.tenant);
    default:
      return a.started_at.localeCompare(b.started_at);
  }
}
