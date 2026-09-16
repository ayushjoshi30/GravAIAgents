import type { ReactNode } from "react";
import { Eyebrow } from "@/components/ui/Surface";
import { hueStyle } from "@/components/build/blocks";

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
 *
 * A band, a section and a page header can each be given a HUE, which paints
 * the ground in that hue's softest step and publishes the hue's four steps to
 * everything inside as custom properties. Spend it sparingly: one or two
 * coloured grounds down a page make the white ones read as deliberate, while a
 * page where every band is tinted has no rhythm left and is worse than a page
 * with none. The reserved three — green, amber and rose — belong to outcome
 * and must never be handed to a band as decoration.
 */

/**
 * The ground and edge for a hued band, or nothing when no hue was asked for.
 *
 * Two grounds are excluded by construction. `deep` and `inverse` carry white
 * text, and repainting either with a pale tint would leave that text on a
 * surface it cannot be read against — so those two keep their own ground and
 * the hue is dropped entirely rather than half-applied, which would publish a
 * plate to the children of a band whose text is white.
 *
 * The background is written as `var(--plate)` rather than as the hue token
 * directly, so a band and everything nested in it agree about which value the
 * plate is even if the properties are later overridden further down the tree.
 */
function hueGround(hue: string | undefined, tone: BandTone) {
  if (!hue || tone === "deep" || tone === "inverse") return undefined;
  return { ...hueStyle(hue), background: "var(--plate)" };
}

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
  hue,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  bordered?: boolean;
  size?: keyof typeof SECTION_SIZE;
  /**
   * A categorical hue name — violet, indigo, blue, cyan, teal, navy, pink,
   * orange or slate. A section owns no ground, so the hue reaches two things:
   * its top hairline, and the four plate properties every card and badge
   * inside it can read. Omit it and the section is byte-for-byte what it was.
   */
  hue?: string;
}) {
  return (
    <section
      id={id}
      style={hue ? hueStyle(hue) : undefined}
      className={`${bordered ? `border-t ${hue ? "border-[var(--plate-border)]" : "border-line"}` : ""} ${SECTION_SIZE[size]} ${className ?? ""}`}
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
 * `inverse` at most once, for the closing call to action. A `hue` replaces the
 * ground with a colour from the categorical palette; one or two down a page,
 * never more.
 */
export function Band({
  children,
  tone = "white",
  hue,
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
  /**
   * A categorical hue name — violet, indigo, blue, cyan, teal, navy, pink,
   * orange or slate. It repaints the band's ground in that hue's softest step
   * and publishes all four steps to the band's children, so a card or badge
   * inside can pick the colour up without being told it twice.
   *
   * Never green, amber or rose: those three mean a run proceeded, a rule
   * flagged risk, or a run stopped, and a band that borrows one of them makes
   * every genuine outcome on the site harder to trust.
   *
   * `deep` and `inverse` ignore it — see `hueGround` for why.
   */
  hue?: string;
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
  const ground = hueGround(hue, tone);
  return (
    <Tag
      id={id}
      style={ground}
      /* The tone class is kept even when a hue overrides the ground, so a band
         that loses its hue falls back to the ground it was always going to
         have rather than to nothing at all. */
      className={`${BAND_TONE[tone]} ${BAND_PATTERN[pattern]} ${bordered ? `border-t ${ground ? "border-[var(--plate-border)]" : "border-line"}` : ""} ${SECTION_SIZE[size]} ${className ?? ""}`}
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
  hue,
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  lede: ReactNode;
  aside?: ReactNode;
  /** Buttons under the lede. */
  actions?: ReactNode;
  pattern?: BandPattern;
  /**
   * A categorical hue name, which tints the header's ground and its eyebrow
   * and publishes the four plate steps to the aside. Use it to give a page a
   * colour of its own at the top; leave it off and the header is the white
   * ground with the brand light it has always been.
   */
  hue?: string;
  className?: string;
}) {
  const ground = hueGround(hue, "white");
  return (
    <div
      style={ground}
      className={`gv-band-white ${BAND_PATTERN[pattern]} border-b ${ground ? "border-[var(--plate-border)]" : "border-line"} ${className ?? ""}`}
    >
      <Container className="py-14 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-16">
          <div className="min-w-0">
            {/* The eyebrow takes the hue's `-strong` step because it is sitting
                on that hue's soft plate. Its leading tick keeps the brand
                gradient it is drawn with in globals.css — a 24px navy rule in
                front of coloured text reads as the wordmark agreeing with the
                page rather than as a mismatch. */}
            <Eyebrow tick className={`mb-4 ${ground ? "text-[var(--plate-strong)]" : "text-brand"}`}>
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
