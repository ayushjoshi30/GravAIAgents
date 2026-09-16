"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Chip, Eyebrow, Skeleton, type Tone } from "@/components/console/primitives";
import { Button } from "@/components/ui/Button";
import { SelectField, TextField } from "@/components/ui/Field";
import { ApiFailureBanner, UnknownRatherThanEmpty } from "@/components/ui/States";
import { type ApplicationOut, api } from "@/lib/api";
import { formatCount, formatInrCompact } from "@/lib/format";
import { useToken } from "@/lib/session";
import { useResource } from "@/lib/useResource";

/**
 * Applications — the tenant's book as this console holds it.
 *
 * The table this replaced put nine aligned columns behind a horizontal
 * scrollbar, which meant that below about 900px a reader could see an
 * application id or its amount but never both. The row here carries the same
 * nine facts on two lines that reflow, so nothing is lost and nothing is off
 * screen at 400px. Sorting moves out of the column headers into an explicit
 * control, because headers that are secretly buttons are the part of a data
 * table nobody discovers.
 */

/**
 * What this page holds before the API answers, and after it fails to.
 *
 * Nothing. This console used to fall back to a written-out book of applicants,
 * amounts and Aadhaar digits when the API could not be reached; it does not any
 * more, because a lending book that looks real and is not is something somebody
 * will eventually quote. An empty array is the only honest stand-in, and the
 * screen below is careful never to render it as "this tenant has no
 * applications" when the truth is "nobody asked, or the answer never came".
 */
const NO_APPLICATIONS: ApplicationOut[] = [];

/**
 * One page of the projection. Named because the list has to say when it fills
 * up: somebody who cannot find an application needs to know whether it is not
 * in the book or merely past the two hundredth row.
 */
const APPLICATION_PAGE_LIMIT = 200;

/** Sort keys, named after what a reader is looking for rather than the field. */
const SORTS = [
  { value: "", label: "As the API returned them" },
  { value: "external_id", label: "Application id" },
  { value: "applicant_name", label: "Applicant" },
  { value: "product", label: "Product" },
  { value: "status", label: "Status" },
  { value: "loan_amount", label: "Amount" },
  { value: "tenure_months", label: "Tenure" },
  { value: "interest_rate_pct", label: "Rate" },
  { value: "document_count", label: "Documents" },
];

