import type { Metadata } from "next";
import Link from "next/link";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { Band, PageHeader } from "@/components/site/Page";
import { Badge, Chip, TierBadge } from "@/components/ui/Badge";
import { Arrow, ButtonLink } from "@/components/ui/Button";
import { Card, Cells, ScrollX, SectionHeading } from "@/components/ui/Surface";
import { AGENTS_BY_ID } from "@/lib/agents";
import { JOURNEY } from "@/lib/platform";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "The Graviton lending journey — onboarding, DigiLocker KYC, credit, BRE, underwriting, deviations, Task Center, LAN — with the GravAI agents overlaid at each stage.",
};

/** The three points in the journey where a person, not an agent, decides. */
const HUMAN_GATES = [
  {
    gate: "The credit decision",
    body: "The Credit Appraisal agent always returns escalate: true for the decision itself. It recommends; an underwriter approves in the console, with a mandatory note that enters the audit chain.",
    who: "Underwriter or credit head",
  },
  {
    gate: "Every deviation",
    body: "A deviation carries its parameter, the policy value, the actual value and a severity from L1 to L3, and routes through the tenant's approval matrix. Nothing self-approves, at any severity.",
    who: "Approval matrix, by severity",
  },
  {
    gate: "Any adverse action",
    body: "A rejection is drafted in plain language with the reason and its evidence, and waits. No adverse action reaches a borrower without a person having read and approved it.",
    who: "A named approver, always",
  },
];

/** The four parts of the memorandum an underwriter opens. */
const MEMO_SECTIONS = [
  {
    label: "Eligibility",
    body: "FOIR and LTV computed in code, printed with the formula and every input that fed it. Anything missing is named, never estimated.",
  },
  {
    label: "Income build-up",
    body: "Each income source with the statement lines that evidence it, reconciled month by month to within ₹1.",
  },
  {
    label: "BRE outcomes",
    body: "Every rule, pass or fail, restated in language fit for an adverse-action note — no jargon, no protected attributes.",
  },
  {
    label: "Deviations",
    body: "Parameter, policy, actual, severity and the approval matrix entry that decides who signs it off.",
  },
];

