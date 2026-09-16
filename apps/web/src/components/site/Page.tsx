import type { ReactNode } from "react";
import { Eyebrow } from "@/components/ui/Surface";

/**
 * Marketing page scaffolding.
 *
 * The unit of a marketing page is a BAND: a full-bleed ground with a container
 * inside it. A page alternates bands — white, soft, white, tinted — so it
 * stops being one uniform sheet of paper, and the ground itself does the
 * separating instead of a stack of 1px rules.
 *
 * `Container` and `Section` are unchanged in behaviour and are still the right
 * answer inside a band, or on a page that does not want bands at all.
 */

export function Container({
  children,
  className,
  width = "wide",
}: {
  children: ReactNode;
  className?: string;
  width?: "wide" | "narrow" | "full";
}) {
  const max =
    width === "narrow" ? "max-w-[920px]" : width === "full" ? "max-w-[1440px]" : "max-w-[1240px]";
  return <div className={`mx-auto px-5 sm:px-6 ${max} ${className ?? ""}`}>{children}</div>;
}

const SECTION_SIZE = {
  sm: "py-10 sm:py-12",
  md: "py-14 sm:py-18",
  lg: "py-16 sm:py-24",
} as const;

export function Section({
  children,
  className,
  id,
  bordered = true,
  size = "md",
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  bordered?: boolean;
  size?: keyof typeof SECTION_SIZE;
}) {
  return (
    <section
      id={id}
      className={`${bordered ? "border-t border-line" : ""} ${SECTION_SIZE[size]} ${className ?? ""}`}
    >
      {children}
    </section>
  );
}

export type BandTone = "white" | "soft" | "tint" | "tint-deep" | "deep" | "inverse";

const BAND_TONE: Record<BandTone, string> = {
  white: "gv-band-white",
  soft: "gv-band-soft",
  tint: "gv-band-tint",
  "tint-deep": "gv-band-tint-deep",
  deep: "gv-band-deep",
  inverse: "gv-band-inverse gv-inverse",
};

export type BandPattern =
  | "none"
  | "grid"
  | "dots"
  | "radial"
  | "radial-center"
  | "wash";

const BAND_PATTERN: Record<BandPattern, string> = {
  none: "",
  grid: "gv-grid-faint",
  dots: "gv-dots",
  radial: "gv-radial-brand",
  "radial-center": "gv-radial-brand-center",
  /** The flat 3% brand wash, laid over whatever ground the band already has. */
  wash: "gv-wash",
};

/**
 * A full-bleed section band. This is the building block of every marketing
 * page: it owns the ground, the optional decoration and the vertical rhythm,
 * and it puts a `Container` around whatever you give it.
 *
 * Alternate the tones down a page — white, soft, white, tint — and use
 * `inverse` at most once, for the closing call to action.
 */
export function Band({
  children,
  tone = "white",
  pattern = "none",
  size = "md",
  bordered = false,
  width = "wide",
  id,
  className,
  innerClassName,
  as: Tag = "section",
}: {
  children: ReactNode;
  tone?: BandTone;
  pattern?: BandPattern;
  size?: keyof typeof SECTION_SIZE;
  /** A hairline along the top edge. Only needed between two bands of the
   *  same tone; different tones separate themselves. */
  bordered?: boolean;
  width?: "wide" | "narrow" | "full";
  id?: string;
  className?: string;
  innerClassName?: string;
  as?: "section" | "div" | "header" | "footer";
}) {
  return (
    <Tag
      id={id}
      className={`${BAND_TONE[tone]} ${BAND_PATTERN[pattern]} ${bordered ? "border-t border-line" : ""} ${SECTION_SIZE[size]} ${className ?? ""}`}
    >
      <Container width={width} className={innerClassName}>
        {children}
      </Container>
    </Tag>
  );
}

/** The hairline that fades out at both ends. Use between two bands of the
 *  same tone, or between two blocks inside one band. */
export function Rule({ className }: { className?: string }) {
  return <hr className={`gv-rule ${className ?? ""}`} />;
}

