import Link from "next/link";
import { DocAiLifecycle } from "@/components/diagrams/PlatformDiagrams";
import { ThreePlanes } from "@/components/diagrams/ThreePlanes";
import { Icon } from "@/components/icons/AgentIcon";
import { AgentGrid } from "@/components/site/AgentCard";
import { HomeHeroPanel } from "@/components/site/HomeHeroPanel";
import { HomeMetricCompare } from "@/components/site/HomeMetricCompare";
import { Band, Container, FactList, Section } from "@/components/site/Page";
import { Badge } from "@/components/ui/Badge";
import { Arrow, ButtonLink } from "@/components/ui/Button";
import { SectionHeading } from "@/components/ui/Surface";
import { AGENTS, TIER_COUNTS } from "@/lib/agents";
import { formatCount, formatInr, formatTokens } from "@/lib/format";
import {
  COMPLIANCE_CONTROLS,
  DOC_AI_RPM,
  PROOF_POINTS,
  REFERENCE_RUN,
  VOLUME,
} from "@/lib/platform";

/**
 * The calls-per-document fact is no longer a tile in the proof strip: it has
 * its own data section below the hero, where the comparison is drawn to scale
 * rather than asserted in a sentence. Its label, its figures, its explanation
 * and its source line all still appear on the page — in that section.
 */
const CALLS_FACT_ID = "calls-per-document";
const CALLS_FACT = PROOF_POINTS.find((fact) => fact.id === CALLS_FACT_ID);
const SUPPORTING_PROOF = PROOF_POINTS.filter((fact) => fact.id !== CALLS_FACT_ID);

