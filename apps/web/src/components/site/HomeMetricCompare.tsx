import { StatGrid, StatTile } from "@/components/ui/Stat";
import { CALL_MODEL, DOC_AI_RPM } from "@/lib/platform";

/**
 * The comparison the platform is built around: twelve API calls to read one
 * document against the forty it used to take.
 *
 * Drawn, not asserted. Each bar is `CALL_MODEL.digitiseFlat.total` cells wide
 * and one cell is one call against the document intelligence quota, so the two
 * bars are to scale against each other by construction — the drawing cannot
 * drift from the numbers because it is generated from them.
 *
 *   extract, with back-off      1 submit + ~10 status polls + 1 results fetch
 *   digitise, flat 0.8s polls   1 submit + 37 status polls + 1 results fetch
 *                               + 1 language-model read of the text it returns
 *
 * No figure here is invented: every count comes from `CALL_MODEL` in
 * `src/lib/platform.ts`, and the deltas are computed from those counts.
 *
 * WHY THE COLOUR IS BY CALL KIND RATHER THAN BY PATH. Both bars now share one
 * four-hue key, so the eye reads the actual finding — that the long bar is
 * almost entirely status polls — before the sentence underneath says it.
 * Giving each path a hue of its own, as this drawing used to, painted
 * thirty-seven identical polls the same colour as the one submit in front of
 * them: a picture that looks like data and carries none.
 *
 * The hues are categorical ones: violet, cyan and indigo for the three kinds
 * of HTTP call, and teal for the language-model read, because teal means a
 * language model is doing the work everywhere else in this product too. Green,
 * amber and rose are absent on purpose. They mean an outcome — proceeded,
 * at risk, stopped — and an API call is not an outcome.
 */

type CallKind = "submit" | "poll" | "results" | "model";

const KIND_WORDS: Record<CallKind, { one: string; many: string }> = {
  submit: { one: "submit", many: "submits" },
  poll: { one: "status poll", many: "status polls" },
  results: { one: "results fetch", many: "results fetches" },
  model: { one: "language-model read", many: "language-model reads" },
};

/**
 * One hue per kind of call, shared by both bars and both legends. Literal
 * class names are correct here because the four kinds are known while this
 * file is being written; the class-from-a-runtime-value problem only bites
 * where the hue comes out of data, and `hueStyle` is the answer there.
 */
const KIND_CLASS: Record<CallKind, string> = {
  submit: "bg-[var(--gv-hue-violet)]",
  poll: "bg-[var(--gv-hue-cyan)]",
  results: "bg-[var(--gv-hue-indigo)]",
  model: "bg-[var(--gv-hue-teal)]",
};

/** The longer path sets the scale, so both bars share one axis. */
const SCALE = CALL_MODEL.digitiseFlat.total;

type PathRow = {
  id: string;
  label: string;
  caption: string;
  total: number;
  /**
   * The plane this row is drawn on. Today's path sits on the panel's own
   * white and the superseded one a step into it, so the two are told apart by
   * depth rather than by a hue that would then have to mean something.
   */
  ground: string;
  /** The figure's colour. Navy is the platform's own number; the superseded
   *  one is stated in a quieter ink and left to the bar to dramatise. */
  figure: string;
  parts: { kind: CallKind; count: number }[];
};

const ROWS: PathRow[] = [
  {
    id: "extract",
    label: "Extract, with back-off",
    caption: "What one document costs today",
    total: CALL_MODEL.extract.total,
    ground: "bg-surface",
    figure: "text-brand",
    parts: [
      { kind: "submit", count: CALL_MODEL.extract.submit },
      { kind: "poll", count: CALL_MODEL.extract.polls },
      { kind: "results", count: CALL_MODEL.extract.results },
      { kind: "model", count: CALL_MODEL.extract.llmReads },
    ],
  },
  {
    id: "flat",
    label: "Digitise, flat 0.8-second polling",
    caption: "What it cost before back-off",
    total: CALL_MODEL.digitiseFlat.total,
    ground: "bg-surface-2",
    figure: "text-ink-3",
    parts: [
      { kind: "submit", count: CALL_MODEL.digitiseFlat.submit },
      { kind: "poll", count: CALL_MODEL.digitiseFlat.polls },
      { kind: "results", count: CALL_MODEL.digitiseFlat.results },
      { kind: "model", count: CALL_MODEL.digitiseFlat.llmReads },
    ],
  },
];

