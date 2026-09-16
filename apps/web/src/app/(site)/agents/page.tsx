import type { Metadata } from "next";
import Link from "next/link";
import { AgentPipeline } from "@/components/agents/AgentPipeline";
import { hueStyle } from "@/components/build/blocks";
import { AgentIcon } from "@/components/icons/AgentIcon";
import { AgentCard } from "@/components/site/AgentCard";
import { AgentTierMark } from "@/components/site/AgentTierMark";
import { Band, PageHeader } from "@/components/site/Page";
import { Cells, SectionHeading } from "@/components/ui/Surface";
import { AGENTS, TIERS, TIER_COUNTS, getAgent, type Agent, type AgentTier } from "@/lib/agents";
import { NODE_BY_TYPE } from "@/lib/nodeCatalog";

export const metadata: Metadata = {
  title: "Agents",
  description:
    "All fourteen GravAI agents: document intelligence, bank statement analytics, credit appraisal, risk scoring, account aggregator data, KYC, collections allocation, mandates, voice, speech analytics, onboarding, MSME underwriting, segmentation and ops research.",
};

/**
 * The agent's hue, read from the generated node catalog rather than chosen here.
 *
 * The mapping of agent to colour is declared once, in the generator that writes
 * `lib/nodeCatalog.ts` from the engine's registry, and a test fails if the two
 * drift apart. That is the only reason this page, an agent's own page and the
 * studio canvas can be trusted to agree about what colour a given agent is — so
 * the lookup happens here, and the decision does not.
 */
function agentHue(id: string): string {
  return NODE_BY_TYPE[`agent.${id}`]?.hue ?? "slate";
}

/**
 * One agent in the tier legend: its mark, in its colour, next to its name.
 *
 * The colour never stands alone. It sits against the name it belongs to, which
 * is what makes the legend a legend rather than a decoration — and what lets a
 * reader who cannot separate two of these hues lose nothing at all.
 */
function LegendEntry({ agent }: { agent: Agent }) {
  return (
    <li>
      <Link
        href={`/agents/${agent.id}`}
        style={hueStyle(agentHue(agent.id))}
        /* Deliberately NOT `gv-link-arrow`: that class animates a link's LAST
           child on hover, which is right when the last child is a trailing
           arrow and wrong here, where it is the agent's name — the name would
           slide 3px every time the pointer crossed it. A legend of fourteen
           rows is a place to sit still. */
        className="group flex items-center gap-2.5 rounded-md py-1.5 no-underline transition-colors duration-150 ease-gv hover:bg-[var(--plate)]"
      >
        <span className="gv-icon-plate gv-icon-plate-sm border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]">
          <AgentIcon id={agent.id} size={14} />
        </span>
        <span className="min-w-0 text-[13px] leading-snug text-ink-2 transition-colors duration-150 ease-gv group-hover:text-[var(--plate-strong)]">
          {agent.name}
        </span>
      </Link>
    </li>
  );
}

