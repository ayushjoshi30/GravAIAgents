import Link from "next/link";
import type { Agent } from "@/lib/agents";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { AgentGlyph } from "@/components/site/AgentGlyph";
import { AgentTierMark, tierPlane } from "@/components/site/AgentTierMark";
import { Badge, Chip } from "@/components/ui/Badge";
import { ArrowCorner } from "@/components/ui/Button";
import { hueStyle } from "@/components/build/blocks";
import { NODE_BY_TYPE } from "@/lib/nodeCatalog";

/**
 * A catalog card for one agent.
 *
 * Six things, in one order, every time: the agent's icon in its own hue's
 * plate, the tier marker, the name, one sentence, its own motif, the
 * capabilities it actually has, and the MCP tool name as the action in the
 * footer. The whole surface is the link, so it lifts, its border goes to the
 * agent's accent, its plate fills and its arrow travels — all from
 * `.gv-card-interactive`, which mirrors hover on focus-within so a keyboard
 * reaches the same state.
 *
 * Nothing here invents catalog data: the name, summary, tier, tool name and
 * acting/advisory state all come from `src/lib/agents.ts`, the hue comes from
 * the generated node catalog, and the capability chips are a short reading of
 * that same entry's own contract.
 */

/**
 * The agent's hue, from the generated node catalog.
 *
 * WHY IT IS LOOKED UP RATHER THAN CHOSEN. `lib/nodeCatalog.ts` is generated
 * from the engine's own registry and a test fails if the two disagree, so the
 * hue a card wears is the same one the studio canvas draws that agent's node
 * in and the same one the agent's own page carries. Picking a colour here
 * instead would be a second, unguarded answer to a question that already has
 * one, and the catalog page and the canvas would drift apart the first time an
 * agent was added.
 *
 * The fallback is the palette's neutral rather than a colour derived from the
 * id. An agent this build's catalog has never heard of should read as
 * uncoloured; hashing it into a hue would file it in a family the engine never
 * put it in, which is exactly the kind of quiet fiction this product exists to
 * avoid.
 */
function hueOf(agent: Agent): string {
  return NODE_BY_TYPE[`agent.${agent.id}`]?.hue ?? "slate";
}

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
    /* The hue reaches everything below through four custom properties set once
       here, because Tailwind builds its stylesheet by reading the source for
       complete class names: `bg-${hue}-soft` is assembled in the browser long
       after that stylesheet was written and produces no style at all, silently.
       So the class names are constant — `bg-[var(--plate)]` and its three
       siblings — and only the values vary. `hueStyle` is imported rather than
       reimplemented so the marketing card and the studio node resolve a hue the
       same way. */
    <Link
      href={`/agents/${agent.id}`}
      style={hueStyle(hueOf(agent))}
      className={`gv-card gv-card-interactive group flex h-full min-w-0 flex-col overflow-hidden border-[var(--plate-border)] no-underline hover:border-[var(--plate-accent)] focus-within:border-[var(--plate-accent)] ${tierPlane(agent.tier)}`}
    >
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <span className="gv-icon-plate border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)] transition-colors duration-200 ease-gv group-hover:border-[var(--plate-accent)] group-hover:bg-[var(--plate-accent)] group-hover:text-white group-focus-within:border-[var(--plate-accent)] group-focus-within:bg-[var(--plate-accent)] group-focus-within:text-white">
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

        {/* The hovered title takes the `-strong` step rather than the base one.
            The base value is tuned to be read on white; at 15px on a lifted
            card it is the weaker of the two, and `-strong` is the step the
            palette provides for exactly this. */}
        <h3 className="mt-4 text-[15px] leading-snug font-medium text-ink transition-colors duration-150 ease-gv group-hover:text-[var(--plate-strong)] group-focus-within:text-[var(--plate-strong)]">
          {agent.name}
        </h3>

        {!compact ? (
          <p className="mt-2 line-clamp-3 text-[13.5px] leading-relaxed text-ink-2">
            {shortSummary(agent.summary)}
          </p>
        ) : null}

        {!compact ? (
          /* The motif's frame moves onto the agent's own plate so the drawing
             is not a coloured line on somebody else's tint. The glyph itself
             rests at 70% and comes to full strength on hover and focus; that
             is an opacity change rather than a second colour, so the motif
             never competes with the icon plate for the eye. The reduced-motion
             rule in globals.css already flattens the transition. */
          <div className="gv-figure mt-4 flex h-[54px] items-center justify-center border-[var(--plate-border)] bg-[var(--plate)] px-3">
            <AgentGlyph
              id={agent.id}
              className="h-10 w-full text-[var(--plate-accent)] opacity-70 transition-opacity duration-200 ease-gv group-hover:opacity-100 group-focus-within:opacity-100"
            />
          </div>
        ) : null}

        {/* The chips stay neutral on purpose. Three tinted chips under a tinted
            plate, a tinted frame and a tinted footer would leave the card with
            no quiet part, and the capability names are the densest text on it. */}
        <ul className="mt-auto flex flex-wrap gap-1.5 border-t border-[var(--plate-border)] pt-4">
          {capabilities.map((capability) => (
            <li key={capability}>
              <Chip>{capability}</Chip>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-[var(--plate-border)] bg-[var(--plate)] px-5 py-3">
        <span className="flex min-w-0 items-center gap-2">
          <Icon name="terminal" size={13} className="shrink-0 text-[var(--plate-accent)]" />
          {/* Text sitting on a soft plate takes `-strong`; the base step on its
              own soft step is the palette's documented contrast failure, and at
              11.5px monospace it is the worst place to ship it. */}
          <span className="truncate font-mono text-[11.5px] text-[var(--plate-strong)]">
            {agent.toolName}
          </span>
        </span>
        {/* The important modifier is load-bearing here. `.gv-card-interactive:hover
            .gv-card-arrow` in globals.css is a three-class descendant selector, so
            it outranks the two-class selector a `group-hover:` utility compiles
            to, and without this the arrow would go brand on a card of some other
            hue. */}
        <ArrowCorner className="gv-card-arrow shrink-0 group-hover:text-[var(--plate-accent)]! group-focus-within:text-[var(--plate-accent)]!" />
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
