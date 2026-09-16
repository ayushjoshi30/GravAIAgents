"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ConsolePage } from "@/components/console/ConsoleShell";
import { RunGraph, toStepGraph } from "@/components/console/RunGraph";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { SegmentedControl } from "@/components/ui/Field";
import { SimpleTable } from "@/components/ui/DataTable";
import { DataModeBanner, InlineNote } from "@/components/ui/States";
import { Meter, StatTile } from "@/components/ui/Stat";
import { DefinitionRow, Panel } from "@/components/ui/Surface";
import {
  api,
  type ApplicationOut,
  type AuditEntryOut,
  type EligibilityOut,
  type RunOut,
  runDuration,
} from "@/lib/api";
import {
  formatCount,
  formatDateTimeIst,
  formatDuration,
  formatInr,
  formatInrCompact,
} from "@/lib/format";
import { useToken } from "@/lib/session";
import { useResource } from "@/lib/useResource";

/**
 * One application, as the API holds it.
 *
 * This screen used to carry eight tabs. Five of them — documents, the credit
 * memorandum, the risk band, the calls and the consent registry — were drawn
 * entirely from a hand-written dossier, because no endpoint exists to fill
 * them. On a lending-compliance screen that is not a preview of a feature, it
 * is a fabricated case file: a named applicant, a scored probability of
 * default, a consent artefact with an expiry date, none of which any system
 * ever produced. Somebody screenshots that, or quotes the FOIR out of it, and
 * the fabrication has become a decision.
 *
 * They are gone rather than reduced to five panels reading "not available",
 * which would be honest but dead by construction — the same reasoning
 * `lib/review-model.ts` gives for refusing to model task fields the API cannot
 * populate. What this console genuinely cannot show yet is said once, in prose,
 * on the overview. When those endpoints ship, the tab comes back with the data
 * behind it, in that order.
 *
 * The three tabs that remain each stand on a real call: `/v1/applications/{id}`
 * with its eligibility arithmetic, `/v1/runs` for the agent runs, and
 * `/v1/audit` filtered to this application for the decision trail.
 */

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "graph", label: "Run graph" },
  { value: "trail", label: "Decision trail" },
];

const NO_RUNS: RunOut[] = [];
const NO_ENTRIES: AuditEntryOut[] = [];

