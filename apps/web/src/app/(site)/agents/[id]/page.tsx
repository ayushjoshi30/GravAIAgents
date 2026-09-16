import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentPipeline } from "@/components/agents/AgentPipeline";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { AiCapabilityList } from "@/components/site/AiCapabilityCard";
import { Container, PageHeader, Section } from "@/components/site/Page";
import { UseCaseFlow, UseCaseProof } from "@/components/site/UseCaseFlow";
import { Badge, Tag, TierBadge } from "@/components/ui/Badge";
import { Arrow, ButtonLink } from "@/components/ui/Button";
import { SectionHeading } from "@/components/ui/Surface";
import { AGENTS, getAgent } from "@/lib/agents";
import { getUseCase } from "@/lib/agent-usecase";

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

function ListBlock({
  heading,
  items,
  tone = "neutral",
  mono = false,
}: {
  heading: string;
  items: string[];
  tone?: "neutral" | "brand" | "amber";
  mono?: boolean;
}) {
  const border = {
    neutral: "border-line-strong",
    brand: "border-brand",
    amber: "border-amber",
  }[tone];
  return (
    <div>
      <p className="gv-eyebrow mb-3">{heading}</p>
      <ul className="space-y-2.5">
        {items.map((item) => (
          <li
            key={item}
            className={`border-l-2 pl-3 text-[13.5px] leading-relaxed text-ink-2 ${border} ${
              mono ? "font-mono text-[12px] break-words" : ""
            }`}
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
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

  return (
    <>
      <PageHeader
        eyebrow={`Agent · tier ${agent.tier}`}
        title={
          <span className="flex flex-wrap items-center gap-4">
            <span className="text-brand">
              <AgentIcon id={agent.id} size={40} />
            </span>
            {agent.name}
          </span>
        }
        lede={agent.detail.purpose}
        aside={
          <dl className="border border-line bg-ground">
            <div className="border-b border-line p-4">
              <dt className="gv-eyebrow">MCP tool</dt>
              <dd className="mt-1.5 font-mono text-[14px] text-brand break-all">
                {agent.toolName}
              </dd>
            </div>
            <div className="border-b border-line p-4">
              <dt className="gv-eyebrow">Scopes required</dt>
              <dd className="mt-2 flex flex-wrap gap-1.5">
                {agent.scopes.map((scope) => (
                  <Tag key={scope}>{scope}</Tag>
                ))}
              </dd>
            </div>
            <div className="border-b border-line p-4">
              <dt className="gv-eyebrow">Authority</dt>
              <dd className="mt-2 flex items-center gap-2 text-[13px] text-ink-2">
                {agent.advisoryOnly ? (
                  <>
                    <Badge tone="brand">advisory only</Badge>
                    Never takes an irreversible action on its own.
                  </>
                ) : (
                  <>
                    <Badge tone="amber">acts</Badge>
                    Places calls. Guardrails are enforced in code.
                  </>
                )}
              </dd>
            </div>
            <div className="p-4">
              <dt className="gv-eyebrow">Capability parity</dt>
              <dd className="mt-1.5 text-[13px] text-ink-2">
                {agent.parityWith ?? "No direct market equivalent named."}
              </dd>
            </div>
          </dl>
        }
      />

      <Container>
        <Section bordered={false}>
          <div className="flex flex-wrap items-center gap-2">
            <TierBadge tier={agent.tier} />
            {agent.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </div>

          {/* The explainer goes ABOVE the three lists rather than after them.
              Inputs, tools and output keys are the same facts, but they are
              three columns of vocabulary: they answer "what does this agent do"
              only for someone who already knows how to read them. The diagram
              answers it for everyone else in one glance, and it is drawn from
              exactly those three lists, so a reader who then works down the page
              is checking the picture against its own source rather than
              against a second, hand-written description of the system. */}
          <div id="how-it-works" className="mt-10">
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

          <div className="mt-12 grid gap-10 lg:grid-cols-2 lg:gap-12">
            <ListBlock heading="Inputs" items={agent.detail.inputs} />
            <ListBlock heading="Tools it may call" items={agent.detail.tools} tone="brand" />
          </div>

          <div className="mt-10">
            <ListBlock
              heading="Output contract — top-level keys"
              items={agent.detail.outputKeys}
              mono
            />
          </div>
        </Section>
      </Container>

      {useCase ? (
        <Container>
          <Section id="worked-example">
            <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
              <div>
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
          </Section>
        </Container>
      ) : null}

      <Container>
        <Section id="guardrails">
          <SectionHeading
            eyebrow="Guardrails"
            title="What this agent is not allowed to do"
            lede="Written into the prompt and enforced by output validators. A rule that only exists in a prompt is a suggestion; every rule below has a check behind it."
          />
          <ol className="mt-8 border-t border-line">
            {agent.detail.rules.map((rule, ruleIndex) => (
              <li
                key={rule}
                className="grid gap-x-6 gap-y-1 border-b border-line py-4 sm:grid-cols-[3rem_1fr]"
              >
                <span className="font-mono text-[12px] text-ink-3" data-numeric="">
                  {String(ruleIndex + 1).padStart(2, "0")}
                </span>
                <p className="text-[13.5px] leading-relaxed text-ink-2">{rule}</p>
              </li>
            ))}
          </ol>
        </Section>
      </Container>

      <Container>
        <Section id="escalation">
          <div className="grid gap-10 lg:grid-cols-2 lg:gap-12">
            <div className="rounded-lg border border-amber-border bg-amber-soft p-5">
              <p className="gv-eyebrow mb-3 flex items-center gap-2">
                <span className="text-amber">
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
            </div>

            <div className="gv-card p-5">
              <p className="gv-eyebrow mb-3 flex items-center gap-2">
                <span className="text-brand">
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
        </Section>
      </Container>

      <Container>
        <Section id="ai-capabilities">
          <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:gap-12">
            <SectionHeading
              eyebrow="AI capabilities consumed"
              title="What this agent spends"
              lede="Every call this agent makes is written to the cost ledger with its tokens, pages, audio seconds and rupee cost against a versioned rate card."
            />
            <AiCapabilityList capabilities={agent.detail.aiServices} />
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/console/runs">
              See runs of this agent
              <Arrow />
            </ButtonLink>
            <ButtonLink href="/docs/agent-reference">Full agent reference</ButtonLink>
          </div>
        </Section>
      </Container>

      <Container>
        <Section>
          <nav
            aria-label="Other agents"
            className="grid gap-3 sm:grid-cols-2"
          >
            <Link href={`/agents/${previous.id}`} className="bg-surface p-5 hover:bg-surface-2">
              <p className="gv-eyebrow">Previous agent</p>
              <p className="mt-2 text-[15px] font-semibold text-ink">{previous.name}</p>
            </Link>
            <Link
              href={`/agents/${next.id}`}
              className="bg-surface p-5 text-right hover:bg-surface-2"
            >
              <p className="gv-eyebrow">Next agent</p>
              <p className="mt-2 text-[15px] font-semibold text-ink">{next.name}</p>
            </Link>
          </nav>
        </Section>
      </Container>
    </>
  );
}
