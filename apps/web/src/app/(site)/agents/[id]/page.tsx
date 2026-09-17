import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentPipeline } from "@/components/agents/AgentPipeline";
import { hueStyle } from "@/components/build/blocks";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { AgentGlyph } from "@/components/site/AgentGlyph";
import { AiCapabilityList } from "@/components/site/AiCapabilityCard";
import { Band, Container, PageHeader } from "@/components/site/Page";
import { UseCaseFlow, UseCaseProof } from "@/components/site/UseCaseFlow";
import { Badge, Tag, TierBadge } from "@/components/ui/Badge";
import { Arrow, ButtonLink } from "@/components/ui/Button";
import { Figure, SectionHeading } from "@/components/ui/Surface";
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
 * One column of the contract block: a list with a rule down its left edge, a
 * sentence saying what the list is, and a count.
 *
 * THE COUNT IS THERE BECAUSE A LIST OF SIX LOOKS LIKE A LIST OF SIX. A reader
 * deciding whether an agent can reach their systems wants to know that its
 * entire tool allowlist is four entries long, and a bare list makes them count.
 * It is the catalog's own `length`, so it cannot disagree with the list beside
 * it.
 *
 * `accent` says whether that rule takes the agent's own hue or stays neutral.
 * Only one of the three takes it — the tools the agent may call — because a
 * block where every rule is the same colour is a block where the colour has
 * stopped pointing at anything. Inputs are what the agent is handed and output
 * keys are what it returns; both are the contract's plumbing, and they read
 * better quiet.
 */
