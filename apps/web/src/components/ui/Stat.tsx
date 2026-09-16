import type { ReactNode } from "react";

/**
 * Metric tiles and meters.
 *
 * Figures are tabular so a row of tiles aligns on the decimal, and the one
 * accent colour in a tile is reserved for the figure itself. A trend is never
 * signalled by hue alone: the arrow glyph and the word carry the meaning and
 * the colour only reinforces it.
 */

type Accent = "ink" | "brand" | "blue" | "amber" | "pass" | "fail";

const ACCENT_CLASS: Record<Accent, string> = {
  ink: "text-ink",
  brand: "text-brand",
  blue: "text-brand",
  amber: "text-amber",
  pass: "text-pass",
  fail: "text-fail",
};

export type StatVariant = "card" | "rule" | "plain" | "elevated" | "cell";

const STAT_VARIANT: Record<StatVariant, string> = {
  /** The default: a white card on the page. */
  card: "gv-card p-4",
  /** A card with the brand hairline down its left edge. For a row of
   *  instrumentation figures that has to read as one instrument. */
  rule: "gv-card gv-card-metric p-4 pl-5",
  /** No chrome at all. For tiles that already sit inside a panel, divided by
   *  hairlines rather than by borders. */
  plain: "p-4",
  /** The headline figure of a section. */
  elevated: "gv-card gv-card-elevated p-5 sm:p-6",
  /** A cell of a `.gv-cells` hairline grid: no border of its own, because the
   *  grid draws the rules. Roomier than `plain`, which sits inside a panel. */
  cell: "p-5",
};

const VALUE_SIZE = {
  sm: "text-[20px]",
  md: "text-[26px]",
  lg: "gv-metric-sm",
  xl: "gv-metric",
} as const;

export function StatTile({
  label,
  value,
  unit,
  note,
  accent = "ink",
  icon,
  className,
  variant = "card",
  size = "md",
  trend,
  source,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  note?: ReactNode;
  accent?: Accent;
  icon?: ReactNode;
  className?: string;
  variant?: StatVariant;
  size?: keyof typeof VALUE_SIZE;
  /** Direction plus a word. The word is required; the colour is optional. */
  trend?: { direction: "up" | "down" | "flat"; label: string; tone?: Accent };
  /** Provenance line, pinned to the bottom of the tile. */
  source?: ReactNode;
}) {
  const accentClass = ACCENT_CLASS[accent];

  return (
    <div className={`min-w-0 ${STAT_VARIANT[variant]} ${className ?? ""}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="gv-label text-ink-3">{label}</p>
        {icon ? <span className="gv-icon-plate gv-icon-plate-sm">{icon}</span> : null}
      </div>
      <p className="mt-2.5 flex items-baseline gap-1.5">
        <span
          className={`${VALUE_SIZE[size]} leading-none font-semibold tracking-tight ${accentClass}`}
          data-numeric=""
        >
          {value}
        </span>
        {unit ? <span className="text-[12.5px] font-medium text-ink-3">{unit}</span> : null}
      </p>
      {trend ? (
        <p className="mt-2.5">
          <Delta direction={trend.direction} tone={trend.tone}>
            {trend.label}
          </Delta>
        </p>
      ) : null}
      {note ? <p className="gv-help mt-2.5 leading-relaxed">{note}</p> : null}
      {source ? <p className="mt-3 font-mono text-[11px] text-ink-3">{source}</p> : null}
    </div>
  );
}

/**
 * A change indicator. The triangle glyph states the direction, the label
 * states the amount, and the colour is the third signal rather than the only
 * one — which is what keeps it readable for a colour-blind underwriter.
 */
export function Delta({
  direction,
  children,
  tone,
  className,
}: {
  direction: "up" | "down" | "flat";
  children: ReactNode;
  tone?: Accent;
  className?: string;
}) {
  const glyph = direction === "up" ? "▲" : direction === "down" ? "▼" : "■";
  const resolved: Accent = tone ?? "ink";
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[12.5px] font-medium ${ACCENT_CLASS[resolved]} ${className ?? ""}`}
    >
      <span aria-hidden="true" className="text-[9px] leading-none">
        {glyph}
      </span>
      <span className="sr-only">
        {direction === "up" ? "Up" : direction === "down" ? "Down" : "Unchanged"}:{" "}
      </span>
      {children}
    </span>
  );
}