export default function AgentsPage() {
  const parityCount = AGENTS.filter((agent) => agent.parityWith).length;
  const actingCount = AGENTS.filter((agent) => !agent.advisoryOnly).length;

  /**
   * One worked diagram at the top of the page, not fourteen down it.
   *
   * The same explainer sits on every agent's own page, so putting a compact
   * copy on all fourteen cards here would say nothing new fourteen times, and
   * fourteen six-second loops running at once is a page that flickers rather
   * than a page that explains. The cards below keep a motion of their own —
   * the three motifs that draw something in transit start it flowing on hover
   * or keyboard focus, one card at a time, which is motion the reader asked
   * for by pointing at it rather than motion the page inflicts.
   *
   * Document intelligence is the example because it is where an application
   * physically starts: a file arrives before anything can be decided about it.
   * The panel is labelled with that agent's name so nobody reads it as a
   * generic picture of "an agent".
   */
  const exhibit = getAgent("doc_intelligence");

  const facts: { label: string; value: string }[] = [
    { label: "Agents", value: `${AGENTS.length}` },
    { label: "Tiers", value: `${TIERS.length}` },
    { label: "Advisory only", value: `${AGENTS.length - actingCount} of ${AGENTS.length}` },
    { label: "Parity mapped", value: `${parityCount} of ${AGENTS.length}` },
  ];

  const byTier = (tier: AgentTier) => AGENTS.filter((agent) => agent.tier === tier);

  return (
    <>
      <PageHeader
        eyebrow="Agent catalog"
        title={`${AGENTS.length} agents, defined once`}
        lede={
          <>
            Every agent is a prompt, a tool allowlist, an output schema and a set of
            guardrails. The REST API, the MCP tool list, the console and this page read the
            same registry in{" "}
            <code className="gv-code">packages/gravai_agents/catalog.py</code>, so the catalog
            cannot disagree with itself.
          </>
        }
        aside={
          <div>
            <Cells as="dl" columns={2} raised>
              {facts.map((fact) => (
                <div key={fact.label} className="p-4">
                  <dt className="gv-eyebrow">{fact.label}</dt>
                  <dd className="mt-1.5 font-mono text-[20px] text-ink" data-numeric="">
                    {fact.value}
                  </dd>
                </div>
              ))}
            </Cells>
            <div className="mt-4 space-y-2">
              <p className="gv-micro">
                Only the voice collections agent takes an irreversible action on its own, and
                its guardrails are hard-coded rather than prompted.
              </p>
              <p className="gv-micro">
                Where an agent replaces a named market capability, the catalog says which one
                rather than leaving it implied.
              </p>
            </div>
          </div>
        }
      />

      {/* ------------------------------------------------------------------
          Jump to a tier. The nearest thing this page has to a filter, and it
          works without a line of JavaScript, without hiding anything from a
          reader who wants the whole list, and without breaking the back
          button. Each link carries the tier's own mark, so the control and
          the marker on every card in that tier are visibly the same object.
         ------------------------------------------------------------------ */}
      <Band tone="white" size="sm" bordered>
        <nav aria-label="Jump to a tier">
          <ul className="grid gap-3 sm:grid-cols-3">
            {TIERS.map((tier) => (
              <li key={tier.tier} className="flex">
                <a
                  href={`#${tier.tier.toLowerCase()}`}
                  className="gv-card gv-card-interactive group flex w-full items-center gap-3 p-4 no-underline"
                >
                  <AgentTierMark tier={tier.tier} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] leading-snug font-medium text-ink transition-colors duration-150 ease-gv group-hover:text-brand">
                      {tier.label}
                    </span>
                    <span className="gv-micro mt-0.5 block" data-numeric="">
                      {TIER_COUNTS[tier.tier]} agents
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </Band>

      {exhibit ? (
        <Band tone="soft" size="sm" id="how-to-read-an-agent">
          <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-12">
            <div className="min-w-0">
              <SectionHeading
                size="sm"
                eyebrow="How to read an agent"
                title="Every agent page carries this diagram"
                lede={
                  <>
                    Shown here for the {exhibit.name}. The stages are read from that
                    agent&apos;s own catalog entry rather than drawn for it, so the picture is
                    wrong only when the catalog is. Teal is a language model reasoning; navy
                    is deterministic code.
                  </>
                }
              />
              {/* The colour on the CARDS and the colour in the DIAGRAM are two
                  different systems, and a reader who assumes they are one will
                  misread both. Saying so once, here, is cheaper than a legend
                  under every card — and it is the honest description: inside
                  the diagram exactly two values appear and each is a claim,
                  while a card's colour is only ever a name. */}
              <p className="gv-micro mt-5 max-w-prose">
                Only two colours appear inside the diagram, and each one is a claim about how
                the work was done. The colour on the cards below is a different thing
                entirely: it is the agent&apos;s identity, the same one it wears in the studio
                canvas and in the run graph, and it rates nothing.
              </p>
            </div>
            <AgentPipeline agent={exhibit} compact />
          </div>
        </Band>
      ) : null}

      {/* ------------------------------------------------------------------
          The catalog itself. The grids alternate white and soft rather than
          taking a tinted ground: fourteen cards now carry fourteen hues of
          their own, and a brand wash behind them would put a fifteenth colour
          under every one of them.
         ------------------------------------------------------------------ */}
      {TIERS.map((tier, index) => {
        const agents = byTier(tier.tier);
        return (
          <Band
            key={tier.tier}
            id={tier.tier.toLowerCase()}
            tone={index % 2 === 0 ? "white" : "soft"}
            size="md"
            className="scroll-mt-16"
          >
            <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
              <SectionHeading
                eyebrow={`Tier ${tier.tier}`}
                title={tier.label}
                lede={tier.description}
              />
              <p className="flex items-center gap-3">
                <AgentTierMark tier={tier.tier} />
                <span className="font-mono text-[12px] text-ink-3" data-numeric="">
                  {agents.length} agents
                </span>
              </p>
            </div>
            <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((agent) => (
                <li key={agent.id} className="flex">
                  <AgentCard agent={agent} />
                </li>
              ))}
            </ul>
          </Band>
        );
      })}

      {/* ------------------------------------------------------------------
          How to read a tier — and, in the same block, the colour key.
          The two belong together: a tier says when an agent was built, a hue
          says which agent it is, and putting them in one place is the shortest
          way to say that neither one is a ranking of the other.
         ------------------------------------------------------------------ */}
      <Band tone="tint" size="md" id="how-to-read-a-tier">
        <SectionHeading
          eyebrow="How to read a tier"
          title="Tiers are build order, not importance"
          lede="P0 is what an application cannot move without. P1 is the portfolio and the voice channel. P2 is the intelligence layer over both, including the platform's model of its own cost. Colour is not part of that ranking: each agent keeps one hue everywhere it appears, and it means only which agent this is."
        />
        <Cells as="ul" columns={3} raised className="mt-9">
          {TIERS.map((tier) => (
            <li key={tier.tier} className="p-5">
              <AgentTierMark tier={tier.tier} />
              <p className="mt-3 text-[14px] leading-snug text-ink">{tier.label}</p>
              <p className="gv-micro mt-1.5" data-numeric="">
                {TIER_COUNTS[tier.tier]} agents
              </p>
              <ul className="mt-4 border-t border-line pt-2">
                {byTier(tier.tier).map((agent) => (
                  <LegendEntry key={agent.id} agent={agent} />
                ))}
              </ul>
            </li>
          ))}
        </Cells>
        <p className="gv-micro mt-4">
          The hue beside each name is generated from the engine&apos;s node registry, not
          chosen here, which is why the same agent is the same colour on its own page, on the
          studio canvas and in a run graph.
        </p>
      </Band>
    </>
  );
}