export default function HowItWorksPage() {
  return (
    <>
      <PageHeader
        eyebrow="How it works"
        title="Graviton runs the journey. GravAI staffs it."
        lede={
          <>
            GravAI does not replace the loan origination system and does not become the system
            of record. It attaches an agent to each stage Graviton already has, does the
            reading and the arithmetic and the explaining, and hands every judgement back to a
            person with the evidence attached.
          </>
        }
        actions={
          <>
            <ButtonLink href="#journey" variant="primary" size="lg">
              Walk the eight stages
              <Arrow />
            </ButtonLink>
            <ButtonLink href="/agents" size="lg">
              Agent catalog
            </ButtonLink>
          </>
        }
        aside={
          <Card variant="elevated" className="p-5">
            <p className="gv-eyebrow mb-3 flex items-center gap-2 text-brand">
              <span className="gv-pip gv-pip-brand" aria-hidden="true" />
              The boundary
            </p>
            <p className="gv-support">
              Graviton stays the system of record. GravAI holds a projection, writes back
              status transitions and pendencies, and keeps its own append-only log of every
              step it took to get there.
            </p>
            <dl className="gv-divide mt-4 border-t border-line pt-3 text-[13px]">
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="gv-label text-ink-3">System of record</dt>
                <dd className="font-medium text-ink">Graviton</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="gv-label text-ink-3">GravAI holds</dt>
                <dd className="font-medium text-ink">A projection</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="gv-label text-ink-3">Write-back</dt>
                <dd className="font-medium text-ink">Status · pendencies</dd>
              </div>
            </dl>
          </Card>
        }
      />

      {/* ------------------------------------------------------------------
          The journey. A pipeline strip first, so the eight stages are one
          object before they are eight panels; then a stage per panel, joined
          by a spine so the sequence reads as a sequence.
         ------------------------------------------------------------------ */}
      <Band tone="soft" pattern="dots" size="lg" id="journey" className="scroll-mt-16">
        <SectionHeading
          eyebrow="The journey"
          title="Eight stages, fourteen agents"
          lede="Read down the left for what Graviton does. Read across for which agents attach, and what they contribute."
          size="lg"
        />

        <nav aria-label="The eight stages" className="mt-9">
          <ScrollX label="Journey stages" className="pb-1">
            <ol className="flex min-w-[760px] items-stretch">
              {JOURNEY.map((stage, index) => (
                <li key={stage.id} className="relative min-w-0 flex-1">
                  {index < JOURNEY.length - 1 ? (
                    <span
                      aria-hidden="true"
                      className="absolute top-[13px] left-1/2 h-px w-full bg-brand-200"
                    />
                  ) : null}
                  <a
                    href={`#stage-${stage.id}`}
                    className="group relative block px-2 text-center no-underline"
                  >
                    <span
                      className="relative z-10 mx-auto flex h-[27px] w-[27px] items-center justify-center rounded-full border border-brand-200 bg-surface font-mono text-[11px] font-medium text-brand shadow-resting transition-colors duration-150 ease-gv group-hover:border-brand group-hover:bg-brand group-hover:text-white"
                      data-numeric=""
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="mt-3 block text-[12.5px] leading-snug font-medium text-ink transition-colors duration-150 ease-gv group-hover:text-brand">
                      {stage.step}
                    </span>
                    <span className="gv-micro mt-1 block">
                      {stage.agents.length} {stage.agents.length === 1 ? "agent" : "agents"}
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          </ScrollX>
        </nav>

        <ol className="mt-10">
          {JOURNEY.map((stage, index) => {
            const attached = stage.agents
              .map((agentId) => AGENTS_BY_ID[agentId])
              .filter((agent) => Boolean(agent));

            return (
              <li key={stage.id} id={`stage-${stage.id}`} className="scroll-mt-24">
                {index > 0 ? (
                  <span
                    aria-hidden="true"
                    className="ml-7 block h-9 w-px bg-brand-200 sm:ml-8"
                  />
                ) : null}

                <article className="gv-panel overflow-hidden">
                  <header className="gv-toolbar">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className="gv-icon-plate gv-icon-plate-sm font-mono text-[12px] font-semibold"
                        data-numeric=""
                      >
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div className="min-w-0">
                        <p className="gv-eyebrow">
                          Stage {index + 1} of {JOURNEY.length}
                        </p>
                        <h3 className="text-[17px] leading-tight text-ink">{stage.step}</h3>
                      </div>
                    </div>
                    <Chip tone="brand">
                      {stage.agents.length} {stage.agents.length === 1 ? "agent" : "agents"}{" "}
                      attached
                    </Chip>
                  </header>

                  <div className="grid gap-x-8 gap-y-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
                    <div className="min-w-0">
                      <div className="gv-well p-4">
                        <p className="gv-eyebrow mb-2 flex items-center gap-2">
                          <span className="gv-pip gv-pip-brand" aria-hidden="true" />
                          In Graviton
                        </p>
                        <p className="text-[13px] leading-relaxed text-ink-2">
                          {stage.graviton}
                        </p>
                      </div>
                      <p className="gv-support mt-4">{stage.detail}</p>
                    </div>

                    <div className="min-w-0">
                      <p className="gv-eyebrow mb-3">What GravAI attaches</p>
                      <ul className="gv-cells">
                        {attached.map((agent) => (
                          <li key={agent.id}>
                            <Link
                              href={`/agents/${agent.id}`}
                              className="gv-link-arrow flex w-full items-center gap-3 p-3.5 no-underline transition-colors duration-150 ease-gv hover:bg-brand-50"
                            >
                              <span className="gv-icon-plate gv-icon-plate-sm" aria-hidden="true">
                                <AgentIcon id={agent.id} size={16} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-[13.5px] font-medium text-ink">
                                  {agent.name}
                                </span>
                                <span className="mt-0.5 block font-mono text-[11px] text-ink-3">
                                  {agent.toolName}
                                </span>
                              </span>
                              <span className="hidden shrink-0 sm:block">
                                <TierBadge tier={agent.tier} />
                              </span>
                              <Arrow className="shrink-0 text-ink-3" />
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      </Band>

      {/* ------------------------------------------------------------------
          The three human gates. One elevated statement, three cells.
         ------------------------------------------------------------------ */}
      <Band tone="white" id="human-gates">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] lg:gap-14">
          <div className="min-w-0">
            <SectionHeading
              eyebrow="Where a human always stands"
              title="Three gates that cannot be configured away"
              lede="These are not automation settings waiting to be switched on. They are properties of the workflow."
            />
            <div className="gv-card gv-card-secondary mt-7 p-5">
              <p className="gv-eyebrow mb-2 flex items-center gap-2">
                <span className="text-brand" aria-hidden="true">
                  <Icon name="shield" size={14} />
                </span>
                Advisory by default
              </p>
              <p className="gv-support">
                Every agent recommends. Nothing in the journey takes an irreversible credit
                action on its own.
              </p>
            </div>
            <div className="mt-7">
              <ButtonLink href="/console/review" variant="primary">
                See the review queue
                <Arrow />
              </ButtonLink>
            </div>
          </div>

          <ol className="gv-cells gv-cells-raised">
            {HUMAN_GATES.map((item, index) => (
              <li key={item.gate} className="p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="flex min-w-0 items-center gap-3">
                    <span
                      className="gv-icon-plate gv-icon-plate-sm gv-icon-plate-solid font-mono text-[12px] font-semibold"
                      data-numeric=""
                    >
                      {index + 1}
                    </span>
                    <span className="text-[15.5px] font-semibold text-ink">{item.gate}</span>
                  </p>
                  <Badge tone="brand">Human required</Badge>
                </div>
                <p className="gv-support mt-3 sm:pl-10">{item.body}</p>
                <p className="gv-micro mt-3 sm:pl-10">Approves: {item.who}</p>
              </li>
            ))}
          </ol>
        </div>
      </Band>

      {/* ------------------------------------------------------------------
          The memorandum. Drawn as the document it is, not as four cards.
         ------------------------------------------------------------------ */}
      <Band tone="tint" id="evidence">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] lg:gap-14">
          <div className="min-w-0">
            <SectionHeading
              eyebrow="What an underwriter actually receives"
              title="A memorandum with its working shown"
              lede="Not a score and a sentence. The arithmetic, its inputs, the rule outcomes in plain language, the deviations with their severity, and a citation on every extracted value."
            />
            <ul className="gv-checklist gv-support mt-7">
              <li>Every figure prints the formula and the inputs that produced it.</li>
              <li>Every extracted value carries a citation back to the page it came from.</li>
              <li>Anything missing is named as missing, never quietly estimated.</li>
            </ul>
          </div>

          <div className="gv-panel min-w-0 overflow-hidden">
            <div className="gv-chrome">
              <span className="font-mono text-[11.5px] text-ink-3">
                credit_appraisal_memorandum
              </span>
            </div>
            <ol className="gv-divide">
              {MEMO_SECTIONS.map((item, index) => (
                <li key={item.label} className="flex gap-4 p-5">
                  <span
                    className="mt-0.5 shrink-0 font-mono text-[11.5px] text-ink-3"
                    data-numeric=""
                  >
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[14.5px] font-semibold text-ink">{item.label}</p>
                    <p className="gv-support mt-1.5">{item.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-2 px-5 py-3">
              <p className="gv-micro">Annexure: every agent step, prompt version and citation</p>
              <span className="inline-flex items-center gap-2 text-[12.5px] font-medium text-ink-2">
                <span className="gv-pip" aria-hidden="true" />
                Awaiting underwriter
              </span>
            </div>
          </div>
        </div>
      </Band>

      {/* ------------------------------------------------------------------
          The one inverse band on this page.
         ------------------------------------------------------------------ */}
      <Band tone="inverse" pattern="radial-center" size="lg">
        <div className="mx-auto max-w-2xl text-center">
          <p className="gv-eyebrow mb-4">The same journey, three ways in</p>
          <h2 className="gv-heading text-white">
            Attach an agent to a stage. Keep the system of record where it is.
          </h2>
          <p className="gv-lede mt-4">
            Every agent on this page is reachable from Graviton over REST, from any model host
            over MCP, and from the GravAI console — all three through the same service layer.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <ButtonLink href="/agents" variant="primary" size="lg">
              Browse the agent catalog
              <Arrow />
            </ButtonLink>
            <ButtonLink href="/platform" size="lg">
              How the platform holds it
            </ButtonLink>
          </div>
          <Cells columns={3} className="mt-12 text-left">
            <div className="p-5">
              <p className="gv-eyebrow mb-1.5">Stages</p>
              <p className="text-[15px] font-medium text-white">Eight, unchanged</p>
            </div>
            <div className="p-5">
              <p className="gv-eyebrow mb-1.5">Decisions</p>
              <p className="text-[15px] font-medium text-white">Always a person</p>
            </div>
            <div className="p-5">
              <p className="gv-eyebrow mb-1.5">Record</p>
              <p className="text-[15px] font-medium text-white">Append-only, per tenant</p>
            </div>
          </Cells>
        </div>
      </Band>
    </>
  );
}
