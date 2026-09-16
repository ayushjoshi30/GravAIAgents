import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  GovernorDiagram,
  McpHandshake,
  RunTimelineDiagram,
} from "@/components/diagrams/PlatformDiagrams";
import { ThreePlanes } from "@/components/diagrams/ThreePlanes";
import { Icon } from "@/components/icons/AgentIcon";
import { Band, PageHeader, Rule, StepList } from "@/components/site/Page";
import { Badge, Chip } from "@/components/ui/Badge";
import { Arrow, ButtonLink, TextLink } from "@/components/ui/Button";
import { Meter, StatTile } from "@/components/ui/Stat";
import { Card, Cells, ScrollX, SectionHeading } from "@/components/ui/Surface";
import {
  AI_CAPABILITIES,
  DOC_AI_RPM,
  LANGUAGES,
  OPEN_QUESTIONS,
  VOLUME,
} from "@/lib/platform";

export const metadata: Metadata = {
  title: "Platform",
  description:
    "How GravAI is built: three planes, Temporal for durable agent runs, a 10 req/min rate governor, MCP and REST at the edge, and PostgreSQL row-level security per tenant.",
};

const TEMPORAL_REASONS = [
  {
    title: "Document Intelligence is asynchronous",
    body: (
      <>
        One document is a submit, a series of status polls and a results fetch, spread over
        thirty seconds or more. Multiply by twenty-five documents an application and the work
        is measured in minutes, not milliseconds. A request-scoped async task that dies with
        its process is the wrong container for that.
      </>
    ),
  },
  {
    title: "The rate ceiling makes waiting normal",
    body: (
      <>
        At {DOC_AI_RPM} requests per minute, a month-end batch spends most of its life queued.
        Temporal activities heartbeat through those waits, so a long queue is a healthy run
        rather than a stalled one, and a worker restart resumes instead of re-submitting.
      </>
    ),
  },
  {
    title: "Human approval is part of the run",
    body: (
      <>
        Every credit decision waits for an underwriter. That wait is a workflow signal with SLA
        timers at 24 and 72 hours — not a row in a table that something else has to poll. The
        run is one object from document upload to approved decision.
      </>
    ),
  },
  {
    title: "Retries have to be principled",
    body: (
      <>
        AI calls retry with backoff to a ceiling, and stop immediately on an auth error or
        a schema violation, because retrying either one is just spending quota to fail again.
        Those policies live on the activity, in one place, not scattered through call sites.
      </>
    ),
  },
  {
    title: "An audit needs the whole history",
    body: (
      <>
        Workflow history plus the projected <code className="gv-code">agent_run</code> and{" "}
        <code className="gv-code">agent_step</code> rows give a regulator the complete
        sequence: which prompt version, which model, which inputs, which validators, what it
        cost, who approved it and when.
      </>
    ),
  },
];

/** The four properties of the MCP edge, each one a mitigation rather than a feature. */
const MCP_POINTS: { icon: "grid" | "bolt" | "shield" | "chain"; title: string; body: ReactNode }[] =
  [
    {
      icon: "grid",
      title: "Systems as tools",
      body: (
        <>
          Read and write annotations on every one: <code className="gv-code">graviton.get_application</code>,{" "}
          <code className="gv-code">bre.evaluate</code>, <code className="gv-code">docai.extract</code>,{" "}
          <code className="gv-code">ledger.query</code> (templated, never raw SQL).
        </>
      ),
    },
    {
      icon: "bolt",
      title: "Agents as tools",
      body: (
        <>
          Each returns <code className="gv-code">{"{ run_id, status, result? }"}</code>. Long runs
          return the run id and stream progress notifications; the result is also readable as a
          resource.
        </>
      ),
    },
    {
      icon: "shield",
      title: "No token passthrough",
      body: (
        <>
          Tokens are audience-bound to the GravAI MCP server and never forwarded to a downstream
          system. That is the confused-deputy mitigation, and it is not optional.
        </>
      ),
    },
    {
      icon: "chain",
      title: "Every call is audited",
      body: (
        <>
          Tool name, argument hash, tenant, subject, result hash, latency and decision — one row
          per call, in the same chain as everything else.
        </>
      ),
    },
  ];