export default function ApplicationsPage() {
  const [token] = useToken();
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("");
  const [descending, setDescending] = useState(false);

  const applications = useResource(
    `applications:${token ?? "none"}`,
    (signal) => api.listApplications(token, { limit: APPLICATION_PAGE_LIMIT }, signal),
    NO_APPLICATIONS,
  );

  /**
   * What the search allows, before the stage chips have their say. The chips
   * count against this set rather than against the final list, so each one says
   * how many rows pressing it would leave — a count taken after the stage filter
   * would read zero on every chip but the pressed one.
   */
  const beforeStage = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return applications.data.filter((application) => {
      if (!needle) return true;
      return (
        application.external_id.toLowerCase().includes(needle) ||
        application.applicant_name.toLowerCase().includes(needle) ||
        application.product.toLowerCase().includes(needle)
      );
    });
  }, [applications.data, query]);

  /**
   * The stages, and how many sit in each.
   *
   * Read off the rows the API returned rather than from a list held here: the
   * lending platform owns this vocabulary, and a hard-coded stage this console
   * has never seen would be a claim about the book that nothing backs. A stage
   * with nothing in it therefore has no chip, because it was never returned.
   */
  const stages = useMemo(() => {
    const byStatus = new Map<string, number>();
    for (const application of beforeStage) {
      byStatus.set(application.status, (byStatus.get(application.status) ?? 0) + 1);
    }
    return [...byStatus.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [beforeStage]);

  /**
   * The chips as they are drawn: every stage the search left standing, plus the
   * stage currently filtered to even when the search has narrowed it to nothing.
   * Without that last part, typing an id while a stage is pressed empties the
   * list and removes the only chip that explains why — which reads as an empty
   * book rather than a filtered one.
   */
  const stageChips = useMemo<[string, number][]>(() => {
    if (!status || stages.some(([value]) => value === status)) return stages;
    return [...stages, [status, 0] as [string, number]].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
  }, [stages, status]);

  const filtered = useMemo(() => {
    const rows = status
      ? beforeStage.filter((application) => application.status === status)
      : beforeStage;
    if (!sort) return rows;
    const direction = descending ? -1 : 1;
    // Copied before sorting: `rows` is already a fresh array here, but the day
    // someone drops the filter above, an in-place sort would start mutating the
    // resource's own data and the "API order" option would quietly stop working.
    return [...rows].sort((a, b) => direction * compare(a, b, sort));
  }, [beforeStage, status, sort, descending]);

  const loading = applications.mode === "loading";
  const failure = applications.failure;
  // Three states, kept apart on purpose: still asking, asked and never found
  // out, asked and told there is nothing. Only the third one may be summarised
  // as a number, so only the third one gets one.
  const answered = !loading && !failure;
  const filtersApplied = Boolean(status || query.trim());

  return (
    <div className="gv-rise space-y-6">
      <header className="min-w-0">
        <Eyebrow>Applications</Eyebrow>
        <h1 className="gv-page-title mt-1.5">Applications</h1>
        <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-ink-2">
          A projection of the lending book for this tenant. The lending platform remains the
          system of record; this view exists so an agent run can be read against the application
          it belongs to.
        </p>
      </header>

      <ApiFailureBanner
        failure={failure}
        onRetry={applications.reload}
        what="applications"
      />

      {/* Three figures stood here: how many applications were listed, what they
          were worth, and how many documents hung off them. None of the three
          changed what anybody did next — the count was a total above the very
          list it totalled, the documents figure was the sum of a column two
          inches below it, and the book's value, though a real business number,
          is not why an underwriter or a collections manager opens this page and
          not something they would act on from here. The count came back as the
          thing it should always have been: a way into the list.

          A group rather than a tablist, because these are toggles over one list
          rather than panels, and every one should be reachable by Tab. */}
      <div
        role="group"
        aria-label="Filter the list by stage"
        className="flex flex-wrap items-center gap-1.5"
      >
        <StageFilterChip
          stage=""
          label="All stages"
          count={answered ? beforeStage.length : null}
          pressed={status === ""}
          onPress={() => setStatus("")}
        />
        {/* Only drawn once the API has answered: chips built from rows nobody
            read would be a list of stages this tenant may not have. */}
        {answered
          ? stageChips.map(([value, count]) => (
              <StageFilterChip
                key={value}
                stage={value}
                label={value.replace(/_/g, " ")}
                count={count}
                pressed={status === value}
                onPress={() => setStatus(value)}
              />
            ))
          : null}
      </div>

      <div className="gv-card grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <TextField
          label="Search"
          value={query}
          onChange={setQuery}
          placeholder="Application id, applicant or product"
          type="search"
        />
        {/* The status dropdown that stood here is gone rather than duplicated:
            the chips above set the same state, name the same stages and carry
            the counts as well, and one filter deserves one control. */}
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

      <section aria-label="Applications" className="gv-card overflow-hidden">
        {loading ? (
          <RowSkeletons />
        ) : failure ? (
          <UnknownRatherThanEmpty>
            No applications are listed because the request above did not succeed. This is not an
            empty book — it is an unknown one, and the difference matters enough that this screen
            will not round it off to zero.
          </UnknownRatherThanEmpty>
        ) : filtered.length === 0 ? (
          <UnknownRatherThanEmpty>
            {filtersApplied
              ? "No application matches these filters. Pressing All stages, or clearing the search term, will widen the set."
              : "This tenant has no applications yet. They appear here as the lending platform creates them and the connector syncs the projection."}
          </UnknownRatherThanEmpty>
        ) : (
          <ul>
            {filtered.map((application) => (
              <ApplicationRow key={application.id} application={application} />
            ))}
          </ul>
        )}
      </section>

      {/* The one thing the "applications listed" figure said that the list
          cannot say for itself, kept, and shown only when it is true: that the
          page filled up and the application somebody is hunting for may be
          sitting just past the end of it. */}
      {answered && applications.data.length >= APPLICATION_PAGE_LIMIT ? (
        <p className="text-[11.5px] leading-relaxed text-ink-3">
          The API returned its full page of {formatCount(APPLICATION_PAGE_LIMIT)} applications and
          stopped there. An application beyond these is not listed and not missing from the book —
          search for its id or the applicant to reach it.
        </p>
      ) : null}

      <p className="text-[11.5px] leading-relaxed text-ink-3">
        Aadhaar is held and displayed as the last four digits only. The full number is never
        stored, so it cannot be returned by the API or exported from this screen.
      </p>
    </div>
  );
}

/**
 * A stage count that is also the filter for that stage.
 *
 * The tone is the one the same stage wears on the rows below, so colour still
 * means outcome and nothing else, and it is spent only where there is an
 * outcome to colour — All stages stays neutral because a book is not itself a
 * verdict. Since the tone is carrying the outcome, the pressed state is carried
 * by the border, the weight of the label and `aria-pressed` rather than by hue.
 */
function StageFilterChip({
  stage,
  label,
  count,
  pressed,
  onPress,
}: {
  stage: string;
  label: string;
  count: number | null;
  pressed: boolean;
  onPress: () => void;
}) {
  const tone: Tone = stage && count ? statusTone(stage) : "slate";
  // The spoken name has to contain the word on the chip, because someone driving
  // this by voice says what they can see. "Every stage" read well and left
  // "All stages" unsayable, so the wording follows the label rather than prose.
  const describes = stage ? `applications at stage ${label}` : "applications at all stages";
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={pressed}
      aria-label={count === null ? `Show ${describes}` : `Show ${describes}, ${formatCount(count)}`}
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

function ApplicationRow({ application }: { application: ApplicationOut }) {
  return (
    <li className="gv-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <Link
          href={`/console/applications/${application.external_id}`}
          className="gv-id text-navy hover:underline"
        >
          {application.external_id}
        </Link>
        <span className="truncate text-sm font-semibold text-ink">
          {application.applicant_name}
        </span>
        <span className="text-[13px] text-ink-3">{application.product}</span>
      </div>

      <Chip tone={statusTone(application.status)}>{application.status.replace(/_/g, " ")}</Chip>

      <dl className="col-span-2 flex flex-wrap gap-x-4 gap-y-0.5">
        <Pair
          label="Amount"
          value={formatInrCompact(Number(application.loan_amount ?? 0) || null)}
        />
        <Pair
          label="Tenure"
          value={application.tenure_months ? `${application.tenure_months}m` : "—"}
        />
        <Pair
          label="Rate"
          value={
            application.interest_rate_pct
              ? `${Number(application.interest_rate_pct).toFixed(2)}%`
              : "—"
          }
        />
        <Pair label="Docs" value={String(application.document_count)} />
        <Pair
          label="Aadhaar"
          value={application.aadhaar_last4 ? `XXXX ${application.aadhaar_last4}` : "—"}
        />
      </dl>
    </li>
  );
}

/** One `label value` pair on the secondary line of a row. */
function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-[11px] text-ink-4">{label}</dt>
      <dd className="font-mono text-[11.5px] text-ink-2">{value}</dd>
    </div>
  );
}

