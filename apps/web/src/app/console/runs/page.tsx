"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Chip, Eyebrow, Skeleton, type Tone } from "@/components/console/primitives";
import { Button } from "@/components/ui/Button";
import { SelectField, TextField } from "@/components/ui/Field";
import { ApiFailureBanner, UnknownRatherThanEmpty } from "@/components/ui/States";
import { type RunOut, api, runDuration } from "@/lib/api";
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

/**
 * How many runs one page of the API holds. Named because the list has to say
 * so when it hits the cap: a reader who cannot find a run needs to know whether
 * it is absent or merely older than the two hundredth.
 *
 * Two hundred is not a preference, it is the ceiling `GET /v1/runs` enforces
 * (`limit: Query(ge=1, le=200)` in routers/runs.py). This console asked for 500
 * for a while, which FastAPI rejects out of hand with a 422 before the handler
 * ever runs — so the page showed a server error with a valid token and a
 * populated tenant, and the footnote below it could never fire. Raising this
 * above 200 breaks the page again; paging is the way to reach older runs.
 */
const RUN_PAGE_LIMIT = 200;

/**
 * The status axis, which is both the count and the control.
 *
 * Four figures used to sit above this list: total runs, their summed cost,
 * escalations, failures. Nobody acted on the first two here — a total above a
 * list of runs is a number you scroll past to reach the list, and what a run
 * cost is already on its own row, with the budget decision living on Usage. The
 * other two were worth keeping, so they came back as controls: the count still
 * reads, and pressing it narrows the list to exactly the rows it counted.
 *
 * `filters` is the spoken half of each chip's accessible name, and it always
 * contains the visible label, because a speech-input user says the word they
 * can see and the accessible name has to hold it.
 *
 * `match` exists rather than a bare status comparison because escalation is not
 * a status in this API. `AgentRun.escalated` is its own column, set when the
 * agent asks for a person or a validator fails, and it rides alongside whatever
 * status the run finished with — `GET /v1/runs` even filters on it separately
 * from anything else. Counting only `status === "escalated"` therefore drops
 * escalations that succeeded on paper, and an escalation count is a compliance
 * record here rather than a statistic. The price is that the chips overlap: a
 * succeeded-and-escalated run is counted by both, so All is not the sum of the
 * rest. That is the shape of the data, and a count that is right and overlaps
 * beats a count that is tidy and misses people waiting on a decision.
 */
