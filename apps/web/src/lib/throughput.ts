/**
 * The throughput and backlog model.
 *
 * This is the live version of the spreadsheet cost model. Every number it
 * produces is derived from four published facts and the scenario the operator
 * selects — nothing is fitted, smoothed or estimated:
 *
 *   1. Document Intelligence is asynchronous: one document is one submit,
 *      N status polls and one results fetch.
 *   2. Extract with back-off (0.8 s first, x1.35 growth, 5.0 s cap) settles at
 *      about 10 polls on a ~30 s job. Flat 0.8 s polling takes 37.
 *   3. Digitise returns text, so it needs one extra LLM read that extract
 *      never incurs. That call is billable but does not draw on the Doc AI
 *      quota.
 *   4. The Doc AI ceiling is 10 requests per minute, shared by both paths and
 *      uniform across plan tiers.
 *
 * The one genuinely unknown input is whether status polls count against the
 * limit (DECISIONS.md D-005). GravAI assumes they do. The toggle exists so the
 * consequence of that assumption is visible rather than buried.
 */

import { DOC_AI_RPM, VOLUME } from "./platform";

export interface ThroughputScenario {
  /** Requests per minute the Doc AI governor allows. */
  docaiRpm: number;
  /** DECISIONS.md D-005. Default true: the conservative reading. */
  pollsCountTowardLimit: boolean;
  /** DECISIONS.md D-006. Default true: back-off applied to both paths. */
  digitiseBackedOff: boolean;
  /** Share of documents routed to digitise rather than extract, 0 to 1. */
  digitiseShare: number;
  /** Hours per day the platform is actually submitting work. */
  businessHoursPerDay: number;
  /** Working days per month used for the monthly capacity figure. */
  businessDaysPerMonth: number;
  /** Documents waiting when the drain starts. */
  backlogDocuments: number;
  /** Expected steady-state monthly document volume. */
  documentsPerMonth: number;
}

export const DEFAULT_SCENARIO: ThroughputScenario = {
  docaiRpm: DOC_AI_RPM,
  pollsCountTowardLimit: true,
  digitiseBackedOff: true,
  digitiseShare: 0.2,
  businessHoursPerDay: 10,
  businessDaysPerMonth: 22,
  backlogDocuments: 25_000,
  documentsPerMonth: VOLUME.documentsPerMonth,
};

export const EXTRACT_POLLS = 10;
export const DIGITISE_POLLS_BACKED_OFF = 10;
export const DIGITISE_POLLS_FLAT = 37;

export interface PerDocumentCalls {
  submit: number;
  polls: number;
  results: number;
  llmReads: number;
  /** Every AI call the document costs, billable or not. */
  total: number;
  /** Calls that draw on the 10/min Document Intelligence bucket. */
  quota: number;
}

export function extractCalls(pollsCount: boolean): PerDocumentCalls {
  const polls = EXTRACT_POLLS;
  return {
    submit: 1,
    polls,
    results: 1,
    llmReads: 0,
    total: 1 + polls + 1,
    quota: pollsCount ? 1 + polls + 1 : 2,
  };
}

export function digitiseCalls(pollsCount: boolean, backedOff: boolean): PerDocumentCalls {
  const polls = backedOff ? DIGITISE_POLLS_BACKED_OFF : DIGITISE_POLLS_FLAT;
  return {
    submit: 1,
    polls,
    results: 1,
    llmReads: 1,
    total: 1 + polls + 1 + 1,
    quota: pollsCount ? 1 + polls + 1 : 2,
  };
}

export interface ThroughputResult {
  extract: PerDocumentCalls;
  digitise: PerDocumentCalls;
  /** Mix-weighted quota calls consumed by one average document. */
  quotaCallsPerDocument: number;
  /** Mix-weighted total AI calls for one average document. */
  totalCallsPerDocument: number;
  documentsPerMinute: number;
  documentsPerHour: number;
  documentsPerBusinessDay: number;
  documentsPerCalendarDay: number;
  monthlyCapacityDocuments: number;
  /** Steady-state demand against business-hours capacity, 0 to 1+. */
  utilisation: number;
  /** Business days to clear the backlog on top of steady-state demand. */
  backlogDrainDays: number | null;
  /** Business days to clear the backlog if nothing new arrived. */
  backlogDrainDaysIdle: number;
  /** Documents per business day left over after steady-state demand. */
  spareDocumentsPerBusinessDay: number;
  monthlyQuotaCalls: number;
  monthlyTotalCalls: number;
}