export default function HomePage() {
  return (
    <>
      {/* Hero — the argument on the left, one running agent on the right. */}
      <Band tone="white" pattern="radial" size="lg" className="border-b border-line">
        <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] lg:gap-14">
          <div className="min-w-0">
            <Badge tone="brand" size="md" dot>
              {AGENTS.length} agents · multi-tenant · audited
            </Badge>
            <h1 className="gv-display mt-5">
              The agent layer for Indian lending.{" "}
              <span className="block text-brand">Built on the platform you already run.</span>
            </h1>
            <p className="gv-lede gv-measure mt-6">
              Graviton already runs the journey: onboarding, DigiLocker KYC, credit, rules,
              underwriting, deviations, the Task Center, the loan account number. GravAI turns
              that journey into {AGENTS.length} auditable agents.
            </p>
            <ul className="gv-ticklist gv-support mt-5 max-w-xl">
              <li>
                They read the documents, build the appraisal, score the risk, work the
                portfolio and speak to the borrower.
              </li>
              <li>Eleven Indian languages, one registry behind REST, MCP and the console.</li>
              <li>Every step appended to a per-tenant hash-chained audit log.</li>
            </ul>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href="/console" variant="primary" size="lg">
                Open the console
                <Arrow />
              </ButtonLink>
              <ButtonLink href="/docs/quickstart" size="lg">
                Read the quickstart
              </ButtonLink>
            </div>
            <p className="mt-8 flex items-start gap-2.5 border-t border-line pt-5 text-[13px] leading-relaxed text-ink-3">
              <span className="mt-0.5 shrink-0 text-brand">
                <Icon name="shield" size={14} />
              </span>
              Agents are advisory by default. Credit decisions, deviations and adverse actions
              are escalated to a human by design, not by configuration.
            </p>
          </div>

          {/* The product visual: one recorded run, drawn as a control plane. */}
          <HomeHeroPanel className="lg:mt-1" />
        </div>
      </Band>

      {/* The number this platform is built around, drawn rather than asserted. */}
      <Band tone="deep" size="lg" id="call-model">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] lg:gap-14">
          <div className="min-w-0">
            <SectionHeading
              size="lg"
              eyebrow={CALLS_FACT ? CALLS_FACT.label : "API calls per document"}
              title={
                <>
                  Twelve calls to read a document.{" "}
                  <span className="text-brand">Not forty.</span>
                </>
              }
              lede={
                <>
                  Document reading is asynchronous, so one document is never one call. Under a
                  ceiling of {DOC_AI_RPM} requests per minute that extract and digitise share,
                  the difference between twelve calls and forty is not a cost line. It is the
                  difference between draining a backlog and never catching up.
                </>
              }
            />
            <Link
              href="/platform#throughput"
              className="gv-link gv-link-arrow mt-6 inline-flex items-center gap-1.5 text-[13.5px]"
            >
              How the governor holds the ceiling
              <Arrow />
            </Link>
          </div>

          <HomeMetricCompare source={CALLS_FACT?.source} />
        </div>
      </Band>

      {/* Proof strip */}
      <Container>
        <Section bordered={false} className="py-12">
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {SUPPORTING_PROOF.map((fact) => (
              <li key={fact.id} className="gv-card flex flex-col p-5">
                <p className="gv-label text-ink-3">{fact.label}</p>
                <p className="mt-2.5 flex items-baseline gap-1.5">
                  <span
                    className="text-[27px] leading-none font-semibold tracking-tight text-ink"
                    data-numeric=""
                  >
                    {fact.value}
                  </span>
                  {fact.unit ? (
                    <span className="text-[12.5px] font-medium text-ink-3">{fact.unit}</span>
                  ) : null}
                </p>
                <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">{fact.note}</p>
                <p className="mt-auto pt-3 font-mono text-[11px] text-ink-3">
                  Source: {fact.source}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      </Container>

      {/* Architecture */}
      <Container>
        <Section id="architecture">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.85fr)] lg:gap-14">
            <SectionHeading
              eyebrow="Architecture"
              title="Three planes, and a thin edge"
              lede={
                <>
                  MCP and REST validate, authorise, audit and call the service layer. No
                  business logic lives at the edge, which is why an agent behaves identically
                  whether Graviton called it, a model host called it over MCP, or an
                  underwriter pressed a button in the console.
                </>
              }
            />
            <ThreePlanes />
          </div>
        </Section>
      </Container>

      {/* Document economics */}
      <Container>
        <Section id="documents">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)] lg:gap-14">
            <DocAiLifecycle />
            <div>
              <SectionHeading
                eyebrow="Document intelligence"
                title="Polling is the traffic"
                lede={
                  <>
                    Document reading is asynchronous, so one document is never one call.
                    Counting documents instead of requests is exactly what hides the fact that
                    status polls dominate the traffic against a ten-per-minute ceiling shared
                    by both paths.
                  </>
                }
              />
              <div className="mt-6">
                <FactList
                  items={[
                    {
                      label: "Documents per application",
                      value: `~${VOLUME.documentsPerApplication}`,
                    },
                    {
                      label: "Applications per month",
                      value: formatCount(VOLUME.applicationsPerMonth),
                    },
                    {
                      label: "Documents per month",
                      value: formatCount(VOLUME.documentsPerMonth),
                    },
                    {
                      label: "Model calls per application",
                      value: `~${VOLUME.llmCallsPerApplication}`,
                    },
                  ]}
                />
              </div>
              <Link
                href="/console/usage"
                className="gv-link mt-5 inline-flex items-center gap-1.5 text-[13.5px]"
              >
                Model it yourself in the console
                <Arrow />
              </Link>
            </div>
          </div>
        </Section>
      </Container>

      {/* One instrumented run */}
      <Container>
        <Section id="reference-run">
          <div className="gv-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
              <p className="gv-eyebrow">One fully instrumented production run</p>
              <p className="font-mono text-[12px] text-ink-3">loan {REFERENCE_RUN.loan}</p>
            </div>
            <dl className="grid divide-y divide-[var(--gv-line)] sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-5">
              {[
                { label: "Documents", value: formatCount(REFERENCE_RUN.documents) },
                { label: "Model calls", value: formatCount(REFERENCE_RUN.modelCalls) },
                {
                  label: "Tokens in / out",
                  value: `${formatTokens(REFERENCE_RUN.inputTokens)} / ${formatTokens(REFERENCE_RUN.outputTokens)}`,
                },
                { label: "Audio", value: `${REFERENCE_RUN.audioSeconds} s` },
                { label: "Cost", value: formatInr(REFERENCE_RUN.costInr) },
              ].map((item) => (
                <div
                  key={item.label}
                  className="px-5 py-4 sm:border-r sm:border-line sm:last:border-r-0"
                >
                  <dt className="gv-label text-ink-3">{item.label}</dt>
                  <dd
                    className="mt-1.5 text-[19px] leading-none font-semibold text-ink"
                    data-numeric=""
                  >
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="border-t border-line bg-surface-2 px-5 py-3 text-[12.5px] text-ink-2">
              Measured, not modelled. Every agent step writes its tokens, latency and rupee
              cost to the ledger, which is what makes a per-application unit economic a fact
              rather than an estimate.
            </p>
          </div>
        </Section>
      </Container>

      {/* Agent catalog */}
      <Container>
        <Section id="agents">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <SectionHeading
              eyebrow="The catalog"
              title={`${AGENTS.length} agents, one source of truth`}
              lede={
                <>
                  The REST API, the MCP tool list, the console and this page all read the same
                  registry, so an agent cannot exist on one surface and be missing from
                  another. {TIER_COUNTS.P0} in the credit core, {TIER_COUNTS.P1} across risk,
                  collections and voice, {TIER_COUNTS.P2} for intelligence and operations.
                </>
              }
            />
            <ButtonLink href="/agents">
              Agent catalog
              <Arrow />
            </ButtonLink>
          </div>
          <div className="mt-8">
            <AgentGrid agents={AGENTS} />
          </div>
        </Section>
      </Container>

      {/* Compliance */}
      <Container>
        <Section id="compliance">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.65fr)] lg:gap-14">
            <SectionHeading
              eyebrow="Regulated by default"
              title="Written for the regime it operates in"
              lede={
                <>
                  Aadhaar masked at the point of extraction. Calling windows enforced in code,
                  not in a prompt. Consent scoped per purpose. No automated adverse action.
                  Every event appended to a per-tenant hash chain that can be recomputed on
                  demand.
                </>
              }
            />
            <ul className="grid gap-3 sm:grid-cols-2">
              {COMPLIANCE_CONTROLS.slice(0, 6).map((regime) => (
                <li key={regime.id} className="gv-card p-4">
                  <p className="text-[13.5px] font-semibold text-ink">{regime.regime}</p>
                  <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
                    {regime.controls[0]}
                  </p>
                  <p className="mt-2.5 text-[11.5px] font-medium text-brand">
                    +{regime.controls.length - 1} more controls
                  </p>
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-8">
            <ButtonLink href="/security">
              The full control map
              <Arrow />
            </ButtonLink>
          </div>
        </Section>
      </Container>

      {/* Call to action */}
      <Container>
        <Section>
          <div className="grid items-center gap-8 rounded-xl border border-brand-200 bg-brand-50 p-8 sm:p-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <div>
              <h2 className="text-[24px] sm:text-[28px]">
                Point it at your API and watch the real numbers arrive.
              </h2>
              <p className="mt-4 max-w-2xl text-[14.5px] leading-relaxed text-ink-2">
                The console runs against a local GravAI API on port 8000. Paste a bearer token
                into Settings and every screen switches from example data to live. Without a
                token it still renders everything — clearly labelled as example — so you can
                see what each screen does before you connect anything.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 lg:justify-end">
              <ButtonLink href="/console" variant="primary" size="lg">
                Open the console
                <Arrow />
              </ButtonLink>
              <ButtonLink href="/docs/mcp" size="lg">
                Connect over MCP
              </ButtonLink>
            </div>
          </div>
        </Section>
      </Container>
    </>
  );
}
