"use client";

import { useMemo, useState } from "react";
import {
  BacklogProjection,
  ChartFrame,
  SharePie,
  StackedBars,
  TrendArea,
  UtilisationLine,
} from "@/components/console/Charts";
import { Chip, Eyebrow, Figure, Skeleton } from "@/components/console/primitives";
import { SliderField, ToggleField } from "@/components/ui/Field";
import { Meter } from "@/components/ui/Stat";
import { ApiFailureBanner, InlineNote } from "@/components/ui/States";
import { Panel } from "@/components/ui/Surface";
import { api, type GovernorStateOut, type UsageRow } from "@/lib/api";
import {
  formatCompactNumber,
  formatCount,
  formatDays,
  formatInr,
  formatInrCompact,
  formatNumber,
  formatPercent,
  formatTokens,
} from "@/lib/format";
import { DOC_AI_RPM, RATE_CARD, VOLUME, productLabel } from "@/lib/platform";
import { useToken } from "@/lib/session";
import {
  DEFAULT_SCENARIO,
  backlogSeries,
  computeThroughput,
  scenarioMatrix,
  type ThroughputResult,
  type ThroughputScenario,
} from "@/lib/throughput";
import { useResource } from "@/lib/useResource";

/**
 * Platform › Usage.
 *
 * Throughput leads and consumption follows, which is a reversal of the old
 * page. The reason is that spend is a consequence and capacity is a
 * constraint: knowing what went out last month changes nobody's plan,
 * whereas knowing that the month's documents cannot physically be read at ten
 * requests a minute changes it immediately.
 */

/**
 * A deliberately peaky submission profile: month-end batches are not flat.
 *
 * This is a shape the throughput model is driven with, not a measurement, and
 * the chart that renders it says so. It stays because it is an input to a
 * declared model — unlike the consumption figures below, which are only ever
 * reported, never assumed.
 */
const HOURLY_PROFILE = [0.4, 0.9, 1.3, 1.6, 1.4, 0.7, 1.1, 1.5, 1.2, 0.6, 0.3, 0.2];

/**
 * Consumption and governor state before the API answers: nothing.
 *
 * A written-out month of spend, tokens and pages used to fill this page when
 * `/v1/usage` could not be reached. Invented consumption is invoicing
 * evidence — somebody reconciles a bill against it, or budgets from it — so
 * there is none. The throughput model above is different in kind: it is a
 * stated calculation over stated assumptions, and it is derived in front of the
 * reader rather than asserted.
 */
const NO_USAGE: UsageRow[] = [];
const NO_GOVERNOR: GovernorStateOut[] = [];