const TENANCY_LAYERS = [
  {
    label: "Layer one · the service",
    body: (
      <>
        Every query goes through <code className="gv-code">tenant_query()</code>, which binds the
        tenant from the request context. A missing filter is impossible rather than merely
        unlikely — there is no code path that constructs an unscoped query.
      </>
    ),
  },
  {
    label: "Layer two · the database",
    body: (
      <>
        On PostgreSQL, every table carries <code className="gv-code">tenant_id</code> and a{" "}
        <code className="gv-code">tenant_isolation</code> row-level security policy. The session
        sets the tenant; the database refuses to return anything else, even to a query that
        forgot.
      </>
    ),
  },
  {
    label: "Layer three · the tests",
    body: (
      <>
        A suite that attempts cross-tenant reads and must fail. Another tenant&apos;s id reports
        as <em>missing</em>, never as <em>forbidden</em> — a 403 confirms the record exists,
        which is itself a leak.
      </>
    ),
  },
];

/** The adapter boundary, drawn left to right. The provider is configuration. */
const ADAPTER_CHAIN = [
  { title: "Agent", sub: "codes against a capability" },
  { title: "Capability", sub: "documents · model · speech" },
  { title: "One adapter", sub: "governor · ledger · retries" },
  { title: "Provider", sub: "configuration, not code" },
];

const FIRST_CLASS = new Set(["en-IN", "hi-IN"]);

