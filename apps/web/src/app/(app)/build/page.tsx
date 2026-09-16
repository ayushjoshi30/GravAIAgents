import type { Metadata } from "next";
import Link from "next/link";
import { AgentBuilder } from "@/components/build/AgentBuilder";
import { BLOCKS, FAMILIES } from "@/components/build/blocks";
import { Band } from "@/components/site/Page";
import { ButtonLink } from "@/components/ui/Button";
import { Card, SectionHeading } from "@/components/ui/Surface";
import { AGENTS } from "@/lib/agents";

export const metadata: Metadata = {
  title: "Sketch an agent",
  description:
    "A public sketchpad for designing a GravAI agent: drag the real agents and node types onto a canvas, join them up, and see the shape of a workflow. It draws — running an agent happens in the console.",
};

/**
 * Counted, not claimed.
 *
 * Every figure on this page is `length` of something real — the agent catalog
 * and the workflow node registry this site transcribes. There is no "12,000
 * agents built" here and there will not be one: the only numbers a marketing
 * page is entitled to are the ones a reader could count for themselves.
 */
const AGENT_COUNT = AGENTS.length;
const BLOCK_COUNT = BLOCKS.length;
const FAMILY_COUNT = FAMILIES.length;

/** What is genuinely yours on this page, and what needs the console. Stated as
 *  a pair so neither column can be read without the other. */
const HERE = [
  "Add any step the platform has, from the same library the studio shows.",
  "Move steps, join them, branch them, and take connections out again.",
  "Name the agent, name each step, and describe the variables it is handed.",
  "Copy the whole sketch out as JSON, to rebuild in the studio or send to us.",
];

const NOT_HERE = [
  "Configuring a step. A sketch records that a step exists, never how it is set up.",
  "Running it. There is no engine behind this page and no token on a public site.",
  "Validating it. The studio checks a draft against the registry; this cannot.",
  "Saving it. The sketch lives in this browser tab and ends when you close it.",
];

