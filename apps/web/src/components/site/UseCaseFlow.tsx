/**
 * The worked-example panel on an agent page, drawn as an execution timeline.
 *
 * Reads top to bottom the way the work actually happens: who arrived, what the
 * platform did, what came back. Each stage sits on a numbered marker against a
 * spine, and the last stage is the outcome — deliberately the heaviest object
 * on the panel, because it is the only one a reader has to remember.
 *
 * The figures are real output captured from a sandbox run — see
 * `lib/agent-usecase.ts` — so this is a record of a run rather than a picture
 * of one. Nothing here invents a number: every value, label and status word is
 * read off the `AgentUseCase` passed in, and `tests/test_usecase_figures.py`
 * pins those values to the generated samples.
 *
 * Drawn entirely in markup, CSS and inline SVG from the shared icon set. The
 * product ships no raster assets, so there is nothing here that can 404 or
 * arrive at the wrong resolution.
 */

import { Icon } from "@/components/icons/AgentIcon";
import type { AgentUseCase, FlowNode, FlowRow, FlowTone } from "@/lib/agent-usecase";

/**
 * Set this to a path under `public/` to show a photograph instead of the
 * initials. It stays null until an image exists with a licence entry in
 * `public/images/MANIFEST.md` — the rule is that an asset either appears in
 * that manifest or it is not on the site.
 */
const AVATAR_SRC: string | null = null;

const TONE_TEXT: Record<FlowTone, string> = {
  pass: "text-pass",
  amber: "text-amber",
  fail: "text-fail",
  plain: "text-ink",
};

/**
 * Colour alone is not a signal. Each non-neutral tone also carries a word for
 * a screen reader and a shape for anyone who cannot separate the hues.
 */
const TONE_WORD: Record<FlowTone, string | null> = {
  pass: "meets policy",
  amber: "needs attention",
  fail: "over limit",
  plain: null,
};

function ToneMark({ tone }: { tone: FlowTone }) {
  const word = TONE_WORD[tone];
  if (!word) return null;
  return <span className="sr-only"> — {word}</span>;
}