export default function PlatformPage() {
  const firstClass = LANGUAGES.filter((language) => FIRST_CLASS.has(language.code));
  const translated = LANGUAGES.filter((language) => !FIRST_CLASS.has(language.code));

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Durable runs, a hard rate ceiling, and tenancy you can prove"
        lede={
          <>
            GravAI is not a wrapper around a model. It is the operational layer that makes a
            model safe to run against a lending book: a durable execution engine, a governor
            that holds a third-party limit, a database that enforces tenant isolation
            underneath the application, and an append-only log that can be recomputed.
          </>
        }
        actions={
          <>
            <ButtonLink href="/docs/architecture" variant="primary" size="lg">
              Read the architecture
              <Arrow />
            </ButtonLink>
            <ButtonLink href="/console/usage" size="lg">
              Live governor state
            </ButtonLink>
          </>
        }
        aside={
          <div className="gv-panel overflow-hidden">
            <header className="gv-toolbar">
              <h2 className="text-[13.5px] font-semibold text-ink">Platform at a glance</h2>
              <span className="inline-flex items-center gap-2 text-[12px] font-medium text-ink-2">
                <span className="gv-pip" aria-hidden="true" />
                Operational
              </span>
            </header>
            <dl className="gv-divide">
              {[
                { label: "Orchestration", value: "Temporal" },
                { label: "Tenancy", value: "PostgreSQL RLS + service layer" },
                { label: "Governor", value: `Redis token bucket · ${DOC_AI_RPM}/min` },
                { label: "Edge", value: "MCP (Streamable HTTP) · REST /v1" },
              ].map((item) => (
                <div key={item.label} className="px-4 py-3">
                  <dt className="gv-eyebrow">{item.label}</dt>
                  <dd className="mt-1 text-[13.5px] leading-snug text-ink">{item.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        }
      />

      {/* ------------------------------------------------------------------
          The shape of it: the numbers the platform is sized for, then the
          three planes those numbers run through.
         ------------------------------------------------------------------ */}
      <Band tone="white" size="lg" id="planes">
        <Cells columns={4} raised>
          <StatTile
            variant="cell"
            size="lg"
            label="Tenants"
            value={VOLUME.tenants}
            note="One book, eighteen lenders, one governor between them."
          />
          <StatTile
            variant="cell"
            size="lg"
            label="Applications a month"
            value={VOLUME.applicationsPerMonth.toLocaleString("en-IN")}
            note={`About ${VOLUME.documentsPerApplication} documents each.`}
          />
          <StatTile
            variant="cell"
            size="lg"
            label="Documents a month"
            value={VOLUME.documentsPerMonth.toLocaleString("en-IN")}
            note="Every one of them read, classified and cited."
          />
          <StatTile
            variant="cell"
            size="lg"
            accent="brand"
            label="Document intelligence ceiling"
            value={DOC_AI_RPM}
            unit="req/min"
            note="The binding constraint. Uniform across every plan."
          />
        </Cells>
        <p className="gv-micro mt-3">
          Source: GRAVAI_SPEC.md §1.2 — the owner&apos;s current production pipeline.
        </p>

        <Rule className="my-12" />

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.9fr)] lg:gap-12">
          <SectionHeading
            eyebrow="The shape of it"
            title="Three planes"
            lede="The interface plane is deliberately thin. Anything that decides something lives below it."
            size="lg"
          />
          <ul className="gv-ticklist gv-support self-end">
            <li>Interface: MCP, REST and this application. Validate, authorise, audit, call.</li>
            <li>Platform: durable runs, the governor, tenancy, the ledger, the audit chain.</li>
            <li>Agent: prompts, tools, schemas, guardrails and the connectors they reach.</li>
          </ul>
        </div>
        <div className="mt-8">
          <ThreePlanes />
        </div>
      </Band>

      {/* ------------------------------------------------------------------
          Why Temporal. A run drawn first, then the five reasons as a spine.
         ------------------------------------------------------------------ */}
      <Band tone="soft" id="temporal">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] lg:gap-12">
          <SectionHeading
            eyebrow="Why Temporal"
            title="Because an agent run is a business process, not a request"
            lede="Five reasons, in the order they bite."
          />
          <RunTimelineDiagram />
        </div>

        <div className="gv-panel mt-10 p-6 sm:p-8">
          <StepList items={TEMPORAL_REASONS} />
        </div>
      </Band>

      {/* ------------------------------------------------------------------
          The governor: the one number everything else is shaped around.
         ------------------------------------------------------------------ */}
      <Band tone="white" id="throughput" className="scroll-mt-16">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:gap-12">
          <div className="min-w-0">
            <SectionHeading
              eyebrow="The rate governor"
              title="One ceiling, shared fairly"
              lede={
                <>
                  Document Intelligence is capped at {DOC_AI_RPM} requests per minute,
                  uniformly across Starter, Pro and Business. Extract and digitise draw on the
                  same bucket.
                </>
              }
            />
            <p className="gv-support gv-measure mt-5">
              You cannot buy your way out of it and adding workers does not move it — so the
              only lever left is queue discipline.
            </p>

            <div className="gv-card gv-card-metric mt-7 p-5 pl-6">
              <p className="gv-eyebrow mb-4">Concentration · the largest tenant</p>
              <Meter
                value={VOLUME.largestTenantApplicationShare}
                label="Share of applications"
                showValue
              />
              <Meter
                className="mt-4"
                value={VOLUME.largestTenantDocumentShare}
                label="Share of documents"
                showValue
                tone="blue"
              />
              <p className="gv-micro mt-4">
                One tenant of {VOLUME.tenants}. Under a naive FIFO queue, that tenant&apos;s
                month-end batch starves the other seventeen.
              </p>
            </div>

            <ul className="gv-ticklist gv-support mt-7">
              <li>
                GravAI serves waiters by weighted round-robin across tenants, so no single
                queue drains the bucket.
              </li>
              <li>
                The rotation only advances after an actual release — rotating on a failed poll
                would hand every newly refilled token to whoever happened to be at the head.
              </li>
              <li>
                The bucket refills continuously rather than in steps, which avoids the
                thundering herd a fixed window produces at the top of every minute.
              </li>
            </ul>

            <div className="mt-7 flex flex-wrap gap-3">
              <ButtonLink href="/console/usage" variant="primary">
                Live governor state
                <Arrow />
              </ButtonLink>
            </div>
          </div>
          <GovernorDiagram />
        </div>

        <div className="gv-panel mt-14 overflow-hidden">
          <header className="gv-toolbar">
            <div className="min-w-0">
              <p className="gv-eyebrow">Open questions</p>
              <h3 className="text-[15px] text-ink">Recorded rather than hidden</h3>
            </div>
            <Badge tone="amber" dot>
              {OPEN_QUESTIONS.length} open
            </Badge>
          </header>
          <div className="p-5 sm:p-6">
            <p className="gv-support gv-measure-wide">
              Four assumptions in this platform are unverified. Each is an environment variable,
              each is logged in <code className="gv-code">DECISIONS.md</code>, and each is
              visible in the console&apos;s throughput panel as a toggle so its consequence can
              be seen rather than argued about.
            </p>
            <ul className="gv-cells mt-6 sm:grid-cols-2">
              {OPEN_QUESTIONS.map((item) => (
                <li key={item.id} className="p-5">
                  <div className="flex items-center gap-2">
                    <Badge tone="amber">{item.id}</Badge>
                    <span className="gv-eyebrow">open</span>
                  </div>
                  <p className="mt-3 text-[14px] leading-snug font-semibold text-ink">
                    {item.question}
                  </p>
                  <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">{item.why}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Band>

      {/* ------------------------------------------------------------------
          The AI layer: capabilities, never a vendor.
         ------------------------------------------------------------------ */}
      <Band tone="tint" id="ai-layer">
        <SectionHeading
          eyebrow="The AI layer"
          title="Six capabilities behind one adapter"
          lede="Agents code against a capability, never against a vendor SDK. The adapter translates, so an API revision changes one module rather than fourteen agents — and one layer means one governor, one cost ledger, one retry policy and one circuit breaker."
          size="lg"
        />

        <div className="gv-figure mt-8 p-4 sm:p-5">
          <ScrollX label="The adapter boundary">
            <ol className="flex min-w-[600px] items-stretch">
              {ADAPTER_CHAIN.map((node, index) => (
                <li key={node.title} className="flex min-w-0 flex-1 items-center">
                  <div className="min-w-0 flex-1 rounded-lg border border-line bg-surface p-4 shadow-resting">
                    <p className="font-mono text-[12px] font-medium text-ink">{node.title}</p>
                    <p className="gv-micro mt-1.5">{node.sub}</p>
                  </div>
                  {index < ADAPTER_CHAIN.length - 1 ? (
                    <span
                      aria-hidden="true"
                      className="flex shrink-0 items-center px-2 text-brand-300"
                    >
                      <Arrow />
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </ScrollX>
          <p className="gv-micro mt-3">
            The provider is read from configuration. No model identifier is hardcoded anywhere
            in GravAI.
          </p>
        </div>

        <Cells columns={3} className="mt-8" as="ul">
          {AI_CAPABILITIES.map((capability, index) => (
            <li key={capability.id} className="p-5">
              <div className="flex items-center gap-3">
                <span
                  className="gv-icon-plate gv-icon-plate-sm font-mono text-[11.5px] font-semibold"
                  data-numeric=""
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="text-[15px] leading-tight text-ink">{capability.name}</h3>
              </div>
              <p className="gv-support mt-3">{capability.use}</p>
              <p className="mt-3 border-l-2 border-brand-200 pl-3 text-[12.5px] leading-relaxed text-ink-3">
                {capability.note}
              </p>
            </li>
          ))}
        </Cells>

        <Rule className="my-12" />

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] lg:gap-14">
          <SectionHeading
            eyebrow="Language coverage"
            title="Eleven Indian languages, first-class"
            lede="A borrower in Nashik and a borrower in Coimbatore do not want the same call in the same language. Collections conversations, onboarding guidance and adverse-action notes all happen in the language the borrower chose."
          />
          <div className="min-w-0">
            <div className="gv-card p-5">
              <p className="gv-eyebrow mb-3 flex items-center gap-2">
                <span className="gv-pip gv-pip-brand" aria-hidden="true" />
                First-class in every prompt set
              </p>
              <ul className="flex flex-wrap gap-2">
                {firstClass.map((language) => (
                  <li key={language.code}>
                    <Chip tone="brand">
                      <span className="font-mono text-[11px]">{language.code}</span>
                      {language.name}
                    </Chip>
                  </li>
                ))}
              </ul>

              <p className="gv-eyebrow mt-6 mb-3">Reached through the translation capability</p>
              <ul className="flex flex-wrap gap-2">
                {translated.map((language) => (
                  <li key={language.code}>
                    <Chip>
                      <span className="font-mono text-[11px] text-ink-3">{language.code}</span>
                      {language.name}
                    </Chip>
                  </li>
                ))}
              </ul>
            </div>

            <p className="gv-support mt-5">
              English and Hindi are first-class in every prompt set. The other nine are reached
              through the translation capability rather than by maintaining nine parallel prompt
              sets, which is what keeps the eval surface small enough to actually gate on.
            </p>
            <p className="gv-support mt-3">
              Data residency is architecture, not a region flag: the platform deploys into
              Indian regions and sends AI traffic to an Indian provider, because a bank
              statement is the borrower&apos;s complete financial life for six months and it
              leaves the building on every extraction call.
            </p>
          </div>
        </div>
      </Band>

      {/* ------------------------------------------------------------------
          MCP at the edge.
         ------------------------------------------------------------------ */}
      <Band tone="white" id="mcp">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:gap-12">
          <div className="min-w-0">
            <SectionHeading
              eyebrow="MCP"
              title="Agents as tools, for any model host"
              lede={
                <>
                  A remote MCP server over Streamable HTTP, acting as an OAuth 2.1 resource
                  server. The tool list a client sees is shaped by the scopes in its token, so
                  a collections client is never offered an underwriting tool.
                </>
              }
            />
            <ul className="gv-cells mt-7 sm:grid-cols-2">
              {MCP_POINTS.map((point) => (
                <li key={point.title} className="p-5">
                  <div className="flex items-center gap-2.5">
                    <span className="text-brand" aria-hidden="true">
                      <Icon name={point.icon} size={16} />
                    </span>
                    <h3 className="text-[14px] font-semibold text-ink">{point.title}</h3>
                  </div>
                  <p className="mt-2.5 text-[13px] leading-relaxed text-ink-2">{point.body}</p>
                </li>
              ))}
            </ul>
            <div className="mt-6">
              <TextLink href="/docs/mcp">
                Connection guide for Claude and other hosts
              </TextLink>
            </div>
          </div>
          <McpHandshake />
        </div>
      </Band>

      {/* ------------------------------------------------------------------
          Multi-tenancy.
         ------------------------------------------------------------------ */}
      <Band tone="soft" id="tenancy">
        <SectionHeading
          eyebrow="Multi-tenancy"
          title="Isolation in the service layer and in the database"
          lede="Defence in depth, because either one alone fails quietly."
          size="lg"
        />
        <Cells columns={3} raised className="mt-9" as="ul">
          {TENANCY_LAYERS.map((layer, index) => (
            <li key={layer.label} className="p-5 sm:p-6">
              <span
                className="gv-icon-plate gv-icon-plate-sm gv-icon-plate-solid font-mono text-[12px] font-semibold"
                data-numeric=""
              >
                {index + 1}
              </span>
              <p className="gv-eyebrow mt-4">{layer.label}</p>
              <p className="gv-support mt-2.5">{layer.body}</p>
            </li>
          ))}
        </Cells>

        <Card variant="secondary" className="mt-6 p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-3">
            <p className="gv-eyebrow">Local development runs on SQLite</p>
            <Badge tone="amber" dot>
              RLS unavailable
            </Badge>
          </div>
          <p className="gv-support gv-measure-wide mt-3">
            The platform starts with zero infrastructure by defaulting{" "}
            <code className="gv-code">DATABASE_URL</code> to SQLite. Row-level security is a
            PostgreSQL feature, so on SQLite isolation rests on the service layer alone and the
            RLS tests skip rather than pretend. That difference is recorded, tested and visible
            on the console&apos;s system-status panel — not glossed over.
          </p>
        </Card>
      </Band>

      {/* ------------------------------------------------------------------
          The audit chain.
         ------------------------------------------------------------------ */}
      <Band tone="white" id="audit">
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-14">
          <div className="min-w-0">
            <SectionHeading
              eyebrow="The audit log"
              title="Append-only, hash-chained, per tenant"
              lede={
                <>
                  Each event stores the hash of the previous event for the same tenant. A
                  database trigger forbids UPDATE and DELETE.
                </>
              }
            />
            <p className="gv-support gv-measure mt-5">
              Verification recomputes the chain from the genesis hash and names the first
              sequence number that does not follow, so an investigation starts at the right row
              instead of the whole table.
            </p>
            <p className="gv-support gv-measure mt-3">
              The chain is per tenant rather than global. A global chain would serialise every
              write across all tenants and leak activity volume between them.
            </p>

            <div className="gv-well mt-7 p-4">
              <ScrollX label="The audit chain">
                <ol className="flex min-w-[480px] items-stretch">
                  {["n − 1", "n", "n + 1"].map((label, index) => (
                    <li key={label} className="flex min-w-0 flex-1 items-center">
                      <div className="min-w-0 flex-1 rounded-lg border border-line bg-surface p-3">
                        <p className="font-mono text-[10.5px] tracking-wide text-ink-3 uppercase">
                          audit_event
                        </p>
                        <p className="mt-1 font-mono text-[12.5px] text-ink" data-numeric="">
                          seq {label}
                        </p>
                        <p className="gv-micro mt-1.5">prev_hash + payload</p>
                      </div>
                      {index < 2 ? (
                        <span
                          aria-hidden="true"
                          className="flex shrink-0 items-center px-2 text-brand-300"
                        >
                          <Arrow />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </ScrollX>
              <p className="gv-micro mt-3">
                One chain per tenant, from the genesis hash forward.
              </p>
            </div>

            <div className="mt-7">
              <ButtonLink href="/console/audit" variant="primary">
                Verify a chain in the console
                <Arrow />
              </ButtonLink>
            </div>
          </div>

          <Card variant="elevated" className="p-6 sm:p-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="gv-eyebrow">A bug worth keeping in the record</p>
              <Chip>DECISIONS.md D-010</Chip>
            </div>
            <p className="gv-support mt-4">
              Timestamps are canonicalised before hashing rather than passed through{" "}
              <code className="gv-code">isoformat()</code>. PostgreSQL{" "}
              <code className="gv-code">timestamptz</code> returns an aware datetime; SQLite
              returns a naive one.
            </p>
            <p className="gv-support mt-3">
              The digest computed on write therefore did not match the digest recomputed on
              read, and every chain failed verification after a reload.
            </p>
            <blockquote className="gv-quote mt-6">
              A failing test found it. The hash format is now frozen and versioned with the
              chain, because changing it would invalidate every chain that exists.
            </blockquote>
          </Card>
        </div>
      </Band>

      {/* ------------------------------------------------------------------
          The one inverse band on this page.
         ------------------------------------------------------------------ */}
      <Band tone="inverse" pattern="radial-center" size="lg">
        <div className="mx-auto max-w-2xl text-center">
          <p className="gv-eyebrow mb-4">Nothing here is a claim you have to take on trust</p>
          <h2 className="gv-heading text-white">
            Every number on this page has a panel behind it.
          </h2>
          <p className="gv-lede mt-4">
            The governor, the cost ledger and the audit chain are all readable in the console —
            the same service layer, the same tenancy rules, the same log.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <ButtonLink href="/console" variant="primary" size="lg">
              Open the console
              <Arrow />
            </ButtonLink>
            <ButtonLink href="/security" size="lg">
              Security and compliance
            </ButtonLink>
          </div>
        </div>
      </Band>
    </>
  );
}
