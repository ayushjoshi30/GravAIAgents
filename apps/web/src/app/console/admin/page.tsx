"use client";

import Link from "next/link";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Chip, Eyebrow, Figure, Skeleton, type Tone } from "@/components/console/primitives";
import { Button } from "@/components/ui/Button";
import { ApiFailureBanner, InlineNote } from "@/components/ui/States";
import { ScrollX } from "@/components/ui/Surface";
import { api, request, type ConnectorOut, type McpSurfaceOut } from "@/lib/api";
import { formatInr } from "@/lib/format";
import { LANGUAGES, RATE_CARD, productLabel } from "@/lib/platform";
import { useToken } from "@/lib/session";
import { useConnection, useResource } from "@/lib/useResource";

/**
 * Administration — tenants, people, credentials, prompt versions, rate cards,
 * connector readiness and the state of the system itself.
 *
 * This page was briefly a redirect into Settings, on the argument that both
 * held read-only facts about a deployment. That argument confused two different
 * questions. Settings answers "how is this browser connected?", which is about
 * the person sitting in front of it; Administration answers "how is this
 * deployment configured, and by whom?", which is about the platform and is the
 * same answer for everybody. Folding the second into the first also quietly
 * deleted six sections rather than stating what was missing, so a reader could
 * not tell the difference between a section that had been removed and one that
 * had never existed.
 *
 * Both are restored here, and each section states which of the two it is.
 * Three cases are kept apart everywhere on this page, because collapsing them
 * throws away the fact a reader needs next:
 *
 *   no token           — nothing was asked for; the fix is in Settings
 *   the request failed — reported with the HTTP status and, where the API sent
 *                        one, the correlation id that finds it in the API's logs
 *   nothing came back  — the API answered, and the answer was empty
 *
 * A fourth case is specific to this page: several sections have no endpoint
 * behind them in this build at all. Those say so in words and draw no table. An
 * empty table with seven column headings is a promise that rows would appear if
 * only you had a token, and for the user directory, webhooks and the prompt
 * registry that promise would be false.
 *
 * Nothing here is written by hand except the rate card, which carries its
 * provenance in its own column and is labelled as a local declaration rather
 * than an API read. The production build of this page filled the tenants table
 * with invented lenders and invented rupee budgets behind an amber "example
 * data" banner. Invented money is the worst thing this page could carry —
 * somebody reconciles a bill against it — so there is none.
 */