export default function BuildPage() {
  return (
    <>
      {/* --- THE APPLICATION ---
          One whole viewport. This route lives in the `(app)` group, which has
          no site header, so the canvas really is the entire first screen rather
          than the screen less a marketing bar. `dvh` rather than `vh` because on a phone `vh` is the tallest
          the viewport ever gets, which means the bottom of the shell — the
          connections drawer — sits under the browser's own chrome until it
          scrolls away. `min-h` keeps it usable on a short laptop or a phone
          held sideways, where a strict viewport share would leave a canvas too
          shallow to see a node in; the page scrolls a little there instead,
          which is the lesser fault. */}
      <div className="h-[100dvh] min-h-[560px] border-b border-line">
        <AgentBuilder />
      </div>

      {/* --- WHAT THE PAGE USED TO SAY IN A HERO ---
          The prose below is good and none of it is cut. It is under the fold
          rather than in a panel inside the shell for two reasons. It is eight
          hundred words about what this page can and cannot do, and a disclosure
          holding eight hundred words is a disclosure nobody opens; and being
          real page content keeps it linkable, indexable and printable, which a
          collapsed panel is not. The app bar links straight down here, so it is
          one keystroke away rather than something a visitor has to guess is
          worth scrolling for.

          The lede that used to sit in the page header is the first thing in it,
          as a `SectionHeading` rather than a `PageHeader`: a page header under
          the page's own content would be an odd thing, and the `h1` now lives
          in the app bar where the application is. */}
      <Band tone="white" size="md" id="about-this-page" className="scroll-mt-16">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-16">
          <div className="min-w-0">
            <SectionHeading
              eyebrow="Make your own"
              size="lg"
              title="What this page does, and what it does not"
              lede={
                <>
                  This is a sketchpad. Put the steps GravAI actually has on a canvas, join them up,
                  and see the shape of an agent before anyone builds one.{" "}
                  <strong className="font-semibold text-ink">
                    It draws; it does not run. Nothing here is saved to an account, deployed or
                    checked against the engine
                  </strong>{" "}
                  — an agent runs for real in the console, against your data, with a token.
                </>
              }
              actions={
                <>
                  <ButtonLink href="/console/studio" variant="primary" size="lg">
                    Open the Agent Studio
                  </ButtonLink>
                  <ButtonLink href="/agents" variant="secondary" size="lg">
                    See the {AGENT_COUNT} agents
                  </ButtonLink>
                </>
              }
            />
          </div>

          <Card variant="secondary" className="p-5 lg:mt-2">
            <p className="gv-label text-ink-3">In the library</p>
            <p className="gv-metric-sm mt-1.5 text-ink" data-numeric="">
              {BLOCK_COUNT} blocks
            </p>
            <p className="gv-support mt-2">
              {AGENT_COUNT} GravAI agents and the platform's own workflow node types, in the{" "}
              {FAMILY_COUNT} families the engine groups them into, generated from the engine's
              registry rather than written for this page. Each carries the description the registry
              gives it, unedited. If a block is not in the rail, GravAI does not have it.
            </p>
          </Card>
        </div>
      </Band>

      <Band tone="soft" size="md">
        <SectionHeading
          eyebrow="Plainly"
          title="Real here, and only in the console"
          lede="A control that cannot do what it says is worse than no control at all — which is why the panel on the right of the canvas describes how an agent runs instead of offering switches that would only pretend to change it."
        />

        <div className="mt-8 grid gap-5 md:grid-cols-2">
          <Card className="p-6">
            <h3 className="text-[15px] font-semibold text-ink">Real, right here</h3>
            <ul className="gv-ticklist mt-3 text-[13.5px]">
              {HERE.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Card>

          <Card className="p-6">
            <h3 className="text-[15px] font-semibold text-ink">Only in the console</h3>
            <ul className="gv-checklist mt-3 text-[13.5px]">
              {NOT_HERE.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Card>
        </div>
      </Band>

      <Band tone="tint" size="md" pattern="wash">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-16">
          <div className="min-w-0">
            <SectionHeading
              eyebrow="The library"
              size="sm"
              title="The blocks are the platform's, not the brochure's"
            />
            <div className="gv-body mt-4 space-y-4">
              <p>
                The console fetches its node library from the engine, so a node cannot appear on its
                canvas that the engine has no executor for. This page is unauthenticated and has no
                token to fetch with, so the library here is generated from the same registry at
                build time and a test fails if the two drift apart. Same types, same families, same
                one-line descriptions — including the places where a node says what it cannot do.
              </p>
              <p>
                That is why the Calculator block tells you it resolves a path rather than computing
                one, and why the Business Rule Engine says a model node cannot overturn it. Those
                sentences are the platform's own. Removing them would make a nicer canvas and a
                worse product.
              </p>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <ButtonLink href="/agents" variant="secondary">
                The agent catalog
              </ButtonLink>
              <ButtonLink href="/docs/agent-reference" variant="ghost">
                Agent reference
              </ButtonLink>
            </div>
          </div>

          <Card variant="secondary" className="p-6">
            <h3 className="text-[15px] font-semibold text-ink">
              What the colours on the canvas mean
            </h3>
            <p className="gv-support mt-3">
              A card's plate colour is its <strong className="font-semibold text-ink">kind</strong>:
              each node type has its own hue, so a step is recognisable across a wide canvas before
              its title can be read. It is a label and it claims nothing.
            </p>
            <p className="gv-support mt-3">
              The claim is printed instead. Every card carries a chip reading{" "}
              <strong className="font-semibold text-ink">model</strong> or{" "}
              <strong className="font-semibold text-ink">code</strong> — whether a language model
              reasons inside that step, or whether code reaches a fixed answer. That is the one
              distinction a credit team has to be able to make, so it is a word on the card rather
              than a colour somebody has to have been told about.
            </p>
            <p className="gv-support mt-3">
              An edge drawn solid always runs. An edge drawn dashed leaves a branch, so it runs only
              when that branch is chosen — the engine marks the rest skipped rather than failed.
              Neither is drawn green or red: both branches of a decision carry on, and green and red
              are kept for a run that proceeded or a run that stopped.
            </p>
            <p className="gv-support mt-3">
              The same encoding is used in the console's run graph and in the studio, so a sketch
              read here is read the same way there.{" "}
              <Link href="/how-it-works" className="gv-link">
                How a run reaches a person
              </Link>
              .
            </p>
          </Card>
        </div>
      </Band>

      <Band tone="inverse" size="md">
        <SectionHeading
          eyebrow="Next"
          align="center"
          title="Take the shape and make it an agent"
          lede="The studio configures each step, checks the draft against the registry, compiles a version and runs it — with a trace of every step, whether the run succeeds or not."
          actions={
            <>
              <ButtonLink href="/console/studio" variant="primary" size="lg">
                Open the Agent Studio
              </ButtonLink>
              <ButtonLink href="/docs/quickstart" variant="secondary" size="lg">
                Read the quickstart
              </ButtonLink>
            </>
          }
        />
      </Band>
    </>
  );
}