function CheckDot({ tone = "pass" }: { tone?: FlowTone }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-px inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border ${
        tone === "amber"
          ? "border-amber-border bg-amber-soft text-amber"
          : tone === "fail"
            ? "border-fail-border bg-fail-soft text-fail"
            : "border-pass-border bg-pass-soft text-pass"
      }`}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" focusable="false">
        {tone === "amber" || tone === "fail" ? (
          <path
            d="M6 3v3.5M6 8.75v.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        ) : (
          <path
            d="M2.5 6.2 4.9 8.6 9.5 4"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </span>
  );
}

/**
 * The verdict arrives as one sentence — "Cleared — call permitted and
 * compliant". The part before the dash is the status the panel shouts; the
 * part after is why. Split rather than restated, so the copy still lives in
 * one place and no wording is duplicated into this file.
 */
function splitVerdict(text: string): { word: string; qualifier: string } {
  const dash = text.indexOf("—");
  if (dash === -1) return { word: text.trim(), qualifier: "" };
  return { word: text.slice(0, dash).trim(), qualifier: text.slice(dash + 1).trim() };
}

/**
 * The spine between two stages: a hairline that starts at brand strength
 * under the marker it leaves and fades toward the one it feeds, cut into
 * dashes by a mask so it reads as something travelling rather than a border.
 * The mask is alpha only — the black is a stencil, not a colour — and where a
 * browser ignores it the line simply renders solid.
 */
function StageLine() {
  return (
    <>
      <span
        aria-hidden="true"
        className="mt-2 w-[2px] flex-1 rounded-full opacity-85 transition-opacity duration-200 ease-gv group-hover:opacity-100"
        style={{
          backgroundImage:
            "linear-gradient(180deg, var(--gv-brand) 0%, var(--gv-brand-300) 38%, var(--gv-brand-200) 70%, var(--gv-line) 100%)",
          maskImage: "repeating-linear-gradient(180deg, rgb(0 0 0) 0 6px, transparent 6px 10px)",
          WebkitMaskImage:
            "repeating-linear-gradient(180deg, rgb(0 0 0) 0 6px, transparent 6px 10px)",
        }}
      />
      <span
        aria-hidden="true"
        className="-mt-0.5 mb-1 flex text-brand-300 transition-colors duration-200 ease-gv group-hover:text-brand"
      >
        <Icon name="chevron" size={12} />
      </span>
    </>
  );
}

/** The numbered plate on the spine. The outcome terminates it with a glyph. */
function StageMarker({
  ordinal,
  kind,
  escalated,
}: {
  ordinal: string;
  kind: FlowNode["kind"];
  escalated: boolean;
}) {
  if (kind === "result") {
    return (
      <span
        aria-hidden="true"
        className={`relative z-[1] flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-white ring-4 ${
          escalated ? "bg-amber ring-amber-soft" : "bg-brand shadow-brand ring-pass-soft"
        }`}
      >
        <Icon name={escalated ? "warning" : "check"} size={14} />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      data-numeric=""
      className={`relative z-[1] flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-brand-200 font-mono text-[11px] font-semibold text-brand shadow-resting ${
        kind === "actor" ? "bg-brand-50" : "bg-surface"
      }`}
    >
      {ordinal}
    </span>
  );
}

/** Initials, so the flow has a subject without shipping a photograph. */
function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter((part) => /^[A-Za-z]/.test(part))
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  if (AVATAR_SRC) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={AVATAR_SRC}
        alt=""
        width={38}
        height={38}
        className="h-[38px] w-[38px] shrink-0 rounded-full border border-brand-200 object-cover"
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full border border-brand-200 bg-brand-50 text-[13px] font-semibold tracking-wide text-brand"
    >
      {initials}
    </span>
  );
}

function Row({ row }: { row: FlowRow }) {
  const tone = row.tone ?? "plain";
  return (
    <div className="grid gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[minmax(0,10.5rem)_minmax(0,1fr)]">
      <dt className="text-[11.5px] leading-snug text-ink-3">{row.label}</dt>
      <dd
        className={`text-[13px] leading-snug break-words ${TONE_TEXT[tone]} ${
          tone === "plain" ? "" : "font-medium"
        }`}
        data-numeric=""
      >
        {row.value}
        <ToneMark tone={tone} />
        {row.cite ? (
          <span className="ml-1.5 inline-flex items-center rounded border border-line bg-surface-2 px-1.5 py-px align-[1px] font-mono text-[10.5px] font-normal text-ink-3">
            {row.cite}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function ActorCard({ node }: { node: Extract<FlowNode, { kind: "actor" }> }) {
  return (
    <div className="flex items-center gap-3 rounded-[12px] border border-brand-200 bg-surface px-3.5 py-3 shadow-resting transition-shadow duration-200 ease-gv group-hover:shadow-raised">
      <Avatar name={node.name} />
      <span className="min-w-0">
        <span className="block truncate text-[14px] font-semibold text-ink">{node.name}</span>
        <span className="mt-0.5 block text-[12.5px] leading-snug break-words text-ink-3">
          {node.context}
        </span>
      </span>
    </div>
  );
}

function EventCard({ node }: { node: Extract<FlowNode, { kind: "event" }> }) {
  const tone = node.tone ?? "pass";
  // The left edge carries the tone, so the state of a step is legible from
  // the shape of the card and not only from the colour of its tick.
  const edge =
    tone === "amber" ? "border-l-amber" : tone === "fail" ? "border-l-fail" : "border-l-pass";
  return (
    <div
      className={`flex gap-2.5 rounded-[10px] border border-brand-200 border-l-[3px] bg-surface px-3.5 py-3 shadow-resting transition-shadow duration-200 ease-gv group-hover:shadow-raised ${edge}`}
    >
      <CheckDot tone={tone} />
      <span className="min-w-0">
        <span className="block text-[13px] leading-snug text-ink">
          {node.label}
          {node.tone ? <ToneMark tone={node.tone} /> : null}
        </span>
        {node.detail ? (
          <span className="mt-1 block text-[12px] leading-snug break-words text-ink-3" data-numeric="">
            {node.detail}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The terminus. Brand-filled header carrying the status word, the headline
 * figure at metric scale, the checks as a spec sheet, and a footer stating
 * why the run ended the way it did. Green where the agent finished on its
 * own, amber where it handed the decision to a person — which is the designed
 * outcome for four of the fourteen agents, not a failure of any of them.
 */
function ResultCard({
  node,
  escalated,
  status,
}: {
  node: Extract<FlowNode, { kind: "result" }>;
  escalated: boolean;
  status: { word: string; qualifier: string };
}) {
  const headlineTone = node.headline?.tone ?? "plain";
  return (
    <div
      className={`overflow-hidden rounded-[14px] border bg-surface shadow-raised ring-4 ${
        escalated ? "border-amber-border ring-amber-soft" : "border-brand-200 ring-pass-soft"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 bg-brand px-4 py-2.5">
        <p className="gv-eyebrow min-w-0 text-[11px] text-white">{node.eyebrow}</p>
        <p className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-white/25 bg-white/12 px-2 py-[3px] text-[11px] font-semibold tracking-[0.08em] text-white uppercase">
          <Icon name={escalated ? "warning" : "check"} size={12} />
          {status.word}
        </p>
      </div>

      <div className="px-4 py-3.5 sm:px-5">
        {node.headline ? (
          <div className="mb-2.5 border-b border-line pb-3.5">
            <p className="text-[11.5px] leading-snug text-ink-3">{node.headline.label}</p>
            <p
              className={`gv-metric-sm mt-1.5 break-words ${
                headlineTone === "plain" ? "text-brand" : TONE_TEXT[headlineTone]
              }`}
              data-numeric=""
            >
              {node.headline.value}
              <ToneMark tone={headlineTone} />
            </p>
          </div>
        ) : null}
        <dl className="gv-divide">
          {node.rows.map((row) => (
            <Row key={`${row.label}-${row.value}`} row={row} />
          ))}
        </dl>
      </div>

      {status.qualifier ? (
        <p
          className={`border-t px-4 py-2.5 text-[12px] leading-snug sm:px-5 ${
            escalated
              ? "border-amber-border bg-amber-soft text-amber-strong"
              : "border-pass-border bg-pass-soft text-pass"
          }`}
        >
          {status.qualifier}
        </p>
      ) : null}
      <div aria-hidden="true" className={`h-1 ${escalated ? "bg-amber" : "bg-pass"}`} />
    </div>
  );
}

