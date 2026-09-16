import type { Metadata } from "next";
import { AgentPipeline } from "@/components/agents/AgentPipeline";
import { AgentCard } from "@/components/site/AgentCard";
import { AgentTierMark } from "@/components/site/AgentTierMark";
import { Band, PageHeader } from "@/components/site/Page";
import { Cells, SectionHeading } from "@/components/ui/Surface";
import { AGENTS, TIERS, TIER_COUNTS, getAgent, type AgentTier } from "@/lib/agents";

export const metadata: Metadata = {
  title: "Agents",
  description:
    "All fourteen GravAI agents: document intelligence, bank statement analytics, credit appraisal, risk scoring, account aggregator data, KYC, collections allocation, mandates, voice, speech analytics, onboarding, MSME underwriting, segmentation and ops research.",
};

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

      {exhibit ? (
        <Band tone="soft" size="sm" id="how-to-read-an-agent">
          <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-12">
            <SectionHeading
              size="sm"
              eyebrow="How to read an agent"
              title="Every agent page carries this diagram"
              lede={
                <>
                  Shown here for the {exhibit.name}. The stages are read from that agent&apos;s
                  own catalog entry rather than drawn for it, so the picture is wrong only when
                  the catalog is. Teal is a language model reasoning; navy is deterministic
                  code.
                </>
              }
            />
            <AgentPipeline agent={exhibit} compact />
          </div>
        </Band>
      ) : null}

      {TIERS.map((tier, index) => {
        const agents = AGENTS.filter((agent) => agent.tier === (tier.tier as AgentTier));
        return (
          <Band
            key={tier.tier}
            id={tier.tier.toLowerCase()}
            tone={index === 1 ? "soft" : "white"}
            size="md"
          >
            <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
              <SectionHeading
                eyebrow={`Tier ${tier.tier}`}
                title={tier.label}
                lede={tier.description}
              />
              <p className="font-mono text-[12px] text-ink-3" data-numeric="">
                {agents.length} agents
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

      <Band tone="tint" size="md">
        <SectionHeading
          eyebrow="How to read a tier"
          title="Tiers are build order, not importance"
          lede="P0 is what an application cannot move without. P1 is the portfolio and the voice channel. P2 is the intelligence layer over both, including the platform's model of its own cost."
        />
        <Cells as="ul" columns={3} className="mt-8">
          {TIERS.map((tier) => (
            <li key={tier.tier} className="p-5">
              <AgentTierMark tier={tier.tier} />
              <p className="mt-3 text-[14px] leading-snug text-ink">{tier.label}</p>
              <p className="gv-micro mt-1.5" data-numeric="">
                {TIER_COUNTS[tier.tier]} agents
              </p>
            </li>
          ))}
        </Cells>
      </Band>
    </>
  );
}
