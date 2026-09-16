"use client";

import { useMemo, useState } from "react";
import { BacklogProjection, ChartFrame, TrendArea } from "@/components/console/Charts";
import { Chip, Eyebrow, Figure, Skeleton } from "@/components/console/primitives";
import { SegmentedControl, SliderField, ToggleField } from "@/components/ui/Field";
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
} from "@/lib/format";
import { DOC_AI_RPM, RATE_CARD, productLabel } from "@/lib/platform";
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
 * Somebody opens this page to answer one of three questions and then close it:
 * what is this costing us, is throughput being limited right now, and which
 * agent or product is responsible for the bill. Throughput leads because spend
 * is a consequence and capacity is a constraint — knowing what went out last
 * month changes nobody's plan, whereas knowing that the month's documents
 * cannot physically be read at ten requests a minute changes it immediately.
 *
 * WHAT WAS REMOVED, AND WHY IT SHOULD NOT COME BACK. This page carried
 * seventeen figures and four charts. Most of them were true and nobody acted on
 * any of them, which is worse than useless: twenty numbers bury the three that
 * matter. Gone, each for a stated reason rather than for tidiness:
 *
 *   - The four model tiles (quota calls per document, documents per hour,
 *     monthly capacity, utilisation). Every one of them is a cell in the
 *     scenario matrix further down, on the row the reader has selected, and the
 *     verdict card states the same result in a sentence. They were a table's
 *     top row reprinted above the table.
 *   - "Governor tokens free". It is the complement of "Utilisation now" against
 *     the same ceiling: two tiles, one fact, and a reader who has to do the
 *     subtraction to check they agree.
 *   - "Utilisation by hour of a business day". It was drawn from a hard-coded
 *     peaky weight profile — a shape this console made up — and it told the
 *     reader only what the utilisation figure already tells them. A modelled
 *     line is fine as an input to a stated calculation; it is not fine as the
 *     picture of a day that nobody measured.
 *   - Requests, pages read, tokens in, tokens out and audio hours. Volume
 *     trivia. Nothing is decided differently because the month moved 40M tokens
 *     rather than 30M; the bill is in rupees and the rupees are below.
 *   - "Cost per application" and "cost per document". Both divided measured
 *     spend by a number taken from the scenario sliders, so they moved when
 *     somebody dragged a planning control on the other tab. A figure that mixes
 *     a measurement with an assumption is not a unit cost, it is a trap.
 *   - "Spend by tenant" (a pie of a handful of values) and "spend by agent" (ten
 *     bars a person reads as ten numbers). Both are now groupings of the one
 *     breakdown table, which is what they always were. The shapes went; the two
 *     questions they answered — who do we bill, and which agent ran up the
 *     bill — did not, and must not.
 *
 * Two charts survive, and only because neither is a table in disguise: the
 * backlog projection is a curve whose shape is the point, and spend per day is
 * the trajectory a budget is defended against.
 */

/**
 * Consumption and governor state before the API answers: nothing.
 *
 * A written-out month of spend, tokens and pages used to fill this page when
 * `/v1/usage` could not be reached. Invented consumption is invoicing
 * evidence — somebody reconciles a bill against it, or budgets from it — so
 * there is none. The throughput model is different in kind: it is a stated
 * calculation over stated assumptions, and it is derived in front of the reader
 * rather than asserted.
 */
const NO_USAGE: UsageRow[] = [];
const NO_GOVERNOR: GovernorStateOut[] = [];

/**
 * The tab labels name the questions rather than the data.
 *
 * "Throughput" alone did not tell anyone that the live rate-limit state was
 * behind it, so people went looking for the governor elsewhere. The panel ids
 * are unchanged because they are what the tab controls are wired to.
 */