export function computeThroughput(scenario: ThroughputScenario): ThroughputResult {
  const share = Math.min(1, Math.max(0, scenario.digitiseShare));
  const extract = extractCalls(scenario.pollsCountTowardLimit);
  const digitise = digitiseCalls(scenario.pollsCountTowardLimit, scenario.digitiseBackedOff);

  const quotaCallsPerDocument = extract.quota * (1 - share) + digitise.quota * share;
  const totalCallsPerDocument = extract.total * (1 - share) + digitise.total * share;

  const documentsPerMinute = scenario.docaiRpm / quotaCallsPerDocument;
  const documentsPerHour = documentsPerMinute * 60;
  const documentsPerBusinessDay = documentsPerHour * scenario.businessHoursPerDay;
  const documentsPerCalendarDay = documentsPerHour * 24;
  const monthlyCapacityDocuments = documentsPerBusinessDay * scenario.businessDaysPerMonth;

  const utilisation =
    monthlyCapacityDocuments > 0 ? scenario.documentsPerMonth / monthlyCapacityDocuments : 0;

  const demandPerBusinessDay = scenario.documentsPerMonth / scenario.businessDaysPerMonth;
  const spareDocumentsPerBusinessDay = documentsPerBusinessDay - demandPerBusinessDay;

  const backlogDrainDays =
    spareDocumentsPerBusinessDay > 0
      ? scenario.backlogDocuments / spareDocumentsPerBusinessDay
      : null;

  const backlogDrainDaysIdle =
    documentsPerBusinessDay > 0 ? scenario.backlogDocuments / documentsPerBusinessDay : Infinity;

  return {
    extract,
    digitise,
    quotaCallsPerDocument,
    totalCallsPerDocument,
    documentsPerMinute,
    documentsPerHour,
    documentsPerBusinessDay,
    documentsPerCalendarDay,
    monthlyCapacityDocuments,
    utilisation,
    backlogDrainDays,
    backlogDrainDaysIdle,
    spareDocumentsPerBusinessDay,
    monthlyQuotaCalls: scenario.documentsPerMonth * quotaCallsPerDocument,
    monthlyTotalCalls: scenario.documentsPerMonth * totalCallsPerDocument,
  };
}

/** Backlog remaining, business day by business day, for the projection chart. */
export function backlogSeries(
  scenario: ThroughputScenario,
  result: ThroughputResult,
  days = 30,
): { day: number; remaining: number }[] {
  const series: { day: number; remaining: number }[] = [];
  let remaining = scenario.backlogDocuments;
  const drainPerDay = result.spareDocumentsPerBusinessDay;
  for (let day = 0; day <= days; day += 1) {
    series.push({ day, remaining: Math.max(0, Math.round(remaining)) });
    remaining -= drainPerDay;
    if (remaining < 0) remaining = 0;
  }
  return series;
}

/** The four corner cases of the two unverified assumptions, side by side. */
export function scenarioMatrix(
  base: ThroughputScenario,
): { label: string; pollsCount: boolean; backedOff: boolean; result: ThroughputResult }[] {
  const combinations: { label: string; pollsCount: boolean; backedOff: boolean }[] = [
    { label: "Polls count · back-off on", pollsCount: true, backedOff: true },
    { label: "Polls count · back-off off", pollsCount: true, backedOff: false },
    { label: "Polls free · back-off on", pollsCount: false, backedOff: true },
    { label: "Polls free · back-off off", pollsCount: false, backedOff: false },
  ];

  return combinations.map((combination) => ({
    ...combination,
    result: computeThroughput({
      ...base,
      pollsCountTowardLimit: combination.pollsCount,
      digitiseBackedOff: combination.backedOff,
    }),
  }));
}

/**
 * Utilisation by hour of a business day, given a submission profile.
 * Month-end batches are the reason the fair-share queue exists, so the
 * default profile is deliberately peaky rather than flat.
 */
export function hourlyUtilisation(
  result: ThroughputResult,
  profile: number[],
): { hour: string; utilisation: number; documents: number }[] {
  const totalWeight = profile.reduce((sum, weight) => sum + weight, 0) || 1;
  const dailyDocuments = result.documentsPerBusinessDay;
  return profile.map((weight, index) => {
    const documents = (weight / totalWeight) * dailyDocuments * profile.length * 0.5;
    const capacityPerHour = result.documentsPerHour;
    return {
      hour: `${String(index + 8).padStart(2, "0")}:00`,
      utilisation: capacityPerHour > 0 ? Math.min(1.4, documents / capacityPerHour) : 0,
      documents: Math.round(documents),
    };
  });
}