export default function ApplicationDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [token] = useToken();
  const [tab, setTab] = useState("overview");

  // No stand-in application. The page used to borrow the first example
  // applicant and relabel it with whatever id was in the URL, which meant a
  // wrong id produced a complete, confident, entirely invented case file.
  const application = useResource<ApplicationOut | null>(
    `application:${id}:${token ?? "none"}`,
    (signal) => api.getApplication(token, id, signal),
    null,
  );

  // Eligibility is arithmetic the API performs in code. A worked example of it
  // is indistinguishable on screen from a computed one, which is exactly why
  // there is no longer a worked example.
  const eligibility = useResource<EligibilityOut | null>(
    `eligibility:${id}:${token ?? "none"}`,
    (signal) => api.eligibility(token, id, signal),
    null,
  );

  // `/v1/runs` takes no application filter yet, so the association is made here
  // from the page the endpoint does return. That is a real limitation and the
  // panel below says so rather than implying the list is exhaustive.
  const runs = useResource<RunOut[]>(
    `application-runs:${id}:${token ?? "none"}`,
    (signal) => api.listRuns(token, { limit: 200 }, signal),
    NO_RUNS,
  );

  const audit = useResource<AuditEntryOut[]>(
    `application-audit:${id}:${token ?? "none"}`,
    (signal) => api.listAudit(token, { entityId: id, limit: 200 }, signal),
    NO_ENTRIES,
  );

  const data = application.data;
  const eligible = eligibility.data;

  const relatedRuns = useMemo(() => {
    const identifiers = new Set([id, data?.external_id, data?.id].filter(Boolean) as string[]);
    return runs.data.filter((run) => run.application_id && identifiers.has(run.application_id));
  }, [runs.data, id, data]);

  const trail = audit.data;

  const reloadAll = () => {
    application.reload();
    eligibility.reload();
  };

  // Without the application record there is nothing to be about. Every tile,
  // every ratio and every link below would be reporting on a case this console
  // never read, so none of them is drawn.
  if (!data) {
    return (
      <ConsolePage
        title={id || "Application"}
        description="This application could not be read from the API."
        actions={
          <Link href="/console/applications" className="gv-link text-[13px]">
            All applications
          </Link>
        }
      >
        <DataModeBanner
          mode={application.mode}
          failure={application.failure}
          onRetry={reloadAll}
          what="this application"
        />
        {application.mode === "loading" ? (
          <div
            className="gv-skeleton h-[220px] w-full"
            role="status"
            aria-label="Loading the application"
          />
        ) : (
          <Panel title="Nothing to show">
            <p className="text-[13px] leading-relaxed text-ink-2">
              Nothing about this application is displayed, because nothing about it was
              returned. An applicant, an amount and a status are the sort of thing that gets
              read off a screen and acted on, so this console will not supply them from
              anywhere but the API. The note above carries the reason, the correlation id if
              the API sent one, and a way to try again.
            </p>
          </Panel>
        )}
      </ConsolePage>
    );
  }

  return (
    <ConsolePage
      title={data.external_id}
      description={
        <>
          {data.applicant_name} · {data.product} · <StatusBadge status={data.status} />
        </>
      }
      actions={
        <Link href="/console/applications" className="gv-link text-[13px]">
          All applications
        </Link>
      }
    >
      <DataModeBanner
        mode={application.mode}
        failure={application.failure}
        onRetry={reloadAll}
        what="this application"
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile
          label="Loan amount"
          value={formatInrCompact(data.loan_amount ? Number(data.loan_amount) : null)}
          note={data.tenure_months ? `${data.tenure_months} months` : undefined}
        />
        <StatTile
          label="Proposed EMI"
          value={eligible?.proposed_emi_display ?? "—"}
          accent="brand"
          note={eligible ? "Computed in code, never by a model" : "Not returned by the API"}
        />
        <StatTile
          label="FOIR"
          value={eligible?.foir_display ?? "—"}
          accent={eligible?.foir && Number(eligible.foir) > 0.5 ? "fail" : "ink"}
          note={eligible ? "Cap comes from the BRE" : "Not returned by the API"}
        />
        <StatTile label="LTV" value={eligible?.ltv_display ?? "—"} />
        <StatTile
          label="Documents"
          value={formatCount(data.document_count)}
          accent="blue"
          note="Attached to this application. Each one costs quota to read."
        />
      </div>

      {/* Eligibility fails independently of the application: the record can be
          readable while the arithmetic endpoint is not. Saying which one is
          missing is the difference between a fixable problem and a mystery. */}
      {!eligible && eligibility.mode !== "loading" ? (
        <InlineNote tone="amber">
          The eligibility arithmetic could not be read
          {eligibility.failure?.status ? ` (HTTP ${eligibility.failure.status})` : ""}, so the EMI,
          FOIR and LTV above are blank rather than estimated.{" "}
          {eligibility.failure?.message}{" "}
          <button
            type="button"
            onClick={eligibility.reload}
            className="font-medium text-ink-2 underline underline-offset-2 hover:text-ink"
          >
            Try again
          </button>
        </InlineNote>
      ) : null}

      {eligible && eligible.missing_inputs.length > 0 ? (
        <InlineNote tone="amber">
          Eligibility could not be fully computed. Missing inputs:{" "}
          <span className="font-mono">{eligible.missing_inputs.join(", ")}</span>. These are
          reported rather than estimated — an invented denominator is worse than a blank field.
        </InlineNote>
      ) : null}

      <SegmentedControl label="Section" value={tab} options={TABS} onChange={setTab} />

      {tab === "overview" ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title="Application">
            <dl>
              <DefinitionRow term="External id" mono>
                {data.external_id}
              </DefinitionRow>
              <DefinitionRow term="GravAI id" mono>
                {data.id}
              </DefinitionRow>
              <DefinitionRow term="Applicant">{data.applicant_name}</DefinitionRow>
              <DefinitionRow term="Aadhaar" mono>
                {data.aadhaar_last4 ? `XXXX XXXX ${data.aadhaar_last4}` : "—"}
              </DefinitionRow>
              <DefinitionRow term="Product">{data.product}</DefinitionRow>
              <DefinitionRow term="Status">
                <StatusBadge status={data.status} />
              </DefinitionRow>
              <DefinitionRow term="Net monthly income" mono>
                {formatInr(data.net_monthly_income)}
              </DefinitionRow>
              <DefinitionRow term="Existing EMI" mono>
                {formatInr(data.existing_monthly_emi)}
              </DefinitionRow>
              <DefinitionRow term="Collateral value" mono>
                {formatInr(data.collateral_value)}
              </DefinitionRow>
            </dl>
          </Panel>

          <Panel
            title="Eligibility arithmetic"
            description="Shown with the formula that produced it, because a ratio without its inputs is not evidence."
          >
            {eligible ? (
              <>
                <dl>
                  <DefinitionRow term="EMI formula" mono>
                    {eligible.formula.emi ?? "—"}
                  </DefinitionRow>
                  <DefinitionRow term="FOIR formula" mono>
                    {eligible.formula.foir ?? "—"}
                  </DefinitionRow>
                  <DefinitionRow term="LTV formula" mono>
                    {eligible.formula.ltv ?? "—"}
                  </DefinitionRow>
                </dl>
                <div className="mt-4 space-y-3">
                  <div>
                    <p className="mb-1 flex items-baseline justify-between text-[12.5px] text-ink-2">
                      <span>FOIR against a 50% cap</span>
                      <span className="font-mono" data-numeric="">
                        {eligible.foir_display ?? "—"}
                      </span>
                    </p>
                    <Meter
                      value={Number(eligible.foir ?? 0)}
                      max={0.5}
                      tone={Number(eligible.foir ?? 0) > 0.5 ? "fail" : "brand"}
                      label="FOIR against cap"
                    />
                  </div>
                  <div>
                    <p className="mb-1 flex items-baseline justify-between text-[12.5px] text-ink-2">
                      <span>LTV against a 90% band</span>
                      <span className="font-mono" data-numeric="">
                        {eligible.ltv_display ?? "—"}
                      </span>
                    </p>
                    <Meter
                      value={Number(eligible.ltv ?? 0)}
                      max={0.9}
                      tone={Number(eligible.ltv ?? 0) > 0.9 ? "fail" : "blue"}
                      label="LTV against band"
                    />
                  </div>
                </div>
              </>
            ) : (
              <p className="text-[13px] leading-relaxed text-ink-2">
                {eligibility.mode === "loading"
                  ? "Reading the eligibility arithmetic…"
                  : "No formula and no ratio are shown, because none was returned. A meter drawn against a number this console invented would be the most quotable lie on the page."}
              </p>
            )}
          </Panel>

          <Panel
            title="Agent runs on this application"
            description="Matched on the application id the run carries, over the most recent runs the API returned."
            bodyClassName="p-0"
            className="lg:col-span-2"
          >
            {runs.mode === "loading" ? (
              <p className="px-3 py-6 text-center text-[13px] text-ink-3">Reading runs…</p>
            ) : runs.failure ? (
              <p className="px-3 py-6 text-center text-[13px] leading-relaxed text-ink-3">
                {runs.failure.kind === "not-implemented"
                  ? "The runs endpoint has not shipped in the API build this console is pointed at, so whether an agent has run on this application is not knowable from here."
                  : `Runs could not be read${runs.failure.status ? ` (HTTP ${runs.failure.status})` : ""}, so none is listed. That is not the same as none existing.`}
              </p>
            ) : (
              <SimpleTable head={["Run", "Agent", "Status", "Cost", "Duration"]}>
                {relatedRuns.map((run) => (
                  <tr key={run.id} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2 font-mono text-[12px]">
                      <Link href={`/console/runs/${run.id}`} className="gv-link">
                        {run.id}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono text-[12px] text-ink-2">{run.agent_id}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[12px]" data-numeric="">
                      {formatInr(run.cost_inr)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[12px]" data-numeric="">
                      {formatDuration(runDuration(run))}
                    </td>
                  </tr>
                ))}
                {relatedRuns.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-[13px] text-ink-3">
                      No runs recorded against this application.
                    </td>
                  </tr>
                ) : null}
              </SimpleTable>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <InlineNote>
              A full dossier for an application also covers the documents and their extractions,
              the credit memorandum and its BRE outcomes, the risk band and its drivers, the
              calls placed and the consents captured. The API exposes no endpoint for any of
              those yet, so this screen shows none of them. It previously showed all five,
              written by hand — which on a compliance screen is not a preview, it is a fabricated
              case file. Each tab returns when the endpoint behind it does.
            </InlineNote>
          </div>
        </div>
      ) : null}

      {tab === "graph" ? (
        relatedRuns.length > 0 ? (
          <RunGraphTab runs={relatedRuns} />
        ) : (
          <Panel title="Run graph">
            <p className="text-[13px] leading-relaxed text-ink-2">
              {runs.mode === "loading"
                ? "Reading the runs on this application…"
                : runs.failure
                  ? "No graph is drawn, because the run list could not be read. A graph is a picture of work that happened; this one would be a picture of a guess."
                  : "No agent run is recorded against this application, so there is no graph to draw. One appears here as soon as an agent runs on it."}
            </p>
          </Panel>
        )
      ) : null}

      {tab === "trail" ? (
        <Panel
          title="Decision trail"
          description="Every agent step, human action and timestamp recorded against this application, in chain order. Printable as an annexure to the memorandum."
          bodyClassName="p-0"
        >
          {audit.mode === "loading" ? (
            <p className="px-4 py-8 text-center text-[13px] text-ink-3">Reading the trail…</p>
          ) : audit.failure ? (
            <p className="px-4 py-8 text-center text-[13px] leading-relaxed text-ink-3">
              The trail could not be read
              {audit.failure.status ? ` (HTTP ${audit.failure.status})` : ""}, so no entry is
              listed. An unreadable trail is not an empty one, and this screen will not print a
              blank annexure as though the chain held nothing.
            </p>
          ) : (
            <>
              <ol className="divide-y divide-[var(--gv-line)]">
                {trail.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5"
                  >
                    <span className="font-mono text-[11px] text-ink-3" data-numeric="">
                      #{entry.seq}
                    </span>
                    <span className="font-mono text-[12.5px] text-ink">{entry.action}</span>
                    <Badge tone={entry.actor_type === "user" ? "blue" : "neutral"}>
                      {entry.actor_type}
                    </Badge>
                    <span className="text-[12.5px] text-ink-2">{entry.actor_id}</span>
                    <span className="ml-auto font-mono text-[11px] text-ink-3">
                      {formatDateTimeIst(entry.recorded_at)}
                    </span>
                  </li>
                ))}
                {trail.length === 0 ? (
                  <li className="px-4 py-8 text-center text-[13px] text-ink-3">
                    No audit entries recorded against this application.
                  </li>
                ) : null}
              </ol>
              <div className="border-t border-line px-4 py-2.5">
                <Link href="/console/audit" className="gv-link text-[12.5px]">
                  Open the audit explorer and verify the chain
                </Link>
              </div>
            </>
          )}
        </Panel>
      ) : null}
    </ConsolePage>
  );
}

