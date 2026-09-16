import Link from "next/link";
import { hueStyle } from "@/components/build/blocks";
import { DocAiLifecycle } from "@/components/diagrams/PlatformDiagrams";
import { ThreePlanes } from "@/components/diagrams/ThreePlanes";
import { AgentIcon, Icon, type IconName } from "@/components/icons/AgentIcon";
import { AgentGrid } from "@/components/site/AgentCard";
import { HomeHeroPanel } from "@/components/site/HomeHeroPanel";
import { HomeMetricCompare } from "@/components/site/HomeMetricCompare";
import { Band, FactList } from "@/components/site/Page";
import { Badge } from "@/components/ui/Badge";
import { Arrow, ButtonLink } from "@/components/ui/Button";
import { SectionHeading } from "@/components/ui/Surface";
import { AGENTS, TIER_COUNTS } from "@/lib/agents";
import { formatCount, formatInr, formatTokens } from "@/lib/format";
import { NODE_BY_TYPE } from "@/lib/nodeCatalog";
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

/**
 * An agent's hue, taken from the generated node catalog rather than chosen
 * here.
 *
 * `lib/nodeCatalog.ts` is generated from the engine's own registry and a test
 * fails when the two disagree, which is what makes this page, the agent
 * catalog, the header menu and the studio canvas agree about what colour a
 * given agent is. An id the catalog does not know falls back to the neutral
 * slate rather than to a colour invented on the spot.
 */
function agentHue(id: string): string {
  return NODE_BY_TYPE[`agent.${id}`]?.hue ?? "slate";
}

/**
 * "Document Intelligence Agent" is the catalog name, but in a strip of
 * fourteen the word "Agent" lands on every chip and carries nothing. Drop it —
 * unless that would leave a single bare word, where the full name reads
 * better. The header menu shortens the same names for the same reason.
 */
function catalogLabel(name: string): string {
  const short = name.replace(/\s+Agent$/, "");
  return short.includes(" ") ? short : name;
}

/**
 * The three claims under the hero lede, each on its own plate.
 *
 * The hues are categorical, not semantic: violet, cyan and indigo say "these
 * are three different kinds of claim", and every one of them is read out in
 * words beside its plate. Green, amber and rose are deliberately absent —
 * those three mean an outcome everywhere else in the product, and a hero that
 * spent them on decoration would make every green thing on the site
 * unreadable.
 */
const HERO_POINTS: { id: string; hue: string; icon: IconName; text: string }[] = [
  {
    id: "work",
    hue: "violet",
    icon: "activity",
    text: "They read the documents, build the appraisal, score the risk, work the portfolio and speak to the borrower.",
  },
  {
    id: "surface",
    hue: "cyan",
    icon: "globe",
    text: "Eleven Indian languages, one registry behind REST, MCP and the console.",
  },
  {
    id: "audit",
    hue: "indigo",
    icon: "chain",
    text: "Every step appended to a per-tenant hash-chained audit log.",
  },
];

/**
 * A hue and a glyph for each remaining proof point, keyed by the fact's own
 * id so a fact that is renamed loses its decoration rather than silently
 * picking up the wrong one. The figures themselves stay in ink: a measurement
 * is not a state, and colouring it would say it was.
 */
const PROOF_LOOK: Record<string, { hue: string; icon: IconName }> = {
  governor: { hue: "cyan", icon: "sliders" },
  agents: { hue: "violet", icon: "grid" },
  audit: { hue: "indigo", icon: "chain" },
};

const PROOF_FALLBACK = { hue: "slate", icon: "file" } as const;

/**
 * A hue and a glyph per compliance regime. Six regimes, six categorical hues,
 * each printed next to the regime's own name — the hue is a second channel on
 * information the text already carries, which is the only kind of decoration
 * this palette is for.
 */
const REGIME_LOOK: Record<string, { hue: string; icon: IconName }> = {
  "rbi-dl": { hue: "indigo", icon: "book" },
  dpdp: { hue: "violet", icon: "shield" },
  aa: { hue: "cyan", icon: "chain" },
  uidai: { hue: "blue", icon: "file" },
  collections: { hue: "pink", icon: "clock" },
  payments: { hue: "orange", icon: "bolt" },
};

const REGIME_FALLBACK = { hue: "slate", icon: "shield" } as const;

