import type { Metadata } from "next";
import Link from "next/link";
import { hueStyle } from "@/components/build/blocks";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { Band, PageHeader } from "@/components/site/Page";
import { Badge, Chip, TierBadge } from "@/components/ui/Badge";
import { Arrow, ButtonLink } from "@/components/ui/Button";
import { Card, Cells, ScrollX, SectionHeading } from "@/components/ui/Surface";
import { AGENTS_BY_ID } from "@/lib/agents";
import { JOURNEY } from "@/lib/platform";
import { NODE_BY_TYPE } from "@/lib/nodeCatalog";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "The Graviton lending journey — onboarding, DigiLocker KYC, credit, BRE, underwriting, deviations, Task Center, LAN — with the GravAI agents overlaid at each stage.",
};

/**
 * A hue per stage, keyed by the stage's own id.
 *
 * WHY THIS IS NOT DECORATION. The eight stages are a sequence, and a sequence
 * is the one thing a reader loses first on a long page: at stage six, nobody
 * remembers whether they are near the beginning or near the end. Running a
 * progression across them puts that information in the periphery, where it
 * costs nothing to read. The strip at the top of the page is the key, every
 * panel below repeats its stage's colour, and the number and the words "Stage n
 * of eight" are printed beside it throughout — so the colour is a second
 * channel for something already stated, never the only one.
 *
 * WHY THESE EIGHT. The arc runs cool to warm, which is the journey's own shape:
 * origination is analytic (violet through cyan), the underwriter's screen is
 * navy because that is where deterministic arithmetic and a versioned scorecard
 * are what a person is reading, deviations are slate because a deviation is
 * deliberately an exception rather than a step, and servicing after disbursal
 * warms up into pink and orange.
 *
 * WHAT IS WITHHELD, AND WHY. Green, amber and rose are absent: they are the
 * platform's outcome colours — proceeded, at risk, stopped — and a lending
 * journey painted in them would tell a reader that stage five is a warning.
 * Teal is absent for a narrower reason: teal means a language model reasoned,
 * everywhere it appears on this site, and this page is precisely where a reader
 * is learning which parts of the journey a model touches. Spending teal on a
 * stage number would be the one place that confusion is most expensive.
 *
 * Keyed by id rather than by position so that reordering `JOURNEY` moves a
 * stage's colour with it instead of silently handing it to its neighbour.
 */
const STAGE_HUES: Record<string, string> = {
  onboarding: "violet",
  kyc: "indigo",
  credit: "blue",
  bre: "cyan",
  underwriting: "navy",
  deviations: "slate",
  tasks: "pink",
  lan: "orange",
};

/**
 * An agent's own hue, from the generated node registry.
 *
 * Note that this is a DIFFERENT system from the stage hue above, and the page
 * deliberately shows both at once: inside a stage panel painted in the stage's
 * colour, each attached agent still wears its own. That is the honest picture —
 * an agent is not owned by the stage it happens to be attached to, and the same
 * agent appears at more than one stage — and it is also what keeps this page
 * agreeing with the catalog, the agent pages and the studio canvas.
 */
function agentHue(id: string): string {
  return NODE_BY_TYPE[`agent.${id}`]?.hue ?? "slate";
}

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
          by a spine so the sequence reads as a sequence. The strip is also
          the key to the progression: every colour on this page is introduced
          there, with its stage number and its name beside it.
         ------------------------------------------------------------------ */}
      <Band tone="soft" pattern="dots" size="lg" id="journey" className="scroll-mt-16">
        <SectionHeading
          eyebrow="The journey"
          title="Eight stages, fourteen agents"
          lede="Read down the left for what Graviton does. Read across for which agents attach, and what they contribute. The colour travels with you: cool at origination, navy at the decision, warm once the loan is live."
          size="lg"
        />

        <nav aria-label="The eight stages" className="mt-9">
          <ScrollX label="Journey stages" className="pb-1">
            <ol className="flex min-w-[760px] items-stretch">
              {JOURNEY.map((stage, index) => (
                <li
                  key={stage.id}
                  style={hueStyle(STAGE_HUES[stage.id] ?? "slate")}
                  className="relative min-w-0 flex-1"
                >
                  {index < JOURNEY.length - 1 ? (
                    <span
                      aria-hidden="true"
                      className="absolute top-[13px] left-1/2 h-px w-full bg-[var(--plate-accent)] opacity-40"
                    />
                  ) : null}
                  <a
                    href={`#stage-${stage.id}`}
                    className="group relative block px-2 text-center no-underline"
                  >
                    <span
                      className="relative z-10 mx-auto flex h-[27px] w-[27px] items-center justify-center rounded-full border border-[var(--plate-border)] bg-[var(--plate)] font-mono text-[11px] font-medium text-[var(--plate-strong)] shadow-resting transition-colors duration-150 ease-gv group-hover:border-[var(--plate-accent)] group-hover:bg-[var(--plate-accent)] group-hover:text-white"
                      data-numeric=""
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="mt-3 block text-[12.5px] leading-snug font-medium text-ink transition-colors duration-150 ease-gv group-hover:text-[var(--plate-strong)]">
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
            const stagePlate = hueStyle(STAGE_HUES[stage.id] ?? "slate");

            return (
              <li
                key={stage.id}
                id={`stage-${stage.id}`}
                style={stagePlate}
                className="scroll-mt-24"
              >
                {index > 0 ? (
                  <span
                    aria-hidden="true"
                    className="ml-7 block h-9 w-px bg-[var(--plate-accent)] opacity-40 sm:ml-8"
                  />
                ) : null}

                <article className="gv-panel overflow-hidden border-[var(--plate-border)]">
                  <header className="gv-toolbar bg-[var(--plate)]">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className="gv-icon-plate gv-icon-plate-sm border-[var(--plate-accent)] bg-[var(--plate-accent)] font-mono text-[12px] font-semibold text-white"
                        data-numeric=""
                      >
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div className="min-w-0">
                        <p className="gv-eyebrow text-[var(--plate-strong)]">
                          Stage {index + 1} of {JOURNEY.length}
                        </p>
                        <h3 className="text-[17px] leading-tight text-ink">{stage.step}</h3>
                      </div>
                    </div>
                    <Chip>
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

                    {/* Each attached agent keeps its OWN colour inside a panel
                        painted in the stage's. An agent belongs to itself, not
                        to the stage it is attached at — several of these appear
                        at more than one stage — and overriding its hue here
                        would make this the one page on the site where an agent
                        changes colour depending on where you found it. */}
                    <div className="min-w-0">
                      <p className="gv-eyebrow mb-3">What GravAI attaches</p>
                      <ul className="gv-cells">
                        {attached.map((agent) => (
                          <li key={agent.id} style={hueStyle(agentHue(agent.id))}>
                            <Link
                              href={`/agents/${agent.id}`}
                              className="gv-link-arrow flex w-full items-center gap-3 p-3.5 no-underline transition-colors duration-150 ease-gv hover:bg-[var(--plate)]"
                            >
                              <span
                                aria-hidden="true"
                                className="gv-icon-plate gv-icon-plate-sm border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]"
                              >
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
          The three human gates. One elevated statement, three cells. These
          stay brand rather than joining the progression: a gate is not a
          ninth stage, it is the thing that stops the other eight, and giving
          it a colour from the same ramp would file it as one of them.
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
          The memorandum. Drawn as the document it is, not as four cards, and
          left in the document's own greys: this is the artefact a person
          reads and signs, and a memorandum that arrives in five colours looks
          like a brochure rather than a credit file.
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
