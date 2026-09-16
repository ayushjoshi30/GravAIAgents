import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentPipeline } from "@/components/agents/AgentPipeline";
import { hueStyle } from "@/components/build/blocks";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { AiCapabilityList } from "@/components/site/AiCapabilityCard";
import { Band, PageHeader } from "@/components/site/Page";
import { UseCaseFlow, UseCaseProof } from "@/components/site/UseCaseFlow";
import { Badge, Tag, TierBadge } from "@/components/ui/Badge";
import { Arrow, ButtonLink } from "@/components/ui/Button";
import { SectionHeading } from "@/components/ui/Surface";
import { AGENTS, getAgent, type Agent } from "@/lib/agents";
import { getUseCase } from "@/lib/agent-usecase";
import { NODE_BY_TYPE } from "@/lib/nodeCatalog";

export function generateStaticParams() {
  return AGENTS.map((agent) => ({ id: agent.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const agent = getAgent(id);
  if (!agent) return { title: "Agent not found" };
  return {
    title: agent.name,
    description: agent.summary,
  };
}

/**
 * The agent's hue, read from the generated node catalog rather than chosen here.
 *
 * `lib/nodeCatalog.ts` is generated from the engine's own registry and a test
 * fails when the two disagree, so this is the single answer to "what colour is
 * this agent" that the studio canvas, the sketchpad, the catalog listing and
 * this page all share. A local table would be a second answer, and the failure
 * when someone adds an agent and forgets to extend it is the worst kind: a page
 * that renders perfectly, in a colour that means nothing.
 *
 * `slate` is the fallback rather than a thrown error, because an agent present
 * in the catalog but not yet in the node registry is a real intermediate state
 * during a release, and a grey plate is a better answer to it than a blank page.
 */
function agentHue(id: string): string {
  return NODE_BY_TYPE[`agent.${id}`]?.hue ?? "slate";
}

/**
 * One of the three contract lists, with a rule down its left edge.
 *
 * `accent` says whether that rule takes the agent's own hue or stays neutral.
 * Only one of the three takes it — the tools the agent may call — because a
 * block where every rule is the same colour is a block where the colour has
 * stopped pointing at anything. Inputs are what the agent is handed and output
 * keys are what it returns; both are the contract's plumbing, and they read
 * better quiet.
 */
function ListBlock({
  heading,
  items,
  accent = false,
  mono = false,
}: {
  heading: string;
  items: string[];
  accent?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className={`gv-eyebrow mb-3 ${accent ? "text-[var(--plate-strong)]" : ""}`}>{heading}</p>
      <ul className="space-y-2.5">
        {items.map((item) => (
          <li
            key={item}
            className={`border-l-2 pl-3 text-[13.5px] leading-relaxed text-ink-2 ${
              accent ? "border-[var(--plate-accent)]" : "border-line-strong"
            } ${mono ? "font-mono text-[12px] break-words" : ""}`}
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The previous / next card, in the NEIGHBOUR's hue rather than this page's.
 *
 * This is the clearest place on the site to show that a hue belongs to an agent
 * and not to a page: two cards side by side, each already wearing the colour the
 * reader will find when they arrive. Setting the hue on the card itself rather
 * than inheriting it from the page is what makes that possible.
 */
function NeighbourLink({ agent, direction }: { agent: Agent; direction: "Previous" | "Next" }) {
  const isNext = direction === "Next";
  return (
    <Link
      href={`/agents/${agent.id}`}
      style={hueStyle(agentHue(agent.id))}
      className={`gv-card gv-card-interactive group flex items-center gap-4 p-5 no-underline hover:border-[var(--plate-accent)] focus-within:border-[var(--plate-accent)] ${
        isNext ? "flex-row-reverse text-right" : ""
      }`}
    >
      <span className="gv-icon-plate gv-icon-plate-lg border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]">
        <AgentIcon id={agent.id} size={22} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="gv-eyebrow block">{direction} agent</span>
        <span className="mt-1.5 block text-[15px] leading-snug font-semibold text-ink">
          {agent.name}
        </span>
        <span className="mt-1 block font-mono text-[11.5px] text-ink-3">{agent.toolName}</span>
      </span>
    </Link>
  );
}

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const agent = getAgent(id);
  if (!agent) notFound();

  const index = AGENTS.findIndex((candidate) => candidate.id === agent.id);
  const previous = AGENTS[(index - 1 + AGENTS.length) % AGENTS.length];
  const next = AGENTS[(index + 1) % AGENTS.length];
  const useCase = getUseCase(agent.id);

  /**
   * The agent's four palette steps, hung on the subtrees that wear them.
   *
   * Deliberately NOT set on a wrapper around the whole page. The explainer below
   * is the one thing here whose colour is a CLAIM — teal is a language model
   * reasoning, navy is deterministic code — and a page-level custom property is
   * a standing invitation for that diagram to inherit a decorative hue one
   * refactor from now. Setting it per subtree costs a few repeated `style`
   * attributes and makes the omission around the diagram visible in the markup
   * instead of implicit in a cascade.
   *
   * THE RULE FOR WHERE IT MAY LAND is narrower than "anywhere on the page",
   * and three of the fourteen agents are the reason. Risk scoring's generated
   * hue is amber, MSME underwriting's is green and collections allocation's is
   * rose — the three the palette reserves for outcome. Beside the agent's own
   * name, or on the card that carries its contract, that colour is plainly its
   * identity and can be read no other way. Spread across furniture that has
   * nothing to do with naming it — a grid of guardrail numbers, a panel of eval
   * gates — the same green stops being a name and starts looking like a verdict
   * on whatever it is decorating, which is the failure that would cost every
   * other green on the site its meaning.
   *
   * So the hue is spent here on four things and no others: the mark beside the
   * agent's name, the header of its own contract panel, the rule against the
   * one list that is specifically this agent's reach, and the two neighbour
   * cards, each of which wears its own. Everything else is carried by the band
   * grounds, which cost nothing and claim nothing.
   */
  const plate = hueStyle(agentHue(agent.id));

  return (
    <>
      <PageHeader
        eyebrow={`Agent · tier ${agent.tier}`}
        title={
          <span className="flex flex-wrap items-center gap-4">
            <span
              style={plate}
              className="gv-icon-plate gv-icon-plate-lg border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]"
            >
              <AgentIcon id={agent.id} size={26} />
            </span>
            {agent.name}
          </span>
        }
        lede={agent.detail.purpose}
        aside={
          <div style={plate} className="gv-panel overflow-hidden">
            <header className="gv-toolbar bg-[var(--plate)]">
              <h2 className="text-[13px] font-semibold text-[var(--plate-strong)]">
                Contract at a glance
              </h2>
              <TierBadge tier={agent.tier} />
            </header>
            <dl className="gv-divide">
              <div className="px-4 py-3">
                <dt className="gv-eyebrow">MCP tool</dt>
                <dd className="mt-1.5 font-mono text-[14px] break-all text-[var(--plate-strong)]">
                  {agent.toolName}
                </dd>
              </div>
              <div className="px-4 py-3">
                <dt className="gv-eyebrow">Scopes required</dt>
                <dd className="mt-2 flex flex-wrap gap-1.5">
                  {agent.scopes.map((scope) => (
                    <Tag key={scope}>{scope}</Tag>
                  ))}
                </dd>
              </div>
              <div className="px-4 py-3">
                <dt className="gv-eyebrow">Authority</dt>
                <dd className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
                  {agent.advisoryOnly ? (
                    <>
                      <Badge tone="brand">advisory only</Badge>
                      Never takes an irreversible action on its own.
                    </>
                  ) : (
                    <>
                      <Badge tone="amber" dot>
                        acts
                      </Badge>
                      Places calls. Guardrails are enforced in code.
                    </>
                  )}
                </dd>
              </div>
              <div className="px-4 py-3">
                <dt className="gv-eyebrow">Capability parity</dt>
                <dd className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
                  {agent.parityWith ?? "No direct market equivalent named."}
                </dd>
              </div>
            </dl>
          </div>
        }
      />

      {/* ------------------------------------------------------------------
          The explainer. The one band on this page carrying no decorative
          colour at all: inside that diagram teal means a language model
          reasoned and navy means code reached a fixed answer, and a third
          colour standing next to them would cost the reader the only
          distinction the picture exists to make. The agent's own hue resumes
          in the band below.
         ------------------------------------------------------------------ */}
      <Band tone="white" id="how-it-works" className="scroll-mt-16">
        <div className="flex flex-wrap items-center gap-2">
          <TierBadge tier={agent.tier} />
          {agent.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </div>

        <div className="mt-10">
          <SectionHeading
            eyebrow="How it works"
            title="One run, stage by stage"
            lede="Left to right: what the agent is handed, the stages the work moves through, and the fields it returns. Teal is a language model reasoning. Navy is deterministic code. That split is the whole platform — an arithmetic result is computed, and only the sentence around it is written."
          />
          <div className="mt-8">
            <AgentPipeline agent={agent} specLink={false} />
          </div>
          <p className="mt-4 max-w-3xl text-[12.5px] leading-relaxed text-ink-3">
            Nothing in the diagram is drawn per agent. Every stage is read from this
            agent&apos;s own catalog entry — its declared inputs, its tool allowlist, the AI
            capabilities it consumes and the top-level keys of its output contract — the same
            entry the REST API and the MCP tool list read. It can only go stale when the
            catalog does.
          </p>
        </div>
      </Band>

      {/* ------------------------------------------------------------------
          The contract: the three lists the diagram above was drawn from.
         ------------------------------------------------------------------ */}
      <Band tone="soft" id="contract">
        <div style={plate}>
          <SectionHeading
            size="sm"
            eyebrow="The contract"
            title="What goes in, what it may touch, what comes back"
            lede="These three lists are the diagram above in longhand. Nothing here is a summary of the catalog entry; it is the entry."
          />
          <div className="mt-8 grid gap-8 lg:grid-cols-3 lg:gap-10">
            <ListBlock heading="Inputs" items={agent.detail.inputs} />
            <ListBlock heading="Tools it may call" items={agent.detail.tools} accent />
            <ListBlock
              heading="Output contract — top-level keys"
              items={agent.detail.outputKeys}
              mono
            />
          </div>
        </div>
      </Band>

      {useCase ? (
        <Band tone="white" id="worked-example">
          <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
            <div className="min-w-0">
              <SectionHeading
                eyebrow="Worked example"
                title="What it did with a real application"
                lede={useCase.scenario}
              />
              <p className="mt-5 text-[12.5px] leading-relaxed text-ink-3">
                Every figure on the right was captured by running this agent against the
                sandbox, not written by hand. If the agent changes, the run changes and this
                panel changes with it.
              </p>
              <div className="mt-9">
                <UseCaseProof useCase={useCase} />
              </div>
            </div>
            <UseCaseFlow useCase={useCase} />
          </div>
        </Band>
      ) : null}

      {/* ------------------------------------------------------------------
          Guardrails. THESE PLATES STAY BRAND, and the reason is the whole
          argument about how far an agent's hue may travel from its name.
          Three of the fourteen own a hue the palette reserves for outcome —
          risk scoring is amber, MSME underwriting is green, collections
          allocation is rose. Beside the agent's own name that colour is its
          identity and reads as nothing else. Repeated down a grid of six
          numbered rules headed "what this agent is not allowed to do" it
          stops being a name and starts looking like a verdict on each rule,
          and a green square against a guardrail is exactly the confusion
          that makes every green thing on the site unreadable. The band's own
          ground carries this section instead.
         ------------------------------------------------------------------ */}
      <Band tone="tint" id="guardrails">
        <SectionHeading
          eyebrow="Guardrails"
          title="What this agent is not allowed to do"
          lede="Written into the prompt and enforced by output validators. A rule that only exists in a prompt is a suggestion; every rule below has a check behind it."
        />
        <ol className="gv-cells gv-cells-raised mt-8 sm:grid-cols-2">
          {agent.detail.rules.map((rule, ruleIndex) => (
            <li key={rule} className="flex gap-4 p-5">
              <span
                className="gv-icon-plate gv-icon-plate-sm shrink-0 font-mono text-[12px] font-semibold"
                data-numeric=""
              >
                {String(ruleIndex + 1).padStart(2, "0")}
              </span>
              <p className="min-w-0 pt-1 text-[13.5px] leading-relaxed text-ink-2">{rule}</p>
            </li>
          ))}
        </ol>
      </Band>

      {/* ------------------------------------------------------------------
          Escalation and evals. THE AMBER HERE IS NOT DECORATION: the palette
          reserves amber for a rule that can stop or divert a run, and an
          escalation is exactly that, so this panel keeps amber whatever hue
          the agent itself carries.

          The eval panel beside it is the one place the agent's hue was
          actively dangerous and has been taken away. It ends on the sentence
          "all gates must be green" — and on the MSME underwriting agent,
          whose generated hue IS green, a green tick above that sentence
          asserts the gates have passed. They have not; the panel only lists
          what must pass. Brand says nothing, which is the correct thing to
          say here.
         ------------------------------------------------------------------ */}
      <Band tone="white" id="escalation">
        <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
          <div className="min-w-0 rounded-xl border border-amber-border bg-amber-soft p-5 sm:p-6">
            <p className="gv-eyebrow mb-3 flex items-center gap-2 text-amber-strong">
              <span aria-hidden="true">
                <Icon name="warning" size={14} />
              </span>
              Escalates to a human when
            </p>
            <ul className="space-y-2.5">
              {agent.detail.escalateWhen.map((item) => (
                <li key={item} className="text-[13.5px] leading-relaxed text-ink-2">
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[12px] leading-relaxed text-amber-strong">
              An escalation is the agent handing a decision to a person. It is the designed
              outcome, not a failed run.
            </p>
          </div>

          <div className="gv-card min-w-0 p-5 sm:p-6">
            <p className="gv-eyebrow mb-3 flex items-center gap-2">
              <span className="text-brand" aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
              Eval gates before a prompt version is promoted
            </p>
            <ul className="space-y-2.5">
              {agent.detail.evals.map((item) => (
                <li key={item} className="text-[13.5px] leading-relaxed text-ink-2">
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
              All gates must be green before a candidate version can be promoted, and the
              promotion itself is an approved, audited change.
            </p>
          </div>
        </div>
      </Band>

      <Band tone="soft" id="ai-capabilities">
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:gap-12">
          <SectionHeading
            eyebrow="AI capabilities consumed"
            title="What this agent spends"
            lede="Every call this agent makes is written to the cost ledger with its tokens, pages, audio seconds and rupee cost against a versioned rate card."
          />
          <AiCapabilityList capabilities={agent.detail.aiServices} />
        </div>
        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink href="/console/runs" variant="primary">
            See runs of this agent
            <Arrow />
          </ButtonLink>
          <ButtonLink href="/docs/agent-reference">Full agent reference</ButtonLink>
        </div>
      </Band>

      <Band tone="white" size="sm">
        <nav aria-label="Other agents" className="grid gap-4 sm:grid-cols-2">
          <NeighbourLink agent={previous} direction="Previous" />
          <NeighbourLink agent={next} direction="Next" />
        </nav>
      </Band>
    </>
  );
}