/**
 * The catalog drawn as a spectrum: fourteen agents, each carrying the hue the
 * generated catalog gives it.
 *
 * This is the hero's colour, and it is not decoration — it is the same
 * agent-to-hue mapping the catalog page, the agents menu and the studio canvas
 * read, so a reader who meets teal here meets the same teal on the Document
 * Intelligence page. Every chip names its agent, so nothing is carried by the
 * colour alone.
 *
 * On a phone the row scrolls sideways inside its own container rather than
 * wrapping into fourteen stacked lines and pushing the panel below the fold;
 * the chips are links, so a keyboard reaches every one of them and focusing
 * one scrolls it into view.
 */
function AgentSpectrum() {
  return (
    <div className="mt-12 border-t border-line pt-8 lg:mt-14">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="gv-eyebrow">The catalog · an agent keeps its hue everywhere</p>
        <Link
          href="/agents"
          className="gv-link gv-link-arrow inline-flex items-center gap-1.5 text-[13px]"
        >
          All {AGENTS.length} agents
          <Arrow />
        </Link>
      </div>

      <div className="-mx-5 mt-4 overflow-x-auto px-5 sm:mx-0 sm:overflow-visible sm:px-0">
        <ul className="flex w-max gap-2 sm:w-auto sm:flex-wrap">
          {AGENTS.map((agent) => (
            <li key={agent.id}>
              <Link
                href={`/agents/${agent.id}`}
                style={hueStyle(agentHue(agent.id))}
                className="gv-lift flex items-center gap-2 rounded-full border border-[var(--plate-border)] bg-[var(--plate)] py-1 pr-3.5 pl-1 text-[12.5px] font-medium whitespace-nowrap text-[var(--plate-strong)] no-underline"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface text-[var(--plate-accent)]">
                  <AgentIcon id={agent.id} size={14} />
                </span>
                {catalogLabel(agent.name)}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      {/* Hero — the argument on the left, one running agent on the right, and
          the whole catalog as a spectrum underneath both. */}
      <Band tone="white" pattern="radial" size="lg" className="border-b border-line">
        <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] lg:gap-14">
          <div className="min-w-0">
            <Badge tone="solid" size="md" dot>
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

            <ul className="mt-7 grid max-w-xl gap-2.5">
              {HERO_POINTS.map((point) => (
                <li key={point.id} className="flex items-start gap-3">
                  <span
                    style={hueStyle(point.hue)}
                    className="mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]"
                    aria-hidden="true"
                  >
                    <Icon name={point.icon} size={14} />
                  </span>
                  <span className="gv-support pt-0.5">{point.text}</span>
                </li>
              ))}
            </ul>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href="/build" variant="primary" size="lg">
                Build your own agent
                <Arrow />
              </ButtonLink>
              <ButtonLink href="/console" size="lg">
                Open the console
              </ButtonLink>
              <Link
                href="/docs/quickstart"
                className="gv-link gv-link-arrow inline-flex items-center gap-1.5 text-[13.5px]"
              >
                Read the quickstart
                <Arrow />
              </Link>
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

        <AgentSpectrum />
      </Band>

      {/* The number this platform is built around, drawn rather than asserted. */}
      <Band tone="tint-deep" size="lg" id="call-model">
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

      {/* Proof strip. Each fact keeps its figure, its explanation and its
          source line; the hue and the glyph only say which kind of fact it
          is. */}
      <Band tone="white" size="sm">
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SUPPORTING_PROOF.map((fact) => {
            const look = PROOF_LOOK[fact.id] ?? PROOF_FALLBACK;
            return (
              <li
                key={fact.id}
                style={hueStyle(look.hue)}
                className="gv-card relative flex flex-col overflow-hidden p-5 pl-6"
              >
                <span
                  className="absolute inset-y-0 left-0 w-[3px] bg-[var(--plate-accent)]"
                  aria-hidden="true"
                />
                <div className="flex items-start justify-between gap-3">
                  <p className="gv-label text-ink-3">{fact.label}</p>
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]"
                    aria-hidden="true"
                  >
                    <Icon name={look.icon} size={14} />
                  </span>
                </div>
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
            );
          })}
        </ul>
      </Band>

      {/* Architecture */}
      <Band tone="soft" id="architecture">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.85fr)] lg:gap-14">
          <SectionHeading
            eyebrow="Architecture"
            title="Three planes, and a thin edge"
            lede={
              <>
                MCP and REST validate, authorise, audit and call the service layer. No business
                logic lives at the edge, which is why an agent behaves identically whether
                Graviton called it, a model host called it over MCP, or an underwriter pressed a
                button in the console.
              </>
            }
          />
          <ThreePlanes />
        </div>
      </Band>

      {/* Document economics */}
      <Band tone="white" id="documents">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)] lg:gap-14">
          <DocAiLifecycle />
          <div>
            <SectionHeading
              eyebrow="Document intelligence"
              title="Polling is the traffic"
              lede={
                <>
                  Document reading is asynchronous, so one document is never one call. Counting
                  documents instead of requests is exactly what hides the fact that status polls
                  dominate the traffic against a ten-per-minute ceiling shared by both paths.
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
              className="gv-link gv-link-arrow mt-5 inline-flex items-center gap-1.5 text-[13.5px]"
            >
              Model it yourself in the console
              <Arrow />
            </Link>
          </div>
        </div>
      </Band>

      {/* One instrumented run. Deliberately the quietest block on the page:
          these are measurements, and a measurement that arrives wearing a
          colour is a measurement making a claim. */}
      <Band tone="tint" id="reference-run">
        <div className="gv-panel overflow-hidden">
          <div className="gv-toolbar">
            <p className="flex min-w-0 items-center gap-2.5">
              <span className="gv-icon-plate gv-icon-plate-sm gv-icon-plate-solid">
                <Icon name="activity" size={14} />
              </span>
              <span className="gv-eyebrow">One fully instrumented production run</span>
            </p>
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
            Measured, not modelled. Every agent step writes its tokens, latency and rupee cost
            to the ledger, which is what makes a per-application unit economic a fact rather
            than an estimate.
          </p>
        </div>
      </Band>

      {/* Agent catalog */}
      <Band tone="white" id="agents">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <SectionHeading
            eyebrow="The catalog"
            title={`${AGENTS.length} agents, one source of truth`}
            lede={
              <>
                The REST API, the MCP tool list, the console and this page all read the same
                registry, so an agent cannot exist on one surface and be missing from another.{" "}
                {TIER_COUNTS.P0} in the credit core, {TIER_COUNTS.P1} across risk, collections
                and voice, {TIER_COUNTS.P2} for intelligence and operations.
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
      </Band>

      {/* Compliance */}
      <Band tone="soft" id="compliance">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.65fr)] lg:gap-14">
          <SectionHeading
            eyebrow="Regulated by default"
            title="Written for the regime it operates in"
            lede={
              <>
                Aadhaar masked at the point of extraction. Calling windows enforced in code, not
                in a prompt. Consent scoped per purpose. No automated adverse action. Every
                event appended to a per-tenant hash chain that can be recomputed on demand.
              </>
            }
          />
          <ul className="grid gap-3 sm:grid-cols-2">
            {COMPLIANCE_CONTROLS.slice(0, 6).map((regime) => {
              const look = REGIME_LOOK[regime.id] ?? REGIME_FALLBACK;
              return (
                <li key={regime.id} style={hueStyle(look.hue)} className="gv-card p-4">
                  <p className="flex items-center gap-2.5">
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]"
                      aria-hidden="true"
                    >
                      <Icon name={look.icon} size={14} />
                    </span>
                    <span className="text-[13.5px] font-semibold text-ink">{regime.regime}</span>
                  </p>
                  <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-2">
                    {regime.controls[0]}
                  </p>
                  <p className="mt-2.5 text-[11.5px] font-medium text-[var(--plate-strong)]">
                    +{regime.controls.length - 1} more controls
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="mt-8">
          <ButtonLink href="/security">
            The full control map
            <Arrow />
          </ButtonLink>
        </div>
      </Band>

      {/* Call to action. The one inverse band on the page, which is what the
          design system reserves it for: a closing move that stops the scroll
          without a new colour being invented for it. */}
      <Band tone="inverse" size="lg">
        <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div>
            <h2 className="gv-subheading">
              Point it at your API and watch the real numbers arrive.
            </h2>
            <p className="gv-support mt-4 max-w-2xl">
              The console runs against a local GravAI API on port 8000. Paste a bearer token
              into Settings and every screen switches from example data to live. Without a
              token it still renders everything — clearly labelled as example — so you can see
              what each screen does before you connect anything.
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
      </Band>
    </>
  );
}