const TABS = [
  { id: "throughput", label: "Throughput" },
  { id: "consumption", label: "Consumption" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * The model's own account of itself, in one paragraph.
 *
 * The handoff calls for `describeScenario()` from `lib/throughput.ts`; no such
 * export exists in this codebase, and this agent does not own that file, so the
 * prose lives beside the page that renders it. That is the right place for it
 * anyway — `throughput.ts` computes numbers and has no business holding
 * sentences — but it is worth lifting into the library the day a second screen
 * needs the same summary.
 */
function describeScenario(
  scenario: ThroughputScenario,
  result: ThroughputResult,
): { strained: boolean; headline: string; body: string } {
  const capacity = Math.round(result.monthlyCapacityDocuments);
  const perDocument = formatNumber(result.quotaCallsPerDocument, 1);
  const preamble = `At ${scenario.docaiRpm} requests per minute and ${perDocument} quota calls per document, the ceiling supports ${formatCount(capacity)} documents a month across ${scenario.businessHoursPerDay} hours a day.`;

  if (result.utilisation > 1) {
    const continuous = Math.round(result.documentsPerCalendarDay * 30);
    const shortfall = formatNumber(scenario.documentsPerMonth / continuous, 1);
    return {
      strained: true,
      headline: `Demand is ${formatNumber(result.utilisation, 1)}x the available capacity.`,
      body: `${preamble} Demand is ${formatCount(scenario.documentsPerMonth)}. Running continuously rather than ${scenario.businessHoursPerDay} hours a day gives ${formatCount(continuous)} a month, which is still ${shortfall}x short. This is why whether status polls count against the limit is the single highest-value question to put to the provider, and why a committed-rate plan is a named open item.`,
    };
  }

  const spare = Math.round(result.spareDocumentsPerBusinessDay);
  return {
    strained: false,
    headline: `Demand fits, with ${formatCount(spare)} documents a business day to spare.`,
    body: `${preamble} Demand is ${formatCount(scenario.documentsPerMonth)}, so the spare capacity is what a backlog drains into${
      result.backlogDrainDays === null
        ? "."
        : `: ${formatCount(scenario.backlogDocuments)} documents clear in ${formatDays(result.backlogDrainDays)} of business days.`
    }`,
  };
}

export default function UsagePage() {
  const [token] = useToken();
  const [tab, setTab] = useState<TabId>("throughput");
  const [scenario, setScenario] = useState<ThroughputScenario>(DEFAULT_SCENARIO);

  const usage = useResource(
    `usage-dash:${token ?? "none"}`,
    (signal) => api.usage(token, {}, signal),
    NO_USAGE,
  );

  const governor = useResource(
    `governor-dash:${token ?? "none"}`,
    (signal) => api.governor(token, signal),
    NO_GOVERNOR,
  );

  const result = useMemo(() => computeThroughput(scenario), [scenario]);
  const projection = useMemo(() => backlogSeries(scenario, result, 30), [scenario, result]);
  const matrix = useMemo(() => scenarioMatrix(scenario), [scenario]);
  const summary = useMemo(() => describeScenario(scenario, result), [scenario, result]);

  const hourly = useMemo(
    () =>
      HOURLY_PROFILE.map((weight, index) => {
        const documents = weight * result.documentsPerHour;
        return {
          hour: `${String(index + 8).padStart(2, "0")}:00`,
          utilisation: Number(Math.min(1.6, weight).toFixed(2)),
          documents: Math.round(documents),
        };
      }),
    [result],
  );

  const totals = useMemo(() => {
    let cost = 0;
    let requests = 0;
    let pages = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let audio = 0;
    for (const row of usage.data) {
      cost += row.cost_inr;
      requests += row.requests;
      pages += row.pages;
      inputTokens += row.input_tokens;
      outputTokens += row.output_tokens;
      audio += row.audio_seconds;
    }
    return { cost, requests, pages, inputTokens, outputTokens, audio };
  }, [usage.data]);

  const byTenant = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of usage.data) map.set(row.tenant, (map.get(row.tenant) ?? 0) + row.cost_inr);
    return Array.from(map.entries())
      .map(([name, value]) => ({ name, value: Number(value.toFixed(2)) }))
      .sort((a, b) => b.value - a.value);
  }, [usage.data]);

  const byProduct = useMemo(() => {
    const map = new Map<
      string,
      { product: string; label: string; requests: number; cost: number }
    >();
    for (const row of usage.data) {
      const bucket = map.get(row.product) ?? {
        product: row.product,
        label: row.label ?? productLabel(row.product),
        requests: 0,
        cost: 0,
      };
      bucket.requests += row.requests;
      bucket.cost += row.cost_inr;
      map.set(row.product, bucket);
    }
    return Array.from(map.values())
      .map((row) => ({ ...row, cost: Number(row.cost.toFixed(2)) }))
      .sort((a, b) => b.cost - a.cost);
  }, [usage.data]);

  const byAgent = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of usage.data)
      map.set(row.agent_id, (map.get(row.agent_id) ?? 0) + row.cost_inr);
    return Array.from(map.entries())
      .map(([agent, cost]) => ({ agent: agent.replace(/_/g, " "), cost: Number(cost.toFixed(2)) }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10);
  }, [usage.data]);

  const dailyRequests = useMemo(() => {
    const map = new Map<string, { date: string; docai: number; llm: number; speech: number }>();
    for (const row of usage.data) {
      const bucket = map.get(row.date) ?? { date: row.date.slice(5), docai: 0, llm: 0, speech: 0 };
      if (row.product.startsWith("docai")) bucket.docai += row.requests;
      else if (row.product.startsWith("llm")) bucket.llm += row.requests;
      else bucket.speech += row.requests;
      map.set(row.date, bucket);
    }
    return Array.from(map.values());
  }, [usage.data]);

  const docai = governor.data.find((row) => row.product === "docai");

  /**
   * Why the tiles below do not simply say "the endpoint did not answer".
   *
   * There are two ways to end up without a `docai` bucket and they are not the
   * same fact. Either the governor could not be read at all, or it answered and
   * reported no document-intelligence ceiling for this tenant. Printing the
   * first sentence in the second case sends a reader to look at an endpoint
   * that is working, which is the same class of mistake as dressing an empty
   * list as an error — it just costs somebody an afternoon instead of a
   * decision.
   */
  const governorSilence = (about: string) =>
    governor.failure
      ? `The governor state could not be read${
          governor.failure.status ? ` (HTTP ${governor.failure.status})` : ""
        }, so ${about} is unknown — not zero.`
      : `The governor answered with no document-intelligence bucket, so ${about} is not reported for this ceiling.`;

  // A zero capacity would make this NaN rather than a percentage, and a tile
  // that renders "NaN%" is read as a bug in the console rather than as the
  // missing ceiling it actually is.
  const liveUtilisation =
    docai && docai.capacity > 0 ? (docai.capacity - docai.available) / docai.capacity : 0;

  const applicationsCovered = Math.round(
    scenario.documentsPerMonth / VOLUME.documentsPerApplication,
  );
  const costPerApplication = applicationsCovered > 0 ? totals.cost / applicationsCovered : 0;
  const costPerDocument =
    totals.pages > 0 ? totals.cost / (totals.pages / VOLUME.pagesPerDocument) : 0;

  const loading = usage.mode === "loading";
  // Consumption figures are reported only when the API reported them. A total
  // of zero and a total nobody read look identical on a tile, and one of them
  // ends up in a budget.
  const answered = !loading && !usage.failure;
  const unsetRateCardRows = RATE_CARD.filter((row) => row.inrPerUnit === null).length;

  const reload = () => {
    usage.reload();
    governor.reload();
  };

  return (
    <div className="gv-rise space-y-6">
      <header className="min-w-0">
        <Eyebrow>Platform · Usage</Eyebrow>
        <h1 className="gv-page-title mt-1.5">Usage</h1>
        <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-ink-2">
          The throughput model that decides whether a month&apos;s documents can be read at all,
          and the consumption those reads produce. This is the live version of the volume
          spreadsheet: every figure below is derived, none is asserted.
        </p>
      </header>

      <ApiFailureBanner failure={usage.failure} onRetry={reload} what="usage figures" />

      <div role="tablist" aria-label="Usage views" className="flex gap-0.5 border-b border-line-2">
        {TABS.map((item) => {
          const on = item.id === tab;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`usage-tab-${item.id}`}
              aria-selected={on}
              aria-controls={`usage-panel-${item.id}`}
              onClick={() => setTab(item.id)}
              className={`box-border inline-flex h-10 items-center border-b-2 px-3.5 text-sm font-medium ${
                on ? "border-navy text-ink" : "border-transparent text-ink-3 hover:text-ink"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === "throughput" ? (
        <div
          role="tabpanel"
          id="usage-panel-throughput"
          aria-labelledby="usage-tab-throughput"
          className="space-y-5"
        >
          {/* The headline this model exists to surface. Computed, not asserted. */}
          <section className="gv-card p-5">
            <div className="flex flex-wrap items-center gap-2.5">
              <Eyebrow>What the model says about this scenario</Eyebrow>
              <Chip tone={summary.strained ? "amber" : "green"}>
                {summary.strained ? "Over capacity" : "Within capacity"}
              </Chip>
            </div>
            <p className="mt-2 max-w-4xl text-[clamp(15px,1.5vw,17px)] leading-snug font-semibold text-ink">
              {summary.headline}
            </p>
            <p className="mt-2 max-w-4xl text-[13.5px] leading-relaxed text-ink-2">
              {summary.body}
            </p>
          </section>

          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            <Figure
              label="Quota calls per document"
              value={formatNumber(result.quotaCallsPerDocument, 1)}
              note={`Mix-weighted: extract costs ${result.extract.quota}, digitise costs ${result.digitise.quota}.`}
            />
            <Figure
              label="Documents per hour"
              value={formatNumber(result.documentsPerHour, 0)}
              note={`${formatNumber(result.documentsPerBusinessDay, 0)} per business day at ${scenario.businessHoursPerDay} hours.`}
            />
            <Figure
              label="Monthly capacity"
              value={formatCount(Math.round(result.monthlyCapacityDocuments))}
              note={`Documents, over ${scenario.businessDaysPerMonth} business days. Not a billing limit — a physical one.`}
            />
            <Figure
              label="Utilisation"
              value={formatPercent(result.utilisation, 0)}
              tone={result.utilisation > 1 ? "red" : result.utilisation > 0.8 ? "amber" : "green"}
              pct={result.utilisation * 100}
              note={
                result.utilisation > 1
                  ? "Demand exceeds capacity, so the backlog grows rather than drains."
                  : "Steady-state demand against the ceiling this scenario implies."
              }
            />
          </div>

          <section aria-labelledby="governor-now" className="space-y-3">
            <h2 id="governor-now" className="text-[16px] font-semibold text-ink">
              The governor, right now
            </h2>

            {/* The governor fails independently of `/v1/usage`, and the banner
                at the top of the page only speaks for consumption. Without this
                one, a reader whose usage loaded and whose governor did not gets
                four em dashes, no HTTP status, no correlation id and no way to
                try again. */}
            <ApiFailureBanner
              failure={governor.failure}
              onRetry={governor.reload}
              what="the governor state"
            />

            {governor.mode === "loading" ? (
              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }, (_, index) => (
                  <div key={index} className="grid gap-2">
                    <Skeleton h={10} w="40%" />
                    <Skeleton h={30} w="60%" />
                    <Skeleton h={11} w="80%" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                <Figure
                  label="Governor tokens free"
                  value={docai ? docai.available.toFixed(1) : "—"}
                  tone={docai && liveUtilisation > 0.85 ? "amber" : undefined}
                  note={
                    docai
                      ? `Of ${DOC_AI_RPM}. The bucket refills continuously, one token every six seconds.`
                      : governorSilence("the bucket state")
                  }
                />
                <Figure
                  label="Queue depth"
                  value={docai ? formatCount(docai.queue_depth) : "—"}
                  note={
                    docai
                      ? `Calls waiting for a token, from ${docai.tenants_waiting} tenants sharing the same ceiling.`
                      : governorSilence("the queue depth")
                  }
                />
                <Figure
                  label="Expected wait"
                  value={docai ? `${formatNumber(docai.estimated_wait_seconds / 60, 1)} min` : "—"}
                  tone={docai && docai.estimated_wait_seconds > 300 ? "amber" : undefined}
                  note={
                    docai
                      ? "What a call submitted this second would wait, at the current queue depth."
                      : governorSilence("the wait a call would meet")
                  }
                />
                <Figure
                  label="Utilisation now"
                  value={docai ? formatPercent(liveUtilisation, 0) : "—"}
                  tone={docai && liveUtilisation > 0.85 ? "red" : undefined}
                  pct={docai ? liveUtilisation * 100 : undefined}
                  note={
                    docai
                      ? `Against the ${DOC_AI_RPM} requests per minute ceiling, measured rather than modelled.`
                      : `${governorSilence("utilisation")} This tile will not model a number the ceiling is supposed to measure.`
                  }
                />
              </div>
            )}

            <div className="grid gap-3 lg:grid-cols-2">
              {/* There was a "Governor state, last hour" chart here, drawn from
                  sixty invented minutes. `/v1/usage/governor` reports the
                  bucket as it is now and keeps no history, so the chart was a
                  picture of a past that never happened — and a queue-depth
                  trend is exactly the sort of line someone plans capacity
                  against. It returns when the endpoint returns a series. */}
              <Panel
                title="Governor state over time"
                description="One point per minute for the last hour, once the API records one."
              >
                <p className="text-[13px] leading-relaxed text-ink-2">
                  The governor endpoint reports the bucket as it stands right now; it keeps no
                  history, so there is no series to plot. The four figures above are the whole of
                  what is measured. A trend drawn from anything else would be a capacity
                  planning input this platform invented for itself.
                </p>
              </Panel>

              <ChartFrame
                title="Utilisation by hour of a business day"
                description="Modelled from the scenario below, not measured: submission is peaky, not flat, and the ceiling does not move to accommodate a month-end batch."
                height={240}
              >
                <UtilisationLine
                  data={hourly}
                  xKey="hour"
                  valueKey="utilisation"
                  ceiling={1}
                  formatter={(value) => `${(value * 100).toFixed(0)}%`}
                />
              </ChartFrame>
            </div>
          </section>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <Panel
              title="Scenario"
              description="Two of these inputs are unverified assumptions. Both are toggles so the consequence is visible rather than argued about."
            >
              <div className="space-y-4">
                <ToggleField
                  label="Status polls count toward the limit"
                  checked={scenario.pollsCountTowardLimit}
                  onChange={(checked) =>
                    setScenario((current) => ({ ...current, pollsCountTowardLimit: checked }))
                  }
                  hint="DECISIONS.md D-005. GravAI assumes they do — the conservative reading. If they do not, only the submit and the results fetch draw on quota."
                />
                <ToggleField
                  label="Back-off applied to the digitise path"
                  checked={scenario.digitiseBackedOff}
                  onChange={(checked) =>
                    setScenario((current) => ({ ...current, digitiseBackedOff: checked }))
                  }
                  hint="DECISIONS.md D-006. Off reproduces the previous behaviour: flat 0.8 s polling, 37 polls on a 30 second job."
                />
                <SliderField
                  label="Documents routed to digitise"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(scenario.digitiseShare * 100)}
                  display={`${Math.round(scenario.digitiseShare * 100)}%`}
                  onChange={(value) =>
                    setScenario((current) => ({ ...current, digitiseShare: value / 100 }))
                  }
                />
                <SliderField
                  label="Business hours per day"
                  min={4}
                  max={24}
                  step={1}
                  value={scenario.businessHoursPerDay}
                  display={`${scenario.businessHoursPerDay} h`}
                  onChange={(value) =>
                    setScenario((current) => ({ ...current, businessHoursPerDay: value }))
                  }
                />
                <SliderField
                  label="Documents per month"
                  min={10_000}
                  max={200_000}
                  step={2_500}
                  value={scenario.documentsPerMonth}
                  display={formatCount(scenario.documentsPerMonth)}
                  onChange={(value) =>
                    setScenario((current) => ({ ...current, documentsPerMonth: value }))
                  }
                />
                <SliderField
                  label="Backlog to drain"
                  min={0}
                  max={150_000}
                  step={2_500}
                  value={scenario.backlogDocuments}
                  display={formatCount(scenario.backlogDocuments)}
                  onChange={(value) =>
                    setScenario((current) => ({ ...current, backlogDocuments: value }))
                  }
                />
                <button
                  type="button"
                  onClick={() => setScenario(DEFAULT_SCENARIO)}
                  className="font-mono text-[11px] text-ink-3 underline underline-offset-2 hover:text-ink"
                >
                  reset to platform defaults
                </button>
              </div>
            </Panel>

            <Panel
              title="Backlog drain projection"
              description={
                result.backlogDrainDays === null
                  ? "Demand exceeds capacity in this scenario, so the backlog does not drain — it grows."
                  : `Clears in ${formatDays(result.backlogDrainDays)} of business days on top of steady-state demand. With no new work arriving: ${formatDays(result.backlogDrainDaysIdle)}.`
              }
              bodyClassName="p-3"
            >
              <div style={{ height: 240 }}>
                <BacklogProjection
                  data={projection}
                  formatter={(value) => formatCompactNumber(Math.round(value))}
                />
              </div>
              <div className="mt-3">
                <Meter
                  value={result.utilisation}
                  max={1}
                  tone={
                    result.utilisation > 1 ? "fail" : result.utilisation > 0.8 ? "amber" : "brand"
                  }
                  label="Steady-state utilisation against capacity"
                />
              </div>
            </Panel>
          </div>

          <section aria-labelledby="matrix" className="gv-card overflow-hidden">
            <div className="border-b border-line-2 px-4 py-3">
              <h2 id="matrix" className="text-[15px] font-semibold text-ink">
                The two assumptions, side by side
              </h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
                Each row recomputes the whole model. This is the strip that decides whether the
                question is worth putting to the provider.
              </p>
            </div>
            <ul>
              {matrix.map((row) => {
                const current =
                  row.pollsCount === scenario.pollsCountTowardLimit &&
                  row.backedOff === scenario.digitiseBackedOff;
                return (
                  <li
                    key={row.label}
                    className={`gv-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 ${
                      current ? "bg-navy-tint" : ""
                    }`}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium text-ink">{row.label}</span>
                      {current ? <Chip tone="navy">Selected</Chip> : null}
                    </span>
                    <Chip tone={row.result.utilisation > 1 ? "red" : "green"}>
                      {formatPercent(row.result.utilisation, 0)} used
                    </Chip>
                    <dl className="col-span-2 flex flex-wrap gap-x-4 gap-y-0.5">
                      <Pair
                        label="Quota calls / doc"
                        value={formatNumber(row.result.quotaCallsPerDocument, 1)}
                      />
                      <Pair
                        label="Docs / hour"
                        value={formatNumber(row.result.documentsPerHour, 0)}
                      />
                      <Pair
                        label="Monthly capacity"
                        value={formatCount(Math.round(row.result.monthlyCapacityDocuments))}
                      />
                      <Pair
                        label="Backlog drain"
                        value={
                          row.result.backlogDrainDays === null
                            ? "never"
                            : formatDays(row.result.backlogDrainDays)
                        }
                      />
                    </dl>
                  </li>
                );
              })}
            </ul>
          </section>

          <InlineNote>
            The per-document call model is not an estimate. Extract is one submit, about ten
            back-off polls and one results fetch — twelve calls. Digitise with the same back-off
            is twelve Document Intelligence calls plus one language-model read of the text it
            returns — thirteen. Flat 0.8 second polling on a thirty second job is thirty-seven
            polls, which is where forty comes from. Only the Document Intelligence calls draw on
            the ten-per-minute bucket.
          </InlineNote>
        </div>
      ) : (
        <div
          role="tabpanel"
          id="usage-panel-consumption"
          aria-labelledby="usage-tab-consumption"
          className="space-y-5"
        >
          {loading ? (
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-6">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="grid gap-2">
                  <Skeleton h={10} w="50%" />
                  <Skeleton h={30} w="70%" />
                </div>
              ))}
            </div>
          ) : !answered ? (
            <Panel title="Nothing to report">
              <p className="text-[13px] leading-relaxed text-ink-2">
                No spend, request count, page count or token total is shown, because none was
                read. Consumption figures are what a bill gets reconciled against and what a
                budget gets set from, so an unread month is reported as unread rather than as a
                quiet zero. The note above carries the reason and a way to try again.
              </p>
            </Panel>
          ) : usage.data.length === 0 ? (
            <Panel title="No usage recorded">
              <p className="text-[13px] leading-relaxed text-ink-2">
                The API answered with no usage rows for this window. Nothing has been billed
                because nothing has been consumed — which is a different statement from the one
                above, and worth keeping distinct.
              </p>
            </Panel>
          ) : (
            <>
              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-6">
                <Figure
                  label="Spend"
                  value={formatInrCompact(totals.cost)}
                  note="Priced rate-card rows only."
                />
                <Figure
                  label="Requests"
                  value={formatCount(totals.requests)}
                  note="Billable calls across every product."
                />
                <Figure
                  label="Pages read"
                  value={formatCount(totals.pages)}
                  note="Document pages, the unit both extract and digitise are priced in."
                />
                <Figure
                  label="Tokens in"
                  value={formatTokens(totals.inputTokens)}
                  note="Sent to the language model."
                />
                <Figure
                  label="Tokens out"
                  value={formatTokens(totals.outputTokens)}
                  note="Returned by it, and the part that is priced higher."
                />
                <Figure
                  label="Audio"
                  value={`${formatNumber(totals.audio / 3600, 1)} h`}
                  note="Speech processed, billed by the second."
                />
              </div>

              {/* Both captions below used to read the dossier out loud — which
                  product dominated, which tenant carried the volume. Those were
                  true of data that no longer exists, and stated over a real
                  tenant's spend they are findings this console never made. A
                  caption may say what a chart counts; it may not say what the
                  chart is about to show. */}
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                <ChartFrame
                  title="Requests per day by product group"
                  description="Counted as billable calls, so a polled document read contributes one request per poll rather than one per document."
                  height={270}
                >
                  <TrendArea
                    data={dailyRequests}
                    xKey="date"
                    series={[
                      { key: "docai", label: "Document intelligence" },
                      { key: "llm", label: "Model" },
                      { key: "speech", label: "Speech" },
                    ]}
                    formatter={(value) => formatCompactNumber(value)}
                  />
                </ChartFrame>

                <ChartFrame
                  title="Spend by tenant"
                  description="Rupee cost attributed to each tenant this token can see, over the window above."
                  height={270}
                >
                  <SharePie data={byTenant} formatter={(value) => formatInrCompact(value)} />
                </ChartFrame>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <ChartFrame
                  title="Spend by agent"
                  description="Top ten agents by rupee cost."
                  height={260}
                >
                  <StackedBars
                    data={byAgent}
                    xKey="agent"
                    series={[{ key: "cost", label: "₹ cost" }]}
                    stacked={false}
                    formatter={(value) => formatInrCompact(value)}
                  />
                </ChartFrame>

                <section aria-labelledby="by-product" className="gv-card overflow-hidden">
                  <div className="border-b border-line-2 px-4 py-3">
                    <h2 id="by-product" className="text-[15px] font-semibold text-ink">
                      By product
                    </h2>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
                      Requests and rupee cost against the pinned rate card.
                    </p>
                  </div>
                  {byProduct.length === 0 ? (
                    <p className="px-6 py-10 text-center text-[13px] leading-relaxed text-ink-3">
                      No usage has been recorded in this window, so there is nothing to price.
                    </p>
                  ) : (
                    <ul>
                      {byProduct.map((row) => {
                        const rate = RATE_CARD.find((card) => card.product === row.product);
                        const priced = rate?.inrPerUnit !== null && rate?.inrPerUnit !== undefined;
                        return (
                          <li
                            key={row.product}
                            className="gv-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5"
                          >
                            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
                              <span className="text-[13px] font-medium text-ink">{row.label}</span>
                              <span className="gv-id text-ink-4">{row.product}</span>
                            </span>
                            {priced ? (
                              <Chip tone="slate" mono>
                                ₹{rate.inrPerUnit!.toFixed(2)}/{rate.unit}
                              </Chip>
                            ) : (
                              <Chip tone="amber">Rate not set</Chip>
                            )}
                            <dl className="col-span-2 flex flex-wrap gap-x-4 gap-y-0.5">
                              <Pair label="Requests" value={formatCount(row.requests)} />
                              <Pair label="Cost" value={formatInr(row.cost)} />
                            </dl>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </div>

              <div className="grid gap-5 sm:grid-cols-3">
                <Figure
                  label="Cost per application"
                  value={formatInr(costPerApplication)}
                  note={`Spend above divided over the ${formatCount(applicationsCovered)} applications this scenario's document volume implies.`}
                />
                <Figure
                  label="Cost per document"
                  value={formatInr(costPerDocument)}
                  note={`Derived from pages read at ${VOLUME.pagesPerDocument} pages per document, not from a per-document price.`}
                />
                <Figure
                  label="Rate card rows unset"
                  value={formatCount(unsetRateCardRows)}
                  tone={unsetRateCardRows > 0 ? "amber" : undefined}
                  note="Left blank rather than guessed, which is why the spend figure is a floor and not a total."
                />
              </div>
            </>
          )}

          <InlineNote tone="amber">
            Only two rate card rows are confirmed by a tenant contract: extract at ₹1.00 per page
            and digitise at ₹0.50 per page. The language and speech rows are deliberately unset.
            A guessed unit price propagates silently into every cost figure on this page, so they
            stay blank until a contract fills them.
          </InlineNote>
        </div>
      )}
    </div>
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