const TABS = [
  { id: "throughput", label: "Throughput & limits" },
  { id: "consumption", label: "Cost" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * Three ways to ask who the bill belongs to, not two.
 *
 * "By tenant" is here because the trim that produced this page dropped the
 * "Spend by tenant" ring, and the objection to that chart was its shape — a
 * handful of slices standing in for a handful of rupee figures — rather than
 * its subject. Tenant is the one breakdown somebody bills against: an
 * underwriter chasing a provider wants the agent, and whoever raises the
 * invoice wants the tenant. It is a first-class column on Runs for the same
 * reason. As a list of named rows it answers the question the ring only
 * gestured at.
 */
const BREAKDOWNS = [
  { value: "product", label: "By product" },
  { value: "agent", label: "By agent" },
  { value: "tenant", label: "By tenant" },
] as const;

type BreakdownId = (typeof BREAKDOWNS)[number]["value"];

/** How many named rows the breakdown lists before it says how many it is hiding. */
const ROW_LIMIT = 10;

/**
 * The model's own account of itself, in one paragraph.
 *
 * This prose now carries the whole verdict: the tiles that used to restate
 * capacity, documents per hour and quota calls per document beside it are gone,
 * so the sentence has to contain them. It reads them out of the same result the
 * matrix below recomputes, so the two can never disagree.
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
  const [breakdown, setBreakdown] = useState<BreakdownId>("product");
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

  // Only rupees are totalled now. The request, page, token and audio sums that
  // used to be computed here fed tiles nobody acted on; the loop that produced
  // them went with the tiles rather than being left to run for nothing.
  const spend = useMemo(
    () => usage.data.reduce((total, row) => total + row.cost_inr, 0),
    [usage.data],
  );

  /**
   * Spend per day, oldest first.
   *
   * The sort is not cosmetic. The previous version of this series took whatever
   * order the API happened to return and plotted it straight onto a time axis,
   * which draws a line that zigzags backwards through the month and reads as
   * volatility that is not there.
   */
  const dailySpend = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of usage.data) map.set(row.date, (map.get(row.date) ?? 0) + row.cost_inr);
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, cost]) => ({ date: date.slice(5), cost: Number(cost.toFixed(2)) }));
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

  /**
   * Agents and tenants both carry requests as well as cost, because either view
   * has to answer the same question the product view does. An agent that only
   * touches unpriced products bills zero rupees while doing real work, and a
   * list that showed cost alone would file it under "costs nothing" rather than
   * under "costs an amount this console cannot price yet".
   */
  const byAgent = useMemo(() => groupByName(usage.data, (row) => row.agent_id), [usage.data]);
  const byTenant = useMemo(() => groupByName(usage.data, (row) => row.tenant), [usage.data]);

  // Agents and tenants are the same row — a name, its requests and its rupees —
  // so they share one list rather than two nearly identical ones. Products keep
  // their own branch because a product row also carries the rate-card chip that
  // says whether its rupees are real.
  const namedRows = breakdown === "agent" ? byAgent : byTenant;
  const shownRows = namedRows.slice(0, ROW_LIMIT);
  const hiddenRows = namedRows.length - shownRows.length;

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

  /**
   * How much of the bucket is in use, or null when there is nothing to divide by.
   *
   * A zero capacity would make this NaN, and the guard here used to substitute
   * zero. That was survivable while "Governor tokens free" stood beside this
   * tile — a reader could see the bucket state twice and notice the two did not
   * agree — and it is not survivable now that utilisation is the only thing the
   * page says about the bucket. A governor reporting no ceiling would have
   * rendered "0%" in unalarmed ink, which is a measurement nobody made dressed
   * as plenty of headroom. Null instead, and the tile says why.
   */
  const liveUtilisation =
    docai && docai.capacity > 0 ? (docai.capacity - docai.available) / docai.capacity : null;

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
          Whether the document pipeline is being held up right now, whether a month&apos;s
          documents can be read at all, and what the reads cost. Every figure below is either
          measured by the API or derived in front of you from the scenario you set; none is
          asserted.
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
          {/* The governor comes first on the default tab, so the live state of
              the queue is the first thing on the page rather than the fourth
              thing on it. It is the only block here that is measured rather
              than modelled, and it is the one somebody opens this page at
              eleven in the morning to look at: work is either waiting for a
              token or it is not. The planning model that used to sit above it
              can wait — nobody plans capacity before they have found out
              whether today is moving. */}
          <section aria-labelledby="governor-now" className="space-y-3">
            <h2 id="governor-now" className="text-[16px] font-semibold text-ink">
              The rate limit, right now
            </h2>

            {/* The governor fails independently of `/v1/usage`, and the banner
                at the top of the page only speaks for consumption. Without this
                one, a reader whose usage loaded and whose governor did not gets
                three em dashes, no HTTP status, no correlation id and no way to
                try again. */}
            <ApiFailureBanner
              failure={governor.failure}
              onRetry={governor.reload}
              what="the governor state"
            />

            {governor.mode === "loading" ? (
              <div className="grid gap-5 sm:grid-cols-3">
                {Array.from({ length: 3 }, (_, index) => (
                  <div key={index} className="grid gap-2">
                    <Skeleton h={10} w="40%" />
                    <Skeleton h={30} w="60%" />
                    <Skeleton h={11} w="80%" />
                  </div>
                ))}
              </div>
            ) : (
              /* Three tiles, not four. "Governor tokens free" was the fourth and
                 it is the same measurement as "Utilisation now" read from the
                 other end of the bucket; keeping both asked the reader to
                 reconcile a count of tokens with a percentage of a ceiling
                 before they could trust either. The ceiling itself is named in
                 the note instead, where it costs no vertical space. */
              <div className="grid gap-5 sm:grid-cols-3">
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
                      ? // The amber is a judgement about the number, so the
                        // judgement is written out as well as coloured: a reader
                        // who cannot see the tone still learns that this wait has
                        // crossed the line the console draws at five minutes.
                        `What a call submitted this second would wait, at the current queue depth.${
                          docai.estimated_wait_seconds > 300 ? " Past the five-minute mark." : ""
                        }`
                      : governorSilence("the wait a call would meet")
                  }
                />
                <Figure
                  label="Utilisation now"
                  value={liveUtilisation === null ? "—" : formatPercent(liveUtilisation, 0)}
                  tone={liveUtilisation !== null && liveUtilisation > 0.85 ? "red" : undefined}
                  pct={liveUtilisation === null ? undefined : liveUtilisation * 100}
                  note={
                    docai && liveUtilisation !== null
                      ? // The denominator is the ceiling the governor reports, not
                        // the one this console is configured for, and when the two
                        // disagree that is itself worth saying: a lower enforced
                        // ceiling changes what can be promised, and a higher one
                        // usually means enforcement is suspended.
                        `${
                          docai.capacity === DOC_AI_RPM
                            ? `Against the ${DOC_AI_RPM} requests per minute ceiling`
                            : `Against the ${formatNumber(docai.capacity, 0)} requests per minute the governor reports, not the ${DOC_AI_RPM} this console is configured for`
                        }, measured rather than modelled.${
                          liveUtilisation > 0.85
                            ? " Past 85%, which is where this console treats the bucket as saturated."
                            : ""
                        }`
                      : docai
                        ? // The governor answered for docai and reported no
                          // ceiling to measure against. Dividing by it would give
                          // NaN and substituting zero would give false comfort, so
                          // the tile reports the hole instead.
                          "The governor reports no ceiling for document intelligence, so there is nothing to measure utilisation against — this tile will not print a percentage of zero."
                        : `${governorSilence("utilisation")} This tile will not model a number the ceiling is supposed to measure.`
                  }
                />
              </div>
            )}
          </section>

          {/* There was a "Governor state, last hour" chart here, drawn from
              sixty invented minutes, and after that a panel explaining at
              length why the chart had gone. Both are now this comment.
              `/v1/usage/governor` reports the bucket as it stands and keeps no
              history, so there is no series to plot and the three figures above
              are the whole of what is measured; a paragraph on screen saying so
              was itself something nobody acts on. The chart returns when the
              endpoint returns a series, and not before — a queue-depth trend is
              exactly the sort of line someone plans capacity against. */}

          {/* The headline this model exists to surface. Computed, not asserted,
              and now carrying the numbers the four tiles below it used to
              repeat. */}
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

            {/* One of the two charts that survived the cut. The shape is the
                point: a backlog that bends toward zero and one that never
                touches it are different decisions, and neither is legible as a
                single "days to drain" figure — which is why the figure is in
                the description and the curve is in the frame. */}
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
                {/* The meter is handed a value capped at the ceiling, and the
                    sentence below it carries the overage instead.

                    This is not cosmetic. `Meter` clamps any ratio above 1.5 to
                    1.5 and then prints its own "Over capacity by N%" line from
                    the clamped value, so the default scenario — demand at eight
                    times capacity — rendered "Over capacity by 50%" directly
                    beneath a verdict card reading "Demand is 8.0x the available
                    capacity". One of those two numbers was wrong by an order of
                    magnitude, and it was the one drawn in fail red next to a
                    bar, which is the one a reader quotes. Capping the input
                    stops the component printing that line at all; a full bar
                    now means "at or past the ceiling" and the words say by how
                    much. */}
                <Meter
                  value={Math.min(result.utilisation, 1)}
                  max={1}
                  tone={
                    result.utilisation > 1 ? "fail" : result.utilisation > 0.8 ? "amber" : "brand"
                  }
                  label="Steady-state utilisation against capacity"
                />
                <p
                  className={`mt-1 text-[11.5px] font-medium ${
                    result.utilisation > 1 ? "text-fail" : "text-ink-3"
                  }`}
                >
                  {result.utilisation > 1
                    ? `Over capacity: steady-state demand is ${formatNumber(result.utilisation, 1)}x what the ceiling supports.`
                    : `${formatPercent(result.utilisation, 0)} of the ceiling used at steady state.`}
                </p>
              </div>
            </Panel>
          </div>

          <section aria-labelledby="matrix" className="gv-card overflow-hidden">
            <div className="border-b border-line-2 px-4 py-3">
              <h2 id="matrix" className="text-[15px] font-semibold text-ink">
                The two assumptions, side by side
              </h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
                Each row recomputes the whole model; the selected row is the scenario set on the
                left. This is the strip that decides whether the question is worth putting to the
                provider.
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
            <div className="grid gap-3 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
              <div className="grid gap-2">
                <Skeleton h={10} w="50%" />
                <Skeleton h={30} w="70%" />
                <Skeleton h={11} w="90%" />
              </div>
              <Skeleton h={240} />
            </div>
          ) : !answered ? (
            <Panel title="Nothing to report">
              <p className="text-[13px] leading-relaxed text-ink-2">
                No spend figure and no breakdown is shown, because none was read. Consumption
                figures are what a bill gets reconciled against and what a budget gets set from,
                so an unread month is reported as unread rather than as a quiet zero. The note
                above carries the reason and a way to try again.
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
              {/* One figure and one chart: what the window cost, and whether it
                  is accelerating. The five tiles that used to stand beside the
                  spend figure — requests, pages, tokens in, tokens out, audio —
                  counted things nobody spends, and the request count in
                  particular was the sum of a column in the table below. */}
              <div className="grid gap-3 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
                <div className="gv-card p-5">
                  <Figure
                    label="Spend, this window"
                    value={formatInrCompact(spend)}
                    note={
                      unsetRateCardRows > 0
                        ? `A floor, not a total: ${formatCount(unsetRateCardRows)} of ${formatCount(RATE_CARD.length)} rate-card rows have no contracted price yet, and work priced at those rows bills as zero here.`
                        : "Every rate-card row has a contracted price, so this is the whole of it."
                    }
                  />
                </div>

                <ChartFrame
                  title="Spend per day"
                  description="Rupee cost by day, oldest first, on the same floor as the figure beside it. The slope is what a month-end budget gets defended against."
                  height={240}
                >
                  <TrendArea
                    data={dailySpend}
                    xKey="date"
                    series={[{ key: "cost", label: "Spend" }]}
                    formatter={(value) => formatInrCompact(value)}
                  />
                </ChartFrame>
              </div>

              {/* One table, three groupings, rather than a pie of tenants, a
                  bar chart of agents and a table of products. The question
                  people actually arrive with is "who is responsible for this
                  bill", and it is answered by reading down a column — which is
                  what the bar chart and the ring were making them do anyway,
                  only through a picture. The tenant grouping is here because
                  that question has two answers depending on who is asking:
                  operations wants the agent, billing wants the tenant. */}
              <section aria-labelledby="breakdown" className="gv-card overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-2 px-4 py-3">
                  <div className="min-w-0">
                    <h2 id="breakdown" className="text-[15px] font-semibold text-ink">
                      Where the spend went
                    </h2>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
                      {breakdown === "product"
                        ? "Requests and rupee cost against the pinned rate card. A product with no contracted rate still shows its requests, because that is the work the bill is missing."
                        : breakdown === "agent"
                          ? "Requests and rupee cost per agent, highest spend first. An agent that only calls unpriced products bills nothing and still does work."
                          : "Requests and rupee cost per tenant, highest spend first — the attribution an invoice is raised from. Only tenants this token can see are counted."}
                    </p>
                  </div>
                  <SegmentedControl
                    label="Break the spend down by"
                    value={breakdown}
                    options={[...BREAKDOWNS]}
                    onChange={(value) => setBreakdown(value as BreakdownId)}
                  />
                </div>

                {breakdown === "product" ? (
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
                ) : (
                  <>
                    <ul>
                      {shownRows.map((row) => (
                        <li key={row.name} className="gv-row grid gap-x-3 gap-y-1 px-4 py-2.5">
                          {/* Agent ids are snake_case machine names and read as
                              words once the underscores go. A tenant id is an
                              identifier that Runs and the audit trail print
                              verbatim, so it stays exactly as the API sent it —
                              a prettified tenant name is one somebody cannot
                              search for. */}
                          <span className="min-w-0 text-[13px] font-medium text-ink">
                            {breakdown === "agent" ? row.name.replace(/_/g, " ") : row.name}
                          </span>
                          <dl className="flex flex-wrap gap-x-4 gap-y-0.5">
                            <Pair label="Requests" value={formatCount(row.requests)} />
                            <Pair label="Cost" value={formatInr(row.cost)} />
                          </dl>
                        </li>
                      ))}
                    </ul>
                    {/* A truncated list that does not say it is truncated is a
                        list somebody adds up and finds short of the spend
                        figure above. */}
                    {hiddenRows > 0 ? (
                      <p className="border-t border-line-2 px-4 py-2.5 text-[12.5px] text-ink-3">
                        {formatCount(hiddenRows)} further{" "}
                        {breakdown === "agent"
                          ? hiddenRows === 1
                            ? "agent is"
                            : "agents are"
                          : hiddenRows === 1
                            ? "tenant is"
                            : "tenants are"}{" "}
                        not listed. Their spend is in the figure above.
                      </p>
                    ) : null}
                  </>
                )}
              </section>
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

/**
 * Requests and rupees per name, heaviest spend first.
 *
 * Agents and tenants are grouped identically, so they are grouped by the same
 * function rather than by two loops that could drift apart. The secondary sort
 * on requests is what keeps the order sensible when every cost is zero: with an
 * incomplete rate card that is the normal case, not the edge case, and a sort
 * on cost alone would shuffle those rows arbitrarily between renders.
 */
function groupByName(
  rows: UsageRow[],
  name: (row: UsageRow) => string,
): { name: string; requests: number; cost: number }[] {
  const map = new Map<string, { name: string; requests: number; cost: number }>();
  for (const row of rows) {
    const key = name(row);
    const bucket = map.get(key) ?? { name: key, requests: 0, cost: 0 };
    bucket.requests += row.requests;
    bucket.cost += row.cost_inr;
    map.set(key, bucket);
  }
  return Array.from(map.values())
    .map((bucket) => ({ ...bucket, cost: Number(bucket.cost.toFixed(2)) }))
    .sort((a, b) => b.cost - a.cost || b.requests - a.requests);
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-[11px] text-ink-4">{label}</dt>
      <dd className="font-mono text-[11.5px] text-ink-2">{value}</dd>
    </div>
  );
}