const STATUS_FILTERS: {
  value: string;
  label: string;
  filters: string;
  match: (run: RunOut) => boolean;
}[] = [
  { value: "", label: "All", filters: "runs of all statuses", match: () => true },
  {
    value: "queued",
    label: "Queued",
    filters: "queued runs",
    match: (run) => run.status === "queued",
  },
  {
    value: "running",
    label: "Running",
    filters: "runs still running",
    match: (run) => run.status === "running",
  },
  {
    value: "succeeded",
    label: "Succeeded",
    filters: "runs that succeeded",
    match: (run) => run.status === "succeeded",
  },
  {
    value: "escalated",
    label: "Escalated",
    filters: "runs escalated to a person",
    match: (run) => run.escalated || run.status === "escalated",
  },
  {
    value: "failed",
    label: "Failed",
    filters: "runs that failed",
    match: (run) => run.status === "failed",
  },
  {
    value: "cancelled",
    label: "Cancelled",
    filters: "cancelled runs",
    match: (run) => run.status === "cancelled",
  },
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
    (signal) => api.listRuns(token, { limit: RUN_PAGE_LIMIT }, signal),
    NO_RUNS,
  );

  /**
   * Everything the agent and search filters allow, before the status chips have
   * their say. The chips count against this set rather than against the final
   * list, because a count taken after the status filter would read zero on every
   * chip except the pressed one — which tells a reader nothing about where the
   * failing run they are hunting for actually is.
   */
  const beforeStatus = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return runs.data.filter((run) => {
      if (agentId && run.agent_id !== agentId) return false;
      if (!needle) return true;
      return (
        run.id.toLowerCase().includes(needle) ||
        (run.tenant ?? "").toLowerCase().includes(needle) ||
        (run.application_id ?? "").toLowerCase().includes(needle)
      );
    });
  }, [runs.data, agentId, query]);

  /**
   * One count per chip, taken with the very predicate that chip presses. Tallying
   * by `run.status` instead would be a line shorter and would quietly disagree
   * with the Escalated chip, which matches on the escalation flag — and a count
   * that does not equal what pressing it shows is the one thing a control like
   * this must never do.
   */
  const counts = useMemo(() => {
    const byFilter = new Map<string, number>();
    for (const option of STATUS_FILTERS) {
      byFilter.set(option.value, beforeStatus.filter(option.match).length);
    }
    return byFilter;
  }, [beforeStatus]);

  const filtered = useMemo(() => {
    const chosen = STATUS_FILTERS.find((option) => option.value === status);
    const rows = chosen ? beforeStatus.filter(chosen.match) : beforeStatus;
    if (!sort) return rows;
    const direction = descending ? -1 : 1;
    return [...rows].sort((a, b) => direction * compare(a, b, sort));
  }, [beforeStatus, status, sort, descending]);

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

      {/* A group rather than a tablist: these are seven toggles over one list,
          not seven panels, and a reader tabbing through them should reach each
          one rather than have to discover that arrow keys move between them. */}
      <div
        role="group"
        aria-label="Filter the list by run status"
        className="flex flex-wrap items-center gap-1.5"
      >
        {STATUS_FILTERS.map((option) => (
          <StatusFilterChip
            key={option.value || "all"}
            status={option.value}
            label={option.label}
            filters={option.filters}
            // A count is a figure like any other here, so it appears only once
            // the API has answered. A row of zeroes over an unread history reads
            // as "nothing has failed", which is the one thing it must not say.
            count={answered ? (counts.get(option.value) ?? 0) : null}
            pressed={status === option.value}
            onPress={() => setStatus(option.value)}
          />
        ))}
      </div>

      <div className="gv-card grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <TextField
          label="Search"
          value={query}
          onChange={setQuery}
          placeholder="Run id, tenant or application"
          type="search"
        />
        {/* The status dropdown that stood here is gone rather than duplicated:
            the chips above set the same state, and two controls for one filter
            is a thing to keep in sync on screen and in the head. */}
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

      {/* The "runs returned" figure that used to carry this fact was a total
          above a list of the very rows it totalled. The one thing it said that
          the list cannot is said here instead, and only when it is true: that
          the page filled up and an older run may be out of reach. */}
      {answered && runs.data.length >= RUN_PAGE_LIMIT ? (
        <p className="text-[11.5px] leading-relaxed text-ink-3">
          The API returned its full page of {formatCount(RUN_PAGE_LIMIT)} runs and stopped there,
          newest first. A run older than these is not listed and not absent — search for its id,
          or narrow by agent, to reach it.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A status count that is also the filter for that status.
 *
 * Colour still means one thing: the tone is the outcome the chip counts, the
 * same tone that outcome wears on the rows below, and it appears only when
 * there is something to colour — an amber chip reading zero would signal a
 * queue of escalations that does not exist. Because the tone is spent on
 * outcome, the pressed state is carried by the border, the weight of the label
 * and `aria-pressed`, never by hue alone.
 */
function StatusFilterChip({
  status,
  label,
  filters,
  count,
  pressed,
  onPress,
}: {
  status: string;
  label: string;
  filters: string;
  count: number | null;
  pressed: boolean;
  onPress: () => void;
}) {
  // "All" has no outcome of its own, and neither has a status nothing is in.
  const tone: Tone = status && count ? statusTone(status) : "slate";
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={pressed}
      aria-label={count === null ? `Show ${filters}` : `Show ${filters}, ${formatCount(count)}`}
      className={`gv-chip gv-chip-${tone} h-[26px] border ${
        pressed ? "border-navy font-semibold" : "border-line hover:border-ink-4"
      }`}
    >
      <span aria-hidden="true">{label}</span>
      {count === null ? null : (
        <span aria-hidden="true" className="font-mono">
          {formatCount(count)}
        </span>
      )}
    </button>
  );
}

function RunRow({ run }: { run: RunOut }) {
  const running = run.status === "running";
  // A run can carry the escalation flag and still report the status it finished
  // with, so the status chip alone can hide the fact that somebody is waiting on
  // a decision. Without this, pressing Escalated above listed rows reading
  // "succeeded" with nothing on them to explain why they were returned.
  const escalatedSeparately = run.escalated && run.status !== "escalated";
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
        {escalatedSeparately ? (
          <Chip tone="amber" title="Handed to a person by design. Open the run for the reason.">
            escalated
          </Chip>
        ) : null}
        <Chip tone={statusTone(run.status)}>
          {running ? <span className="gv-dot gv-dot-live" aria-hidden="true" /> : null}
          {run.status}
        </Chip>
      </span>

      <dl className="col-span-2 flex flex-wrap gap-x-4 gap-y-0.5">
        <Pair label="Started" value={formatTimeIst(run.started_at)} />
        {/* Only when the payload carries it. An always-blank Tenant row
            reads as 'this run has no tenant', which is not what is true:
            /v1/runs does not send the field. Every run here belongs to the
            token's tenant by construction, so its absence costs nothing. */}
        {run.tenant ? <Pair label="Tenant" value={run.tenant} /> : null}
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
        <Pair
          label="Duration"
          value={(() => {
            const ms = runDuration(run);
            return ms === null ? "still running" : formatDuration(ms);
          })()}
        />
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
      // Runs still in flight have no duration. They sort last rather than
      // as zero, which would put the longest-running work at the top of an
      // ascending sort as though it had finished instantly.
      return (runDuration(a) ?? Infinity) - (runDuration(b) ?? Infinity);
    case "status":
      return a.status.localeCompare(b.status);
    case "agent_id":
      return a.agent_id.localeCompare(b.agent_id);
    case "tenant":
      return (a.tenant ?? "").localeCompare(b.tenant ?? "");
    default:
      return a.started_at.localeCompare(b.started_at);
  }
}