/**
 * Eight rows of the shape that is coming, rather than the word "Loading".
 *
 * The count is fixed at eight because the point of a skeleton is that the page
 * does not jump when the data lands, and eight rows is roughly a screenful.
 */
function RowSkeletons() {
  return (
    <ul aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <li key={index} className="gv-row grid gap-2 px-4 py-3">
          <Skeleton h={14} w="min(60%, 340px)" />
          <Skeleton h={11} w="min(45%, 260px)" />
        </li>
      ))}
    </ul>
  );
}

/** Status colour lives on the chip and nowhere else. */
function statusTone(status: string): Tone {
  if (/(approved|disbursed|verified|active|live|healthy|ok)$/.test(status)) return "green";
  if (/(rejected|failed|revoked|breached)$/.test(status)) return "red";
  if (/(pending|deviation|escalated|hold)/.test(status)) return "amber";
  if (/(review|underwriting|evaluated|processing)/.test(status)) return "navy";
  return "slate";
}

function compare(a: ApplicationOut, b: ApplicationOut, key: string): number {
  switch (key) {
    case "loan_amount":
      return Number(a.loan_amount ?? 0) - Number(b.loan_amount ?? 0);
    case "tenure_months":
      return (a.tenure_months ?? 0) - (b.tenure_months ?? 0);
    case "interest_rate_pct":
      return Number(a.interest_rate_pct ?? 0) - Number(b.interest_rate_pct ?? 0);
    case "document_count":
      return a.document_count - b.document_count;
    case "applicant_name":
      return a.applicant_name.localeCompare(b.applicant_name);
    case "product":
      return a.product.localeCompare(b.product);
    case "status":
      return a.status.localeCompare(b.status);
    default:
      return a.external_id.localeCompare(b.external_id);
  }
}
