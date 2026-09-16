"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Chip, Eyebrow, Figure, Skeleton, type Tone } from "@/components/console/primitives";
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
    (signal) => api.listApplications(token, { limit: 200 }, signal),
    NO_APPLICATIONS,
  );

  const statuses = useMemo(
    () => Array.from(new Set(applications.data.map((a) => a.status))).sort(),
    [applications.data],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = applications.data.filter((application) => {
      if (status && application.status !== status) return false;
      if (!needle) return true;
      return (
        application.external_id.toLowerCase().includes(needle) ||
        application.applicant_name.toLowerCase().includes(needle) ||
        application.product.toLowerCase().includes(needle)
      );
    });

    if (!sort) return rows;
    const direction = descending ? -1 : 1;
    // Copied before sorting: `rows` is already a fresh array here, but the day
    // someone drops the filter above, an in-place sort would start mutating the
    // resource's own data and the "API order" option would quietly stop working.
    return [...rows].sort((a, b) => direction * compare(a, b, sort));
  }, [applications.data, status, query, sort, descending]);

  const totals = useMemo(() => {
    const book = filtered.reduce((sum, a) => sum + Number(a.loan_amount ?? 0), 0);
    const documents = filtered.reduce((sum, a) => sum + a.document_count, 0);
    const priced = filtered.filter((a) => a.loan_amount).length;
    return { book, documents, priced };
  }, [filtered]);

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

      <div className="grid gap-5 sm:grid-cols-3">
        <Figure
          label="Applications listed"
          value={answered ? formatCount(filtered.length) : "—"}
          note={
            !answered
              ? "Nothing has been counted, because nothing has been read."
              : filtersApplied
                ? `Matching these filters, out of ${formatCount(applications.data.length)} returned.`
                : "Every application the API returned for this token, capped at 200."
          }
        />
        <Figure
          label="Book value"
          value={answered ? formatInrCompact(totals.book) : "—"}
          note={
            answered
              ? `Sum of the loan amounts on ${formatCount(totals.priced)} of the ${formatCount(filtered.length)} rows below. The rest carry no amount yet.`
              : "A book value is a sum of rows. There are no rows."
          }
        />
        <Figure
          label="Documents"
          value={answered ? formatCount(totals.documents) : "—"}
          note="Attached to these applications. Each one costs quota to read."
        />
      </div>

      <div className="gv-card grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <TextField
          label="Search"
          value={query}
          onChange={setQuery}
          placeholder="Application id, applicant or product"
          type="search"
        />
        <SelectField
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: "All statuses" },
            ...statuses.map((value) => ({ value, label: value.replace(/_/g, " ") })),
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
              ? "No application matches these filters. Clearing the status or the search term will widen the set."
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

      <p className="text-[11.5px] leading-relaxed text-ink-3">
        Aadhaar is held and displayed as the last four digits only. The full number is never
        stored, so it cannot be returned by the API or exported from this screen.
      </p>
    </div>
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