function ContractColumn({
  heading,
  hint,
  items,
  accent = false,
  mono = false,
}: {
  heading: string;
  hint: string;
  items: string[];
  accent?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <p className={`gv-eyebrow ${accent ? "text-[var(--plate-strong)]" : ""}`}>{heading}</p>
        <span className="font-mono text-[11px] text-ink-3" data-numeric="">
          {String(items.length).padStart(2, "0")}
        </span>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-ink-3">{hint}</p>
      <ul className="mt-4 space-y-2.5">
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
 * One figure in the guardrails strip.
 *
 * Every value is a `length` off the catalog or a boolean already on the agent,
 * so there is nothing here to keep in step with anything: if an agent gains a
 * rule, the number moves because the rule moved.
 *
 * NO COLOUR ON THESE. They are a count of rules, and this is the one grid on
 * the page where three of the fourteen agents' generated hues — green, amber
 * and rose — would read as a verdict on the thing they are sitting beside.
 */
function GuardFigure({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col-reverse gap-1.5 px-5 py-5">
      <dt className="text-[12px] leading-snug text-ink-3">{label}</dt>
      <dd className="gv-metric-sm text-brand" data-numeric="">
        {value}
      </dd>
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
   * Deliberately NOT set on a wrapper around the whole page. The explainer
   * below is the one thing here whose colour is a CLAIM — teal is a language
   * model reasoning, navy is deterministic code — and a page-level custom
   * property is a standing invitation for that diagram to inherit a decorative
   * hue one refactor from now. Setting it per subtree costs a few repeated
   * `style` attributes and makes the omission around the diagram visible in the
   * markup instead of implicit in a cascade.
   *
   * WHERE IT IS ALLOWED TO LAND, in one sentence: the hue may mark what NAMES
   * this agent or states its declared contract, and it may not mark a run, a
   * rule, a gate or an outcome.
   *
   * Three of the fourteen are the reason the second half of that sentence
   * exists. Risk scoring's generated hue is amber, MSME underwriting's is green
   * and collections allocation's is rose — the three the palette reserves for
   * outcome. Beside the agent's own name, or on the panel carrying its input
   * and output contract, that colour is plainly its identity and can be read no
   * other way. Spread across a grid of guardrail numbers or a panel of eval
   * gates, the same green stops being a name and starts looking like a verdict
   * on whatever it is decorating, which is the failure that would cost every
   * other green on the site its meaning.
   *
   * So the hue is spent here on six things, all of them naming or contract:
   * the mark beside the agent's name, the header of its own contract panel, its
   * motif, the jump list that names this page's own sections, the contract
   * block with its one hued rule, and the two neighbour cards — which wear
   * their own hue rather than this page's, and are the clearest demonstration
   * on the site that a hue belongs to an agent and not to a page. The
   * guardrail, escalation and worked-example sections get their weight from
   * framing and type instead, which costs nothing and claims nothing.
   *
   * The explainer is not on that list and does not need to be: `AgentPipeline`
   * resolves the same hue from the same generated catalog and wears it on its
   * own frame, so that band reads as this agent's without this file painting
   * anything around it.
   */
  const plate = hueStyle(agentHue(agent.id));

  /**
   * The jump list under the header.
   *
   * Assembled rather than written out because the worked example is the one
   * section that may genuinely be absent — `getUseCase` returns nothing for an
   * agent with no transcribed run — and a jump list with a link to a section
   * that was never rendered is a link that silently does nothing.
   */
  const sections = [
    { href: "#how-it-works", label: "How it works" },
    { href: "#contract", label: "Contract" },
    ...(useCase ? [{ href: "#worked-example", label: "Worked example" }] : []),
    { href: "#guardrails", label: "Guardrails" },
    { href: "#capabilities", label: "What it spends" },
  ];

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
        /* The tier, the authority and the catalog's own tags, moved up out of
           the band below. They were sitting above the explainer, which made the
           reader step over four chips to reach the clearest statement of what
           this agent does; here they are metadata beside the title, which is
           what they are. */
        actions={
          <>
            <TierBadge tier={agent.tier} />
            {agent.advisoryOnly ? (
              <Badge tone="brand">advisory only</Badge>
            ) : (
              <Badge tone="amber" dot>
                acts
              </Badge>
            )}
            {agent.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </>
        }
        aside={
          <div
            style={plate}
            className="gv-panel overflow-hidden border-[var(--plate-border)]"
          >
            <header className="gv-toolbar bg-[var(--plate)] [border-bottom-color:var(--plate-border)]">
              <h2 className="text-[13px] font-semibold text-[var(--plate-strong)]">
                Contract at a glance
              </h2>
              <TierBadge tier={agent.tier} />
            </header>

            {/* The agent's own motif, in its own colour.

                The icon says what the agent IS and this says what it DOES — a
                document scan, a consented pipe, a risk gauge. It is the one
                drawing on the page that is per-agent rather than generated from
                a list, which is exactly why it belongs here, on the panel that
                names the agent, and nowhere near the explainer below. It is
                decorative and `aria-hidden` inside `AgentGlyph`; every fact it
                alludes to is printed in words further down. */}
            <div className="border-b border-[var(--plate-border)] bg-[var(--plate)] px-4 pb-4">
              <AgentGlyph
                id={agent.id}
                className="h-10 w-full text-[var(--plate-accent)] opacity-90"
              />
            </div>

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
          The jump list. This page is long by design — the guardrails and the
          escalation conditions are the argument, not an appendix — and a
          reader who arrived to check one thing should not have to scroll past
          the other four to find it.

          It takes the hue because it is chrome that names THIS page's own
          sections, and because a row of five links all wearing one colour
          reads as that page's colour rather than as five separate signals.
         ------------------------------------------------------------------ */}
      <div style={plate} className="gv-band-white border-b border-[var(--plate-border)]">
        <Container>
          <nav aria-label="On this page" className="gv-scroll-x flex items-center gap-1 py-2.5">
            {sections.map((section) => (
              <a
                key={section.href}
                href={section.href}
                className="rounded-md px-3 py-1.5 text-[12.5px] whitespace-nowrap text-ink-2 no-underline transition-colors duration-150 ease-gv hover:bg-[var(--plate)] hover:text-[var(--plate-strong)]"
              >
                {section.label}
              </a>
            ))}
          </nav>
        </Container>
      </div>

      {/* ------------------------------------------------------------------
          The explainer, leading the page, because it is the clearest single
          statement of what this agent does and it used to sit below four chips
          and a heading. The chips moved up into the header; this band now opens
          on the thing a reader came to understand.

          THE FRAME AROUND IT CARRIES NO COLOUR OF ITS OWN, and that is not an
          omission. `AgentPipeline` already takes the agent's hue for its own
          edge, header bar, icon plate and heading — it reads the same generated
          catalog this page does, so the two cannot disagree — and it stops that
          hue at the diagram's edge, because inside the drawing teal means a
          language model reasoned and navy means code reached a fixed answer. A
          second hued frame around a panel that is already hued would be two
          borders of one colour arguing about which of them is the frame, and on
          Document Intelligence, whose generated hue IS teal, it would also put
          a third teal edge beside a claim drawn in teal.

          So the frame here is the palette's neutral diagram plane: a tinted
          tray with a hairline, which is what `Figure` exists for and what its
          own note asks for around a drawing of this kind — frame it in the hue
          it already argues in, or leave it alone. Left alone, the only colour
          in this band is the agent's on the panel and the claim's inside it.
         ------------------------------------------------------------------ */}
      <Band tone="white" pattern="grid" id="how-it-works" className="scroll-mt-24">
        {/* The eyebrow deliberately does not read "How it works". The explainer
            panel prints that phrase in its own chrome a few lines below, and
            two identical labels that close together read as a rendering fault
            rather than as a heading and a caption. This says the same thing in
            the plainer words a reader would have used.

            The lede states the teal/navy claim in sentences rather than leaving
            it to the panel's two chips. The chips are a census that doubles as
            a legend — "2 model steps", "3 code steps" — which tells a reader
            what the colours count but not what they mean, and what they mean is
            the product. */}
        <SectionHeading
          eyebrow="What it actually does"
          title="One run, stage by stage"
          lede="Left to right: what the agent is handed, the stages the work moves through, and the fields it returns. Teal is a language model reasoning. Navy is deterministic code. That split is the whole platform — an arithmetic result is computed, and only the sentence around it is written."
        />

        <Figure
          className="mt-8"
          /* Wrapped rather than passed as a bare string so the measure can be
             capped. `Figure` gives its caption no width of its own, and this
             band is 1240px across — three sentences set to that width is a line
             a reader loses their place in twice. */
          caption={
            <span className="block max-w-3xl">
              Nothing in the diagram is drawn per agent. Every stage is read from this
              agent&apos;s own catalog entry — its declared inputs, its tool allowlist, the AI
              capabilities it consumes and the top-level keys of its output contract — the same
              entry the REST API and the MCP tool list read. It can only go stale when the catalog
              does.
            </span>
          }
        >
          <AgentPipeline agent={agent} specLink={false} />
        </Figure>
      </Band>

      {/* ------------------------------------------------------------------
          The contract: the three lists the diagram above was drawn from, as
          one hairline instrument rather than three columns of loose prose.
         ------------------------------------------------------------------ */}
      <Band tone="soft" id="contract" className="scroll-mt-24">
        <div style={plate}>
          <SectionHeading
            size="sm"
            eyebrow="The contract"
            title="What goes in, what it may touch, what comes back"
            lede="These three lists are the diagram above in longhand. Nothing here is a summary of the catalog entry; it is the entry."
          />
          <div className="gv-cells gv-cells-raised mt-8 lg:grid-cols-3">
            <ContractColumn
              heading="Inputs"
              hint="What the agent is handed when a run starts."
              items={agent.detail.inputs}
            />
            <ContractColumn
              heading="Tools it may call"
              hint="Its entire reach. Anything not on this list is not reachable."
              items={agent.detail.tools}
              accent
            />
            <ContractColumn
              heading="Output contract"
              hint="The top-level keys of what it returns."
              items={agent.detail.outputKeys}
              mono
            />
          </div>
        </div>
      </Band>

      {/* ------------------------------------------------------------------
          The worked example. Every figure in this band was produced by
          running the agent, which makes it the only section on the page that
          is evidence rather than declaration — so it gets a band of its own,
          a full-width head, and the provenance printed under the figures
          instead of a line of marketing copy.

          NO AGENT HUE ANYWHERE INSIDE IT. The panel is already spending
          green, amber and rose on what actually happened, and a decorative
          fourth colour standing next to a genuine one is how a reader stops
          believing either.
         ------------------------------------------------------------------ */}
      {useCase ? (
        <Band tone="white" id="worked-example" className="scroll-mt-24">
          <SectionHeading
            eyebrow="Worked example"
            title="One recorded run, start to finish"
            lede={useCase.scenario}
          />
          <div className="mt-10 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
            <div className="min-w-0">
              <UseCaseProof useCase={useCase} />
            </div>
            <UseCaseFlow useCase={useCase} />
          </div>
        </Band>
      ) : null}

      {/* ------------------------------------------------------------------
          Guardrails and escalation, as one section, because they are one
          argument: here is what this agent will not do, and here is the point
          at which it stops and asks a person. Split across two bands they read
          as two pieces of small print near the end of a page; together, with
          the counts stated up front, they read as the reason to buy it.

          THE PLATES STAY BRAND, and the reason is the whole argument about how
          far an agent's hue may travel from its name. Three of the fourteen own
          a hue the palette reserves for outcome — risk scoring is amber, MSME
          underwriting is green, collections allocation is rose. Beside the
          agent's own name that colour is its identity and reads as nothing
          else. Repeated down a grid of numbered rules headed "what this agent
          is not allowed to do" it stops being a name and starts looking like a
          verdict on each rule, and a green square against a guardrail is
          exactly the confusion that makes every green thing on the site
          unreadable.

          THE AMBER BELOW IS NOT DECORATION EITHER: the palette reserves amber
          for a rule that can stop or divert a run, and an escalation is exactly
          that, so that panel keeps amber whatever hue the agent carries.
         ------------------------------------------------------------------ */}
      <Band tone="tint" id="guardrails" className="scroll-mt-24">
        <SectionHeading
          eyebrow="Guardrails and escalation"
          title="What it will not do, and when it stops"
          lede="In lending this is the part that decides whether an agent can be deployed at all, so it is not printed as fine print. Every rule below is written into the prompt and checked by an output validator — a rule that only exists in a prompt is a suggestion."
        />

        {/* The size of the argument, before any of it is read. Each figure is
            a `length` off the catalog entry or a flag already on the agent, so
            none of them can drift from the lists further down this band. */}
        <dl className="gv-cells gv-cells-raised mt-8 sm:grid-cols-2 lg:grid-cols-4">
          <GuardFigure
            value={String(agent.detail.rules.length)}
            label="hard rules, each with a validator behind it"
          />
          <GuardFigure
            value={String(agent.detail.escalateWhen.length)}
            label="conditions that hand the decision to a person"
          />
          <GuardFigure
            value={String(agent.detail.evals.length)}
            label="eval gates before a prompt version is promoted"
          />
          <GuardFigure
            value={agent.advisoryOnly ? "Advisory" : "Acts"}
            label={
              agent.advisoryOnly
                ? "never takes an irreversible action on its own"
                : "places calls; every guardrail enforced in code"
            }
          />
        </dl>

        <h3 className="gv-subheading mt-14">What this agent is not allowed to do</h3>
        <ol className="gv-cells gv-cells-raised mt-5 sm:grid-cols-2">
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

        <div className="mt-14 grid gap-6 lg:grid-cols-2 lg:gap-8" id="escalation">
          <div className="min-w-0 overflow-hidden rounded-[14px] border border-amber-border bg-surface shadow-raised">
            <header className="flex items-center gap-2.5 border-b border-amber-border bg-amber-soft px-5 py-3">
              <span className="shrink-0 text-amber" aria-hidden="true">
                <Icon name="warning" size={15} />
              </span>
              <h3 className="min-w-0 text-[14px] font-semibold text-amber-strong">
                Escalates to a person when
              </h3>
              <span
                className="ml-auto shrink-0 font-mono text-[11.5px] text-amber-strong"
                data-numeric=""
              >
                {String(agent.detail.escalateWhen.length).padStart(2, "0")}
              </span>
            </header>
            <ul className="gv-divide px-5">
              {agent.detail.escalateWhen.map((item) => (
                <li key={item} className="py-3 text-[13.5px] leading-relaxed text-ink-2">
                  {item}
                </li>
              ))}
            </ul>
            <p className="border-t border-amber-border bg-amber-soft px-5 py-3 text-[12px] leading-relaxed text-amber-strong">
              An escalation is the agent handing a decision to a person. It is the designed outcome,
              not a failed run.
            </p>
          </div>

          {/* The eval panel is the one place the agent's hue was actively
              dangerous, and it is also where a tick is. It ends on the sentence
              "all gates must be green" — and on the MSME underwriting agent,
              whose generated hue IS green, a green mark above that sentence
              asserts the gates have passed. They have not; the panel only lists
              what must pass. The mark is a shield rather than a tick for the
              same reason, one step milder: a tick over a list of gates is a
              small claim that they cleared. */}
          <div className="min-w-0 overflow-hidden rounded-[14px] border border-line bg-surface shadow-raised">
            <header className="flex items-center gap-2.5 border-b border-line bg-surface-2 px-5 py-3">
              <span className="shrink-0 text-brand" aria-hidden="true">
                <Icon name="shield" size={15} />
              </span>
              <h3 className="min-w-0 text-[14px] font-semibold text-ink">
                Eval gates before a prompt version is promoted
              </h3>
              <span className="ml-auto shrink-0 font-mono text-[11.5px] text-ink-3" data-numeric="">
                {String(agent.detail.evals.length).padStart(2, "0")}
              </span>
            </header>
            <ul className="gv-divide px-5">
              {agent.detail.evals.map((item) => (
                <li key={item} className="py-3 text-[13.5px] leading-relaxed text-ink-2">
                  {item}
                </li>
              ))}
            </ul>
            <p className="border-t border-line bg-surface-2 px-5 py-3 text-[12px] leading-relaxed text-ink-3">
              All gates must be green before a candidate version can be promoted, and the promotion
              itself is an approved, audited change.
            </p>
          </div>
        </div>
      </Band>

      <Band tone="soft" id="capabilities" className="scroll-mt-24">
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