function cellsFor(row: PathRow): (CallKind | null)[] {
  const cells: (CallKind | null)[] = [];
  for (const part of row.parts) {
    for (let index = 0; index < part.count; index += 1) {
      cells.push(part.kind);
    }
  }
  while (cells.length < SCALE) {
    cells.push(null);
  }
  return cells;
}

function words(kind: CallKind, count: number) {
  return count === 1 ? KIND_WORDS[kind].one : KIND_WORDS[kind].many;
}

/**
 * One path: the figure, the bar and the legend that says which colour is
 * which. The bar itself is `aria-hidden` because every number in it is stated
 * in words directly underneath.
 */
function PathBar({ row }: { row: PathRow }) {
  const cells = cellsFor(row);
  const parts = row.parts.filter((part) => part.count > 0);

  return (
    <div className={`p-5 sm:p-6 ${row.ground}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="gv-label text-ink-3">{row.label}</p>
        <p className="gv-micro">{row.caption}</p>
      </div>

      <p className="mt-2 flex items-baseline gap-2.5">
        <span className={`gv-metric ${row.figure}`} data-numeric="">
          {row.total}
        </span>
        <span className="text-[13.5px] font-medium text-ink-3">calls per document</span>
      </p>

      <div
        className="mt-4 grid gap-[2px]"
        style={{ gridTemplateColumns: `repeat(${SCALE}, minmax(0, 1fr))` }}
        aria-hidden="true"
      >
        {cells.map((kind, index) => (
          <span
            key={`${row.id}-${index}-${kind ?? "unused"}`}
            className={`h-3.5 rounded-[2px] ${kind ? KIND_CLASS[kind] : "bg-surface-3"}`}
          />
        ))}
      </div>

      <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {parts.map((part) => (
          <li key={part.kind} className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-[2px] ${KIND_CLASS[part.kind]}`}
              aria-hidden="true"
            />
            <span className="font-semibold text-ink" data-numeric="">
              {part.count}
            </span>
            {words(part.kind, part.count)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HomeMetricCompare({
  source,
  className,
}: {
  /** Provenance for the comparison, printed under the deltas. */
  source?: string;
  className?: string;
}) {
  const removed = CALL_MODEL.digitiseFlat.total - CALL_MODEL.extract.total;
  const reduction = Math.round((removed / CALL_MODEL.digitiseFlat.total) * 100);

  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      <div className="gv-panel overflow-hidden">
        <div className="gv-toolbar">
          <p className="gv-eyebrow">API calls to read one document</p>
          <p className="gv-micro font-mono">1 cell = 1 call · axis 0–{SCALE}</p>
        </div>
        <div className="gv-divide">
          {ROWS.map((row) => (
            <PathBar key={row.id} row={row} />
          ))}
        </div>
      </div>

      <StatGrid columns={3} divided className="mt-4">
        <StatTile
          variant="cell"
          size="lg"
          accent="brand"
          label="Calls removed per document"
          value={removed}
          trend={{
            direction: "down",
            label: `${CALL_MODEL.digitiseFlat.total} → ${CALL_MODEL.extract.total}`,
            tone: "brand",
          }}
        />
        <StatTile
          variant="cell"
          size="lg"
          accent="brand"
          label="Fewer calls per document"
          value={`${reduction}%`}
          note={`Against a ceiling of ${DOC_AI_RPM} requests per minute that extract and digitise share.`}
        />
        <StatTile
          variant="cell"
          size="lg"
          label="Status polls per document"
          value={`${CALL_MODEL.digitiseFlat.polls} → ${CALL_MODEL.extract.polls}`}
          note="Back-off replaces flat 0.8-second polling on a job that takes about thirty seconds."
        />
      </StatGrid>

      {/* Not `.gv-micro`: its ink-3 is tuned against white, and this line is
          the one piece of the component that sits on the band rather than on
          the panel — 4.46:1 on the brand tint the home page puts behind it.
          The same sentence one step darker clears 4.5:1 on every band tone
          this component is used on. */}
      {source ? (
        <p className="mt-3 text-[12.5px] leading-[1.5] text-ink-2">Source: {source}</p>
      ) : null}
    </div>
  );
}