/**
 * Marketing page header. Left-aligned with an asymmetric grid so the eye has
 * a single entry point. The ground is white with a soft brand light in the
 * top-left corner and a faint engineering grid behind it — decoration that is
 * markup and CSS, never an image.
 */
export function PageHeader({
  eyebrow,
  title,
  lede,
  aside,
  actions,
  pattern = "radial",
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  lede: ReactNode;
  aside?: ReactNode;
  /** Buttons under the lede. */
  actions?: ReactNode;
  pattern?: BandPattern;
  className?: string;
}) {
  return (
    <div
      className={`gv-band-white ${BAND_PATTERN[pattern]} border-b border-line ${className ?? ""}`}
    >
      <Container className="py-14 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-16">
          <div className="min-w-0">
            <Eyebrow tick className="mb-4 text-brand">
              {eyebrow}
            </Eyebrow>
            <h1 className="gv-display-sm max-w-3xl">{title}</h1>
            <div className="gv-lede mt-5 max-w-2xl">{lede}</div>
            {actions ? (
              <div className="mt-8 flex flex-wrap items-center gap-3">{actions}</div>
            ) : null}
          </div>
          {aside ? <div className="min-w-0 lg:pt-2">{aside}</div> : null}
        </div>
      </Container>
    </div>
  );
}

/**
 * Numbered list used for principles and ordered explanations. The number now
 * sits in a brand plate against a spine, so a sequence reads as a sequence
 * rather than as a stack of unrelated cards.
 */
export function NumberedList({
  items,
  className,
}: {
  items: { title: string; body: ReactNode }[];
  className?: string;
}) {
  return (
    <ol className={`space-y-3 ${className ?? ""}`}>
      {items.map((item, index) => (
        <li
          key={item.title}
          className="gv-card grid gap-x-5 gap-y-1.5 p-5 sm:grid-cols-[2.25rem_minmax(0,20rem)_1fr]"
        >
          <span
            className="gv-icon-plate gv-icon-plate-sm text-[12px] font-semibold"
            data-numeric=""
          >
            {String(index + 1).padStart(2, "0")}
          </span>
          <h3 className="self-center text-[15px] text-ink">{item.title}</h3>
          <div className="gv-support">{item.body}</div>
        </li>
      ))}
    </ol>
  );
}

/**
 * The same ordered idea drawn as a vertical process: a brand spine, a plate
 * per step, and no card chrome. Use when the steps are a flow rather than a
 * list of independent facts.
 */
export function StepList({
  items,
  className,
}: {
  items: { title: string; body: ReactNode }[];
  className?: string;
}) {
  return (
    <ol className={`gv-spine space-y-6 ${className ?? ""}`}>
      {items.map((item, index) => (
        <li key={item.title} className="grid gap-x-4 pl-0 sm:grid-cols-[2rem_1fr]">
          <span
            className="gv-icon-plate gv-icon-plate-sm relative z-10 bg-surface text-[12px] font-semibold"
            data-numeric=""
          >
            {index + 1}
          </span>
          <div className="min-w-0 pt-0.5">
            <h3 className="text-[15px] text-ink">{item.title}</h3>
            <div className="gv-support mt-1.5">{item.body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function KeyValueGrid({
  items,
  columns = 2,
}: {
  items: { label: string; value: ReactNode }[];
  columns?: 2 | 3;
}) {
  return (
    <dl className={`grid gap-3 ${columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
      {items.map((item) => (
        <div key={item.label} className="gv-card p-4">
          <dt className="gv-label text-ink-3">{item.label}</dt>
          <dd className="mt-1.5 text-[14px] leading-relaxed text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A compact list of facts, rendered as a bordered definition table. */
export function FactList({
  items,
  className,
}: {
  items: { label: string; value: ReactNode }[];
  className?: string;
}) {
  return (
    <dl className={`gv-card divide-y divide-[var(--gv-line)] overflow-hidden ${className ?? ""}`}>
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline justify-between gap-4 px-4 py-3">
          <dt className="text-[13.5px] text-ink-2">{item.label}</dt>
          <dd className="text-[14px] font-medium text-ink" data-numeric="">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