const SECTIONS = [
  { id: "tenants", label: "Tenants" },
  { id: "users", label: "Users & roles" },
  { id: "credentials", label: "API keys & MCP" },
  { id: "webhooks", label: "Webhooks" },
  { id: "prompts", label: "Prompt versions" },
  { id: "ratecards", label: "Rate cards" },
  { id: "connectors", label: "Connectors" },
  { id: "status", label: "System status" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function AdminPage() {
  const [section, setSection] = useState<SectionId>("tenants");
  const [token] = useToken();

  /**
   * Arrow keys move between sections, as a tab strip is required to.
   *
   * Without this the eight buttons are eight separate tab stops, which is not
   * what `role="tablist"` promises a screen-reader user; they are told this is
   * one control and then find it behaves like eight. The roving `tabIndex`
   * below is the other half of the same contract.
   */
  const onSectionKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = SECTIONS.findIndex((item) => item.id === section);
    let next: number;
    if (event.key === "ArrowLeft") next = (index - 1 + SECTIONS.length) % SECTIONS.length;
    else if (event.key === "ArrowRight") next = (index + 1) % SECTIONS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SECTIONS.length - 1;
    else return;

    event.preventDefault();
    const target = SECTIONS[next];
    setSection(target.id);
    document.getElementById(`admin-tab-${target.id}`)?.focus();
  };

  return (
    <div className="gv-rise space-y-6">
      <header className="min-w-0">
        <Eyebrow>Console · Administration</Eyebrow>
        <h1 className="gv-page-title mt-1.5">Administration</h1>
        <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-ink-2">
          Tenants, people, credentials, prompt versions, rate cards, connector readiness and the
          state of the system itself.
        </p>
      </header>

      <div>
        <p id="admin-section-label" className="gv-eyebrow">
          Section
        </p>
        <div
          role="tablist"
          aria-labelledby="admin-section-label"
          aria-orientation="horizontal"
          onKeyDown={onSectionKey}
          className="mt-1.5 flex gap-0.5 overflow-x-auto border-b border-line-2"
        >
          {SECTIONS.map((item) => {
            const on = item.id === section;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`admin-tab-${item.id}`}
                aria-selected={on}
                aria-controls="admin-panel"
                tabIndex={on ? 0 : -1}
                onClick={() => setSection(item.id)}
                className={`box-border inline-flex h-10 shrink-0 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand ${
                  on ? "border-navy text-ink" : "border-transparent text-ink-3 hover:text-ink"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        role="tabpanel"
        id="admin-panel"
        aria-labelledby={`admin-tab-${section}`}
        tabIndex={0}
        className="space-y-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        {section === "tenants" ? <TenantsSection token={token} /> : null}
        {section === "users" ? <UsersSection /> : null}
        {section === "credentials" ? <CredentialsSection token={token} /> : null}
        {section === "webhooks" ? <WebhooksSection /> : null}
        {section === "prompts" ? <PromptsSection /> : null}
        {section === "ratecards" ? <RateCardsSection /> : null}
        {section === "connectors" ? <ConnectorsSection token={token} /> : null}
        {section === "status" ? <StatusSection /> : null}
      </div>
    </div>
  );
}

/* ---------- Tenants ---------- */

/**
 * One row of `GET /v1/tenants`, as the tenant record in `gravai_core.models`
 * would be projected onto the wire.
 *
 * The shape is declared here rather than in `lib/api.ts` because this change
 * does not own that file, and it is written as a contract rather than as a
 * guess at a first response: every field is optional, and a field the API does
 * not send renders as "not reported" instead of as a zero. A zero in the spend
 * column would be a claim that a tenant has spent nothing.
 *
 * The endpoint does not exist in the API build this console is pointed at, and
 * the request is made anyway. That is deliberate and it is the same pattern
 * `lib/api.ts` already uses for `/v1/runs` and `/v1/tasks`: asking gives a
 * reader the real answer — a 404 reported as "not shipped in this build", a
 * refused connection reported as unreachable, an empty list reported as empty —
 * where a hard-coded "not available" sentence would go on being printed for a
 * year after the endpoint landed.
 */
interface TenantRow {
  id: string;
  slug?: string | null;
  name?: string | null;
  languages?: string[] | null;
  calling_window_start?: string | null;
  calling_window_end?: string | null;
  monthly_budget_inr?: number | string | null;
  spend_inr?: number | string | null;
  /** Automation flags that are on for this tenant, e.g. `auto_disburse`. */
  automation?: string[] | null;
  rate_card_version?: string | null;
}

/** No tenant is listed until one is read from the API. */
const NO_TENANTS: TenantRow[] = [];

function TenantsSection({ token }: { token: string | null }) {
  const tenants = useResource<TenantRow[]>(
    `tenants:${token ?? "none"}`,
    (signal) => request<TenantRow[]>("/v1/tenants", { token, signal }),
    NO_TENANTS,
  );

  const { failure } = tenants;
  const loading = tenants.mode === "loading";

  return (
    <div className="space-y-4">
      <ApiFailureBanner
        failure={failure}
        onRetry={tenants.reload}
        what="the tenant directory"
      />

      <Card
        title="Tenants"
        description="Languages, calling window, budget, automation flags and the rate card version each tenant is billed against."
        flush
      >
        <ScrollX label="Tenants">
          <table className="gv-table">
            <caption className="sr-only">
              Tenants on this deployment, with the languages they operate in, their permitted
              collections calling window, their monthly budget and spend against it, the
              automation flags that are on, and the rate card version they are billed against.
            </caption>
            <thead>
              <tr>
                <th scope="col">Tenant</th>
                <th scope="col">Languages</th>
                <th scope="col">Calling window</th>
                <th scope="col" className="gv-num">
                  Budget
                </th>
                <th scope="col" className="gv-num">
                  Spend
                </th>
                <th scope="col">Automation</th>
                <th scope="col">Rate card</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7}>
                    <span role="status" className="sr-only">
                      Loading tenants…
                    </span>
                    <span aria-hidden="true" className="grid gap-2 py-2">
                      <Skeleton h={14} w="min(40%, 240px)" />
                      <Skeleton h={14} w="min(65%, 380px)" />
                      <Skeleton h={14} w="min(52%, 300px)" />
                    </span>
                  </td>
                </tr>
              ) : tenants.data.length > 0 ? (
                tenants.data.map((tenant) => <TenantRowView key={tenant.id} tenant={tenant} />)
              ) : (
                <tr>
                  <td colSpan={7} className="px-6 py-10 text-center leading-relaxed text-ink-3">
                    {tenantsEmptyCopy(failure?.kind)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollX>
      </Card>

      <InlineNote>
        Every column above is filled from the API or left as &ldquo;not
        reported&rdquo;. Nothing on this page derives a budget, a spend or a
        remaining balance from anything else on the screen: a rupee figure that
        the platform did not itself record is a figure somebody will reconcile an
        invoice against.
      </InlineNote>
    </div>
  );
}

/**
 * The sentence printed where rows would have been.
 *
 * `ApiFailureBanner` above already carries the status and the correlation id,
 * so this says what the absence of rows *means* rather than repeating the
 * mechanics. "We asked and there is nothing" and "we never found out" are
 * different facts, and only the first is safe to act on.
 */
function tenantsEmptyCopy(kind: string | undefined): string {
  if (kind === "no-token") {
    return "No API token is set, so no tenant was requested. Add one in Settings and this table fills from the API — or says why it could not.";
  }
  if (kind === "not-implemented") {
    return "This API build exposes no tenant directory, so there is nothing to list and nothing is put in its place. The tenant your own token belongs to is readable from its claims, in Settings.";
  }
  if (kind === "unauthenticated" || kind === "forbidden") {
    return "The API did not accept this token for the tenant directory, so the list is unknown rather than empty.";
  }
  if (kind) {
    return "The request did not come back, so the tenant list is unknown rather than empty. The banner above carries the status this console was given.";
  }
  return "The API answered with no tenants, which means none is configured on this deployment yet.";
}

function TenantRowView({ tenant }: { tenant: TenantRow }) {
  const window =
    tenant.calling_window_start && tenant.calling_window_end
      ? `${tenant.calling_window_start}–${tenant.calling_window_end} IST`
      : null;

  return (
    <tr>
      <th scope="row">
        <span className="block font-medium text-ink">
          {tenant.name ?? tenant.slug ?? tenant.id}
        </span>
        {tenant.slug ? <span className="gv-id block text-ink-3">{tenant.slug}</span> : null}
      </th>
      <td>
        {tenant.languages?.length ? (
          <span className="flex flex-wrap gap-1">
            {tenant.languages.map((code) => (
              <span key={code} className="gv-chip gv-chip-outline">
                {languageName(code)}
              </span>
            ))}
          </span>
        ) : (
          <NotReported />
        )}
      </td>
      <td className="font-mono text-[12px]">{window ?? <NotReported />}</td>
      <td className="gv-num">
        {isMoney(tenant.monthly_budget_inr) ? (
          formatInr(tenant.monthly_budget_inr)
        ) : (
          <NotReported />
        )}
      </td>
      <td className="gv-num">
        {isMoney(tenant.spend_inr) ? formatInr(tenant.spend_inr) : <NotReported />}
      </td>
      <td>
        {tenant.automation?.length ? (
          <span className="flex flex-wrap gap-1">
            {tenant.automation.map((flag) => (
              /* Navy, because an automation flag is a switch code reads and
                 acts on with a fixed answer — not a judgement a model made. */
              <Chip key={flag} tone="navy" mono>
                {flag}
              </Chip>
            ))}
          </span>
        ) : (
          <NotReported />
        )}
      </td>
      <td className="font-mono text-[12px]">{tenant.rate_card_version ?? <NotReported />}</td>
    </tr>
  );
}

/**
 * A rupee figure is rendered only when the API sent a number.
 *
 * `formatInr` turns `null` into an em dash, which would be indistinguishable
 * from a genuinely reported zero at a glance; a cell that reports nothing must
 * say it reports nothing.
 */
function isMoney(value: number | string | null | undefined): boolean {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(typeof value === "string" ? Number(value) : value);
}

function languageName(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.name ?? code;
}

/**
 * An em dash is silent to a screen reader, so the reason is spelled out for it.
 * Sighted readers get the dash; everyone gets the fact.
 */
function NotReported() {
  return (
    <>
      <span aria-hidden="true" className="text-ink-4">
        —
      </span>
      <span className="sr-only">not reported</span>
    </>
  );
}

/* ---------- Users & roles ---------- */

function UsersSection() {
  return (
    <NotWired
      title="Users & roles"
      summary="There is no user directory in this API build, so this console cannot list the people on a tenant, assign a role to one, or say when anybody last signed in."
    >
      <p>
        This section used to be a table of named colleagues with roles and
        last-seen timestamps, every row of it written by hand. A staff list with
        role assignments reads as a statement about who can approve what on this
        tenant, which is a security claim; nobody could stand behind that one, so
        it is gone rather than left as a shell.
      </p>
      <p>
        The one identity this console does know is the one inside your own token
        — its subject, tenant, roles and scopes. The API validates it; this
        console only reads it for display. It is on{" "}
        <Link href="/console/settings" className="gv-link">
          Settings
        </Link>
        , under Token claims.
      </p>
      <p>
        One roles table did leave the old Settings page and is deliberately not
        reinstated here: the list of which queues each role may sign off. The
        console still holds that table — it is what disables an action in the
        review queue — but its queue names are declared in the console build and
        appear in no endpoint of this API, so printing it on the administration
        page would present as deployment configuration something the platform has
        never confirmed. Where a control is disabled, the control itself names
        the queue required and the roles this session holds, which is the part a
        reader can act on.
      </p>
    </NotWired>
  );
}

/* ---------- API keys & MCP ---------- */

const NO_SURFACE: McpSurfaceOut | null = null;

function CredentialsSection({ token }: { token: string | null }) {
  const surface = useResource<McpSurfaceOut | null>(
    `mcp-surface:${token ?? "none"}`,
    (signal) => api.mcpSurface(token, signal),
    NO_SURFACE,
  );

  const data = surface.data;

  return (
    <div className="space-y-4">
      <ApiFailureBanner
        failure={surface.failure}
        onRetry={surface.reload}
        what="what your credential is permitted to call"
      />

      <Card
        title="What this credential is permitted to call"
        description="Read from the same endpoint a model host reads when it connects, so the answer here and the answer a host is given cannot diverge."
      >
        {surface.mode === "loading" ? (
          <div className="grid gap-2">
            <span role="status" className="sr-only">
              Loading the tool surface…
            </span>
            <Skeleton h={30} w="min(35%, 200px)" />
            <Skeleton h={14} w="min(60%, 340px)" />
          </div>
        ) : data ? (
          <div className="space-y-4">
            <div className="grid gap-5 sm:grid-cols-2">
              <Figure
                label="Tools permitted"
                value={String(data.permitted_tools)}
                note={`Of ${data.total_tools} in the catalogue. The difference is what your scopes do not reach.`}
              />
              <Figure
                label="Scopes held"
                value={String(data.held_scopes.length)}
                note="Carried by the token itself. The API decides what they unlock; this console only reports the decision."
              />
            </div>
            {data.held_scopes.length > 0 ? (
              <div>
                <Eyebrow>Scopes</Eyebrow>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {data.held_scopes.map((scope) => (
                    <span key={scope} className="gv-chip gv-chip-outline font-mono text-[11px]">
                      {scope}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            <p className="text-[12.5px] leading-relaxed text-ink-3">
              The catalogue itself — every tool, its schema and whether it is
              read-only, destructive or long-running — is on{" "}
              <Link href="/console/mcp" className="gv-link">
                MCP
              </Link>
              , along with how to connect a host.
            </p>
          </div>
        ) : (
          <p className="py-6 text-center text-[13px] leading-relaxed text-ink-3">
            {surface.failure?.kind === "no-token"
              ? "No API token is set, so nothing was asked. The catalogue is filtered by the scopes a token holds, so there is no general answer to give in its absence."
              : surface.failure?.kind === "not-implemented"
                ? "This API build does not expose the MCP tool surface, so what a host would be offered is not known here."
                : "The tool surface could not be read, so what this credential may call is unknown rather than empty."}
          </p>
        )}
      </Card>

      <NotWired
        title="Key management"
        summary="Keys cannot be listed, issued or revoked from this console: the API exposes no endpoint for any of it."
      >
        <p>
          A table of keys with creation dates and revocation states is a
          statement about a tenant&rsquo;s credential hygiene, and an invented one
          is worse than none — a key shown as revoked that was never revoked is a
          door somebody stops checking.
        </p>
        <p>
          The only credential this console holds is the bearer token in your own
          browser, which is pasted into{" "}
          <Link href="/console/settings" className="gv-link">
            Settings
          </Link>{" "}
          and attached directly to API calls. No server route proxies it, so it
          is never written to a server log. Tokens are minted outside the console
          — with <span className="font-mono text-[12px]">scripts/dev_token.py</span>{" "}
          in development, or by your identity provider once{" "}
          <span className="font-mono text-[12px]">OIDC_JWKS_URL</span> is set.
        </p>
      </NotWired>
    </div>
  );
}

/* ---------- Webhooks ---------- */

function WebhooksSection() {
  return (
    <NotWired
      title="Webhooks"
      summary="This API build has no webhook registry and no delivery history, so there is nothing to list and no health to report."
    >
      <p>
        An endpoint shown as &ldquo;healthy&rdquo; is a claim that deliveries are
        arriving. Drawn from nothing, it is the kind of claim that stops somebody
        investigating a queue that has in fact been failing since Tuesday. The
        table is absent rather than empty for exactly that reason.
      </p>
      <p>
        What the platform does record today is its own audit chain: every action
        taken through the API, hash-linked per tenant, in the{" "}
        <Link href="/console/audit" className="gv-link">
          audit explorer
        </Link>
        . That is a record of what happened, not of what was delivered onward,
        and the two should not be mistaken for each other.
      </p>
    </NotWired>
  );
}

/* ---------- Prompt versions ---------- */

function PromptsSection() {
  return (
    <NotWired
      title="Prompt versions"
      summary="There is no prompt registry endpoint in this API build, so this console cannot list prompt versions, diff two of them, or say which is live."
    >
      <p>
        The versions themselves are not lost, and that is the point worth making
        here: every run step carries the{" "}
        <span className="font-mono text-[12px]">prompt_version</span> that
        produced it, so the question &ldquo;which prompt answered this
        application?&rdquo; is answerable per decision even though the registry
        is not browsable. It is on the step, in{" "}
        <Link href="/console/runs" className="gv-link">
          Runs
        </Link>
        , and in the audit entry recorded alongside it.
      </p>
      <p>
        A registry listing versions with a deployment state would be the more
        convenient view, and it belongs here the day an endpoint reports one.
      </p>
    </NotWired>
  );
}

/* ---------- Rate cards ---------- */

function RateCardsSection() {
  const priced = RATE_CARD.filter((row) => row.inrPerUnit !== null).length;
  const unset = RATE_CARD.length - priced;

  return (
    <div className="space-y-4">
      <div className="grid gap-5 sm:grid-cols-2">
        <Figure
          label="Rows priced"
          value={String(priced)}
          note={`Of ${RATE_CARD.length}. Only a priced row contributes to a cost figure anywhere in this platform.`}
        />
        <Figure
          label="Rows unset"
          value={String(unset)}
          tone={unset > 0 ? "amber" : undefined}
          note="Left blank rather than guessed, which makes every spend figure on Usage a floor rather than a total."
        />
      </div>

      <Card
        title="Rate card"
        description="Versioned and effective-dated. A cost figure without a rate card version is not reported anywhere in this platform."
        flush
      >
        <ScrollX label="Rate card">
          <table className="gv-table">
            <caption className="sr-only">
              Billable products, the unit each is priced by, the rupee price per unit where one is
              set, and the source of that price.
            </caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Unit</th>
                <th scope="col" className="gv-num">
                  Price
                </th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {RATE_CARD.map((row) => (
                <tr key={row.product}>
                  <th scope="row">
                    <span className="block font-medium text-ink">
                      {productLabel(row.product)}
                    </span>
                    <span className="gv-id block text-ink-3">{row.product}</span>
                  </th>
                  <td>{row.unit}</td>
                  <td className="gv-num">
                    {row.inrPerUnit === null ? (
                      /* Amber is the outcome colour for risk, and an unpriced
                         row is a real one: it silently understates every cost
                         figure derived from it. */
                      <Chip tone="amber">Not set</Chip>
                    ) : (
                      /* Navy: a contracted unit price is arithmetic code applies
                         with a fixed answer, never a judgement a model made. */
                      <Chip tone="navy" mono>
                        ₹{row.inrPerUnit.toFixed(2)}/{row.unit}
                      </Chip>
                    )}
                  </td>
                  <td className="text-[12.5px] leading-relaxed text-ink-3">{row.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollX>
      </Card>

      <InlineNote tone="amber">
        Unset rows are left blank on purpose. A guessed unit price would propagate silently into
        every cost figure on the usage dashboard and into every unit economic derived from it.
      </InlineNote>

      <InlineNote>
        This card is declared in the console build, from the tenant contract cited against each
        row — it is not read from the API, and no endpoint serves it yet. It is the one table on
        this page that does not come off the wire, which is why every row names where its price
        came from. Per-tenant billing, and which version a given tenant is billed against, belongs
        in the Tenants section above and waits on the same endpoint.
      </InlineNote>
    </div>
  );
}

/* ---------- Connectors ---------- */

/** Connectors before the registry answers: none listed, none invented. */
const NO_CONNECTORS: ConnectorOut[] = [];

function ConnectorsSection({ token }: { token: string | null }) {
  const connectors = useResource(
    `connectors:${token ?? "none"}`,
    (signal) => api.listConnectors(token, signal),
    NO_CONNECTORS,
  );

  return (
    <div className="space-y-4">
      <ApiFailureBanner
        failure={connectors.failure}
        onRetry={connectors.reload}
        what="the connector registry"
      />
      <Card
        title="Connector status"
        description="Read from the platform's own connector registry, so a claimed integration and a real one cannot diverge."
        flush
      >
        {connectors.mode === "loading" ? (
          <>
            {/* The skeleton rows are decoration and are hidden from assistive
                technology, so the wait is announced in words instead. Without
                this the section is silent while it loads and then silently
                fills, which reads as an empty registry. */}
            <span role="status" className="sr-only">
              Loading the connector registry…
            </span>
            <ul aria-hidden="true">
              {Array.from({ length: 4 }, (_, index) => (
                <li key={index} className="gv-row grid gap-2 px-4 py-3">
                  <Skeleton h={14} w="min(45%, 260px)" />
                  <Skeleton h={11} w="min(70%, 400px)" />
                </li>
              ))}
            </ul>
          </>
        ) : connectors.data.length > 0 ? (
          <ul>
            {connectors.data.map((connector) => (
              <Row
                key={connector.id}
                title={connector.name}
                identifier={connector.id}
                chip={<Chip tone={statusTone(connector.status)}>{connector.status}</Chip>}
                detail={connector.summary}
                pairs={[
                  { label: "Before it goes live", value: connector.onboarding_requirement },
                ]}
              />
            ))}
          </ul>
        ) : (
          <p className="px-6 py-10 text-center text-[13px] leading-relaxed text-ink-3">
            {connectors.failure?.kind === "no-token"
              ? "No API token is set, so the registry was not asked. Nothing is listed in its place."
              : connectors.failure
                ? "The registry could not be read, so no connector is listed. A claimed integration that nothing confirmed is exactly the divergence this section exists to prevent, so nothing is claimed."
                : "The registry answered with no connectors, which means none is configured for this tenant yet."}
          </p>
        )}
      </Card>
    </div>
  );
}

/* ---------- System status ---------- */

function StatusSection() {
  const connection = useConnection();
  const readiness = connection.readiness;

  return (
    <div className="space-y-4">
      <Card
        title="Live readiness"
        description="Read from GET /readyz, which is public and therefore answers even when a token is wrong."
        flush
        action={
          <Button size="sm" onClick={connection.recheck}>
            Re-check
          </Button>
        }
      >
        {readiness ? (
          <ul>
            <Row
              title="Overall"
              chip={<Chip tone={statusTone(readiness.status)}>{readiness.status}</Chip>}
            />
            <Row
              title="Database"
              chip={
                <Chip tone={readiness.checks.database.ok ? "green" : "red"}>
                  {readiness.checks.database.ok ? "reachable" : "unreachable"}
                </Chip>
              }
              pairs={[
                { label: "Dialect", value: readiness.checks.database.dialect },
                {
                  label: "Row-level security",
                  value: readiness.checks.database.row_level_security ? "on" : "off",
                },
              ]}
            />
            <Row
              title="Environment"
              pairs={[
                { label: "Name", value: readiness.mode.environment },
                { label: "Auth", value: readiness.mode.auth },
              ]}
            />
            <Row
              title="AI mode"
              chip={
                <Chip tone={readiness.mode.sarvam_sandbox ? "amber" : "green"}>
                  {readiness.mode.sarvam_sandbox ? "sandbox" : "live"}
                </Chip>
              }
              detail={
                readiness.mode.sarvam_sandbox
                  ? "Sandbox output is illustrative and must never underwrite a real decision."
                  : "The document AI layer is answering with real output."
              }
            />
          </ul>
        ) : connection.status === "checking" ? (
          <>
            {/* As above: the skeleton says "wait" only to somebody who can see
                it, so the wait is also said in words. */}
            <span role="status" className="sr-only">
              Checking readiness…
            </span>
            <ul aria-hidden="true">
              {Array.from({ length: 4 }, (_, index) => (
                <li key={index} className="gv-row grid gap-2 px-4 py-3">
                  <Skeleton h={14} w="min(35%, 200px)" />
                  <Skeleton h={11} w="min(55%, 320px)" />
                </li>
              ))}
            </ul>
          </>
        ) : connection.status === "unreachable" ? (
          <p className="px-6 py-10 text-center text-[13px] leading-relaxed text-ink-3">
            The API is not reachable from this browser, so readiness cannot be read. Every other
            screen in this console is empty for the same reason — none of them substitutes
            anything for what the API did not send.
          </p>
        ) : (
          /* `/healthz` answered and `/readyz` did not. Blaming an unreachable
             API for that points a reader at a network that is working and away
             from the check that actually failed. */
          <p className="px-6 py-10 text-center text-[13px] leading-relaxed text-ink-3">
            The API answered on <span className="font-mono text-[12px]">/healthz</span> but{" "}
            <span className="font-mono text-[12px]">/readyz</span> did not return a readiness
            report, so nothing below it is known. That is a narrower fault than an unreachable
            API, and worth reporting as one. Re-check above to ask again.
          </p>
        )}
      </Card>

      <InlineNote>
        A per-service breakdown — queue, worker pool, document layer, webhook dispatcher — is not
        shown, because the API has no endpoint that reports one. It used to be shown anyway, from
        a written-out table; a component reported as &ldquo;degraded&rdquo; or
        &ldquo;operational&rdquo; by nothing at all is worse than an absent panel, because
        somebody acts on it. Readiness above is the part that is genuinely measured.
      </InlineNote>
    </div>
  );
}

/* ---------- Local vocabulary ---------- */

/** A panel with a title, a reason for existing, and an optional control. */
function Card({
  title,
  description,
  action,
  flush,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="gv-card min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line-2 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {description ? (
            <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-3">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}

/**
 * What a section says when there is no endpoint behind it at all.
 *
 * Deliberately not a table, not a skeleton and not a status chip. A greyed-out
 * table says "you are missing a permission"; a skeleton says "wait"; a chip in
 * an outcome colour says something was measured. None of those is true here,
 * and the difference between "not built" and "not loaded" is the whole point.
 * The summary is bordered on the leading edge rather than filled with colour,
 * because absence is not an outcome and green, amber and red are reserved for
 * ones.
 */
function NotWired({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <section className="gv-card min-w-0 overflow-hidden">
      <div className="border-b border-line-2 px-4 py-3">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        <p className="mt-1 max-w-2xl border-l-2 border-line-strong pl-3 text-[12.5px] leading-relaxed text-ink-2">
          {summary}
        </p>
      </div>
      <div className="space-y-2.5 p-4 text-[12.5px] leading-relaxed text-ink-3 [&_p]:max-w-2xl">
        {children}
      </div>
    </section>
  );
}

/** The one row shape this page uses, whatever the section is listing. */
function Row({
  title,
  identifier,
  chip,
  pairs,
  detail,
}: {
  title: string;
  identifier?: string;
  chip?: ReactNode;
  pairs?: { label: string; value: string }[];
  detail?: string;
}) {
  return (
    <li className="gv-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-[13.5px] font-medium break-all text-ink">{title}</span>
        {identifier ? <span className="gv-id break-all text-ink-3">{identifier}</span> : null}
      </div>
      {chip ? <span className="shrink-0">{chip}</span> : <span />}
      {pairs?.length ? (
        <dl className="col-span-2 flex flex-wrap gap-x-4 gap-y-0.5">
          {pairs.map((pair) => (
            <div key={pair.label} className="flex items-baseline gap-1.5">
              <dt className="text-[11px] text-ink-4">{pair.label}</dt>
              <dd className="font-mono text-[11.5px] text-ink-2">{pair.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {detail ? (
        <p className="col-span-2 text-[12.5px] leading-relaxed text-ink-3">{detail}</p>
      ) : null}
    </li>
  );
}

/**
 * Outcome colours only: green proceeded, amber carries risk, red stopped.
 * Anything this does not recognise stays neutral rather than being guessed into
 * a colour, because a wrong colour here reads as a measurement.
 *
 * The table is keyed on the whole status rather than matched as a suffix, which
 * is what this replaced. A suffix test cannot tell a word from its own negation:
 * "unhealthy" ends in "healthy" and "not_ready" ends in "ready", so both were
 * coloured green — a component that had stopped, reported in the colour that
 * means it proceeded. The vocabulary the API speaks today is small and is
 * enumerated here (`/readyz` answers ready or degraded; the connector registry
 * answers live, sandbox_only or external_dependency), with the near neighbours a
 * later build might send alongside it. Anything outside the table is the
 * unrecognised case the paragraph above promises rather than a guess.
 */
const STATUS_TONES: Record<string, Tone> = {
  ok: "green",
  ready: "green",
  live: "green",
  active: "green",
  healthy: "green",
  operational: "green",
  connected: "green",
  degraded: "amber",
  sandbox: "amber",
  sandbox_only: "amber",
  external_dependency: "amber",
  pending: "amber",
  retrying: "amber",
  down: "red",
  error: "red",
  failed: "red",
  unhealthy: "red",
  unreachable: "red",
  not_ready: "red",
  revoked: "red",
};

function statusTone(status: string): Tone {
  return STATUS_TONES[status.trim().toLowerCase()] ?? "slate";
}