/**
 * The one enormous figure a section is built around. Two columns on tablet,
 * one on a phone; the figure never wraps because it is a single word.
 */
export function KeyFigure({
  value,
  unit,
  label,
  note,
  accent = "brand",
  className,
}: {
  value: ReactNode;
  unit?: ReactNode;
  label?: ReactNode;
  note?: ReactNode;
  accent?: Accent;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      {label ? <p className="gv-eyebrow mb-3">{label}</p> : null}
      <p className="flex items-baseline gap-2">
        <span className={`gv-metric ${ACCENT_CLASS[accent]}`} data-numeric="">
          {value}
        </span>
        {unit ? <span className="text-[15px] font-medium text-ink-3">{unit}</span> : null}
      </p>
      {note ? <p className="gv-support mt-3">{note}</p> : null}
    </div>
  );
}

/**
 * A row of tiles. Four across on desktop, two on tablet, one on a phone —
 * reorganised rather than shrunk, and `min-w-0` throughout so a long figure
 * never pushes the page sideways.
 */
export function StatGrid({
  children,
  columns = 4,
  className,
  as: Tag = "div",
  divided = false,
}: {
  children: ReactNode;
  columns?: 2 | 3 | 4;
  className?: string;
  as?: "div" | "ul" | "dl";
  /** Draws the row as one hairline-divided block rather than separate cards.
   *  Pair with `variant="cell"` tiles, which bring no border of their own. */
  divided?: boolean;
}) {
  const cols =
    columns === 2
      ? "sm:grid-cols-2"
      : columns === 3
        ? "sm:grid-cols-2 lg:grid-cols-3"
        : "sm:grid-cols-2 lg:grid-cols-4";
  const shell = divided ? "gv-cells" : "grid gap-3";
  return <Tag className={`${shell} ${cols} ${className ?? ""}`}>{children}</Tag>;
}

/** A horizontal meter for quota utilisation and budget consumption. */
export function Meter({
  value,
  max = 1,
  tone = "brand",
  label,
  className,
  showValue = false,
  size = "md",
}: {
  value: number;
  max?: number;
  tone?: "brand" | "blue" | "amber" | "fail" | "pass";
  label?: string;
  className?: string;
  /** Prints the percentage above the track, tabular. */
  showValue?: boolean;
  size?: "sm" | "md";
}) {
  const ratio = max > 0 ? Math.min(1.5, Math.max(0, value / max)) : 0;
  const pct = Number((ratio * 100).toFixed(1));
  const width = `${Math.min(100, ratio * 100).toFixed(1)}%`;
  const bar = {
    brand: "bg-brand",
    blue: "bg-brand-400",
    amber: "bg-amber",
    fail: "bg-fail",
    pass: "bg-pass",
  }[tone];

  return (
    <div
      className={className}
      role="meter"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? "Utilisation"}
    >
      {showValue ? (
        <p className="mb-1.5 flex items-baseline justify-between gap-2">
          {label ? <span className="gv-label text-ink-3">{label}</span> : null}
          <span className="text-[12.5px] font-medium text-ink" data-numeric="">
            {pct.toFixed(0)}%
          </span>
        </p>
      ) : null}
      <div
        className={`${size === "sm" ? "h-1" : "h-1.5"} w-full overflow-hidden rounded-full bg-surface-3`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${bar}`}
          style={{ width }}
        />
      </div>
      {ratio > 1 ? (
        <p className="mt-1 text-[11.5px] font-medium text-fail">
          Over capacity by {((ratio - 1) * 100).toFixed(0)}%
        </p>
      ) : null}
    </div>
  );
}
