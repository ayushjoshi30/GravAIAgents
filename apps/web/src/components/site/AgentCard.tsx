import Link from "next/link";
import type { Agent } from "@/lib/agents";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { AgentGlyph } from "@/components/site/AgentGlyph";
import { AgentTierMark, tierPlane } from "@/components/site/AgentTierMark";
import { Badge, Chip } from "@/components/ui/Badge";
import { ArrowCorner } from "@/components/ui/Button";

/**
 * A catalog card for one agent.
 *
 * Six things, in one order, every time: the agent's icon in a brand plate, the
 * tier marker, the name, one sentence, its own motif, the capabilities it
 * actually has, and the MCP tool name as the action in the footer. The whole
 * surface is the link, so it lifts, its border goes brand, its plate fills and
 * its arrow travels — all from `.gv-card-interactive`, which mirrors hover on
 * focus-within so a keyboard reaches the same state.
 *
 * Nothing here invents catalog data: the name, summary, tier, tool name and
 * acting/advisory state all come from `src/lib/agents.ts`, and the capability
 * chips are a short reading of that same entry's own contract.
 */

/**
 * Two or three capabilities per agent, named by what they do. Each line is a
 * compression of that agent's own `detail` — its output keys, its rules — not
 * a claim added on top of them, and never the name of a vendor.
 */
const CAPABILITIES: Record<string, string[]> = {
  doc_intelligence: ["Classification", "Field extraction", "Page citations"],
  bank_statement_analytics: ["Income detection", "EMI obligations", "Reconciliation"],
  credit_appraisal: ["FOIR and LTV", "Rule explanation", "Deviation matrix"],
  risk_scoring: ["Versioned scorecard", "DPD bands", "Driver attribution"],
  aa_data: ["Consent artefact", "Structured fetch", "Purpose limits"],
  kyc_verification: ["Name matching", "Issued documents", "Aadhaar masked"],
  case_allocation: ["Priority ranking", "Next best action", "Calling windows"],
  smart_mandate: ["Presentment dates", "Mandate caps", "Pre-debit notice"],
  voice_collections: ["Multilingual voice", "Promise to pay", "Human handoff"],
  speech_analytics: ["Call scoring", "Verbatim quotes", "Violation alerts"],
  onboarding_assistant: ["Chat and voice", "Pendency chasing", "Status answers"],
  msme_underwriting: ["GST and ITR", "Turnover match", "Concentration risk"],
  customer_data_intelligence: ["Explainable rules", "Propensity", "Consent scoped"],
  ops_research: ["Cost ledger", "Throughput model", "Traceable queries"],
};

/** Capability names, shortened. The catalog already names them by function. */
const SERVICE_SHORT: [RegExp, string][] = [
  [/^document intelligence/i, "Document intelligence"],
  [/^language model/i, "Language model"],
  [/^speech to text/i, "Speech"],
  [/^text to speech/i, "Speech"],
  [/^translation/i, "Translation"],
];

/**
 * The fallback for an agent the map above does not cover: read the entry's own
 * capability list and tags rather than showing nothing.
 */
function capabilitiesFor(agent: Agent): string[] {
  const listed = CAPABILITIES[agent.id];
  if (listed) return listed;

  const services = agent.detail.aiServices.map((service) => {
    const match = SERVICE_SHORT.find(([pattern]) => pattern.test(service));
    return match ? match[1] : service.split("(")[0].trim();
  });
  const tags = agent.tags.map((tag) => tag.replace(/_/g, " "));
  return Array.from(new Set([...services, ...tags])).slice(0, 3);
}

/**
 * The first sentence of the catalog summary. A card wants one claim; the
 * detail page carries the rest of the paragraph verbatim.
 */
function shortSummary(summary: string): string {
  const first = summary.match(/^[\s\S]*?[.!?](?=\s+[A-Z])/);
  return first && first[0].length >= 60 ? first[0] : summary;
}

export function AgentCard({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  const capabilities = capabilitiesFor(agent).slice(0, compact ? 2 : 3);

  return (
    <Link
      href={`/agents/${agent.id}`}
      className={`gv-card gv-card-interactive group flex h-full min-w-0 flex-col overflow-hidden no-underline ${tierPlane(agent.tier)}`}
    >
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <span className="gv-icon-plate transition-colors duration-200 ease-gv group-hover:border-brand group-hover:bg-brand group-hover:text-white group-focus-within:border-brand group-focus-within:bg-brand group-focus-within:text-white">
            <AgentIcon id={agent.id} size={20} />
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {!agent.advisoryOnly ? (
              <Badge tone="amber" dot>
                Acts
              </Badge>
            ) : null}
            <AgentTierMark tier={agent.tier} />
          </span>
        </div>

        <h3 className="mt-4 text-[15px] leading-snug font-medium text-ink transition-colors duration-150 ease-gv group-hover:text-brand">
          {agent.name}
        </h3>

        {!compact ? (
          <p className="mt-2 line-clamp-3 text-[13.5px] leading-relaxed text-ink-2">
            {shortSummary(agent.summary)}
          </p>
        ) : null}

        {!compact ? (
          <div className="gv-figure mt-4 flex h-[54px] items-center justify-center px-3">
            <AgentGlyph
              id={agent.id}
              className="h-10 w-full text-brand-400 transition-colors duration-200 ease-gv group-hover:text-brand"
            />
          </div>
        ) : null}

        <ul className="mt-auto flex flex-wrap gap-1.5 border-t border-line pt-4">
          {capabilities.map((capability) => (
            <li key={capability}>
              <Chip>{capability}</Chip>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-2 px-5 py-3">
        <span className="flex min-w-0 items-center gap-2">
          <Icon
            name="terminal"
            size={13}
            className="shrink-0 text-ink-3 transition-colors duration-150 ease-gv group-hover:text-brand"
          />
          <span className="truncate font-mono text-[11.5px] text-ink-2 transition-colors duration-150 ease-gv group-hover:text-brand">
            {agent.toolName}
          </span>
        </span>
        <ArrowCorner className="gv-card-arrow shrink-0" />
      </div>
    </Link>
  );
}

export function AgentGrid({ agents }: { agents: Agent[] }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {agents.map((agent) => (
        <li key={agent.id} className="flex">
          <AgentCard agent={agent} />
        </li>
      ))}
    </ul>
  );
}