/**
 * The run graph for one of the runs on this application.
 *
 * Split out rather than inlined so that the run detail is fetched only when
 * someone opens the tab. An application has several runs against it and the
 * other tabs have no use for any of them; loading one on every visit to the
 * page would be a request paid for by everybody to serve the few who look.
 */
function RunGraphTab({ runs }: { runs: RunOut[] }) {
  const [token] = useToken();
  const [picked, setPicked] = useState(runs[0].id);
  const runId = runs.some((run) => run.id === picked) ? picked : runs[0].id;

  const detail = useResource<RunOut | null>(
    `run:${runId}:${token ?? "none"}`,
    (signal) => api.getRun(token, runId, signal),
    null,
  );

  const steps = useMemo(() => toStepGraph(detail.data?.steps ?? []), [detail.data]);
  const chosen = runs.find((run) => run.id === runId);

  return (
    <div className="space-y-3">
      {/* The page already carries a data-mode banner for the application. A
          second full banner about the run would be noise, but silence would not
          do either — the run's provenance is its own fact. A chip states it
          once, in the row it belongs to. */}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="run-graph-pick" className="text-[12.5px] text-ink-2">
          Run
        </label>
        <select
          id="run-graph-pick"
          value={runId}
          onChange={(event) => setPicked(event.target.value)}
          className="gv-input h-8 w-auto max-w-full font-mono text-[12.5px]"
        >
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {run.id} · {run.agent_id}
            </option>
          ))}
        </select>
        <Link href={`/console/runs/${runId}`} className="gv-link text-[12.5px]">
          Open the full run
        </Link>
        {detail.mode === "live" ? (
          <span className="gv-chip gv-chip-green">
            <span className="gv-dot bg-ok" aria-hidden="true" />
            Live
          </span>
        ) : null}
        {detail.failure ? (
          <button
            type="button"
            onClick={detail.reload}
            className="text-[12.5px] font-medium text-ink-2 underline underline-offset-2 hover:text-ink"
          >
            Retry
          </button>
        ) : null}
      </div>

      {detail.mode === "loading" ? (
        <div className="gv-skeleton h-[200px] w-full" role="status" aria-label="Loading the run" />
      ) : detail.data ? (
        <RunGraph steps={steps} runId={runId} title={chosen?.agent_id} />
      ) : (
        <Panel title="Run graph">
          <p className="text-[13px] leading-relaxed text-ink-2">
            This run&rsquo;s steps could not be read
            {detail.failure?.status ? ` (HTTP ${detail.failure.status})` : ""}, so no graph is
            drawn. {detail.failure?.message}
          </p>
        </Panel>
      )}
    </div>
  );
}