function StageCard({
  node,
  escalated,
  status,
}: {
  node: FlowNode;
  escalated: boolean;
  status: { word: string; qualifier: string };
}) {
  if (node.kind === "actor") return <ActorCard node={node} />;
  if (node.kind === "event") return <EventCard node={node} />;
  return <ResultCard node={node} escalated={escalated} status={status} />;
}

export function UseCaseFlow({ useCase }: { useCase: AgentUseCase }) {
  const escalated = useCase.verdict.kind === "escalated";
  const status = splitVerdict(useCase.verdict.text);

  // Steps are numbered among themselves, so the stage labels read as a
  // sequence of work rather than as a count of cards.
  const stepNumbers = new Map<number, number>();
  useCase.nodes.forEach((node, index) => {
    if (node.kind === "event") stepNumbers.set(index, stepNumbers.size + 1);
  });
  const stepTotal = stepNumbers.size;

  return (
    <div className="mx-auto w-full max-w-[460px] lg:mx-0 lg:max-w-none">
      <div className="gv-panel overflow-hidden">
        <div className="gv-toolbar">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`gv-pip ${escalated ? "gv-pip-amber" : "gv-pip-brand"}`}
            />
            <span className="gv-eyebrow gv-eyebrow-brand text-[11px]">Execution timeline</span>
          </span>
          <span
            className="font-mono text-[11px] tracking-[0.06em] text-ink-3 uppercase"
            data-numeric=""
          >
            {useCase.nodes.length} stages
          </span>
        </div>

        <div
          className="px-3.5 py-5 sm:px-5 sm:py-6"
          style={{
            backgroundImage:
              "linear-gradient(180deg, var(--gv-layer-tint) 0%, var(--gv-surface) 38%)",
          }}
        >
          <ol className="relative">
            {useCase.nodes.map((node, index) => {
              const isLast = index === useCase.nodes.length - 1;
              const step = stepNumbers.get(index);
              const stageLabel =
                node.kind === "actor"
                  ? "Trigger"
                  : node.kind === "result"
                    ? "Outcome"
                    : `Step ${step} of ${stepTotal}`;

              return (
                <li
                  key={`${node.kind}-${index}`}
                  className="group grid grid-cols-[1.875rem_minmax(0,1fr)] gap-x-3 sm:gap-x-4"
                >
                  <div className="flex flex-col items-center">
                    <StageMarker
                      ordinal={String(index + 1).padStart(2, "0")}
                      kind={node.kind}
                      escalated={escalated}
                    />
                    {isLast ? null : <StageLine />}
                  </div>

                  <div className={`min-w-0 ${isLast ? "" : "pb-6"}`}>
                    <p className="flex min-h-[30px] items-center">
                      <span
                        className={`gv-eyebrow text-[11px] ${
                          node.kind === "result" ? "gv-eyebrow-brand" : "text-ink-3"
                        }`}
                      >
                        {stageLabel}
                      </span>
                    </p>
                    <div className="mt-1.5">
                      <StageCard node={node} escalated={escalated} status={status} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

/** The measured figures from the run, and whether it escalated. */
export function UseCaseProof({ useCase }: { useCase: AgentUseCase }) {
  const escalated = useCase.verdict.kind === "escalated";
  const status = splitVerdict(useCase.verdict.text);
  return (
    <div>
      <p className="gv-eyebrow mb-3">Measured from the run</p>

      <dl className="gv-cells gv-cells-raised grid-cols-2 sm:grid-cols-4 lg:grid-cols-2">
        {useCase.proof.map((figure) => (
          // column-reverse so the term precedes the value in the DOM, as a
          // definition list requires, while the figure still reads first.
          <div key={figure.label} className="flex flex-col-reverse gap-1 px-4 py-4">
            <dt className="text-[11.5px] leading-snug text-ink-3">{figure.label}</dt>
            <dd className="gv-metric-sm break-words text-brand" data-numeric="">
              {figure.value}
            </dd>
          </div>
        ))}
      </dl>

      <div
        className={`mt-6 overflow-hidden rounded-[12px] border ${
          escalated ? "border-amber-border" : "border-pass-border"
        }`}
      >
        <p
          className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-3 ${
            escalated ? "bg-amber-soft" : "bg-pass-soft"
          }`}
        >
          <CheckDot tone={escalated ? "amber" : "pass"} />
          <span
            className={`text-[12px] font-semibold tracking-[0.08em] uppercase ${
              escalated ? "text-amber-strong" : "text-pass"
            }`}
          >
            {status.word}
          </span>
          {status.qualifier ? (
            <span className={`text-[13px] ${escalated ? "text-amber-strong" : "text-pass"}`}>
              {status.qualifier}
            </span>
          ) : null}
        </p>
        <p
          className={`border-t bg-surface px-4 py-3 text-[12.5px] leading-relaxed text-ink-2 ${
            escalated ? "border-amber-border" : "border-pass-border"
          }`}
        >
          {escalated
            ? "Escalation is the designed outcome here, not a failure: the agent produced the analysis and handed the decision to a person."
            : "The run completed without needing a person, and every output validator passed."}
        </p>
      </div>
    </div>
  );
}
