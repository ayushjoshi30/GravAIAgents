import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowCorner } from "@/components/ui/Button";
import { hueStyle } from "@/components/build/blocks";

/**
 * Containers.
 *
 * There are four planes in this product — the page ground, a raised panel, an
 * elevated card and a sunken well — and six card roles on top of them:
 *
 *   default      a white card on the page. The workhorse.
 *   elevated     the one card in a section that carries the argument.
 *   secondary    supporting information that must recede.
 *   metric       a figure and its label, with a brand rule down the left edge.
 *   interactive  the whole surface is a link: lifts 3px, border goes brand,
 *                any `gv-card-arrow` inside travels.
 *   feature      a visual and its text, on a brand-tinted ground.
 *   tinted       the same card cut into a hue's soft plate.
 *
 * The visual definition of each lives in globals.css (`.gv-card`,
 * `.gv-card-elevated`, …) so a plain `<div className="gv-card gv-card-metric">`
 * anywhere in the app looks identical to one built from this file.
 *
 * COLOUR REACHES THESE CONTAINERS THROUGH ONE PROP. `Card`, `LinkCard`,
 * `Panel`, `Figure` and `Cells` each take an optional `hue` naming a family in
 * the twelve-hue categorical palette — violet, indigo, blue, cyan, teal, navy,
 * pink, orange, slate. Setting it publishes that hue's four steps as custom
 * properties on the element, which the container's own classes read and which
 * anything nested inside can read too: a `Badge tone="hue"` in a hued card
 * comes out the card's colour without being told it twice.
 *
 * WHY A PROPERTY AND NOT A CLASS NAME. Tailwind builds its stylesheet by
 * scanning the source for complete class names, so `bg-${hue}-soft` yields no
 * style at all — the string is assembled in the browser, long after that
 * stylesheet was written, and the failure is silent. `hueStyle` is the one
 * helper that turns a hue into properties, imported here rather than
 * reimplemented so the marketing site and the studio canvas resolve a hue by
 * the same route.
 *
 * NEVER GREEN, AMBER OR ROSE. Those three mean a run proceeded, a rule flagged
 * risk and a run stopped. A container that borrows one as decoration makes
 * every genuine outcome elsewhere on the site harder to read, and this is a
 * product people use to decide credit.
 */

export type CardVariant =
  | "default"
  | "elevated"
  | "secondary"
  | "metric"
  | "interactive"
  | "feature"
  | "tinted";

const CARD_VARIANT: Record<CardVariant, string> = {
  default: "",
  elevated: "gv-card-elevated",
  secondary: "gv-card-secondary",
  metric: "gv-card-metric",
  interactive: "gv-card-interactive",
  feature: "gv-card-feature",
  /** The plate itself is chosen by `tintedPlate` below, not written here. */
  tinted: "",
};

/**
 * The plate a `tinted` container is cut into.
 *
 * WHY THIS IS TWO CLASS STRINGS AND NOT ONE WITH A var() FALLBACK. Writing it
 * as `bg-[var(--plate,var(--gv-layer-tint))]` looks like it degrades to the
 * brand wash when no hue was given, but a custom property inherits, and
 * `var()` reaches its fallback only when the property is set nowhere up the
 * tree. Inside a `Band` or `Section` that has been given a hue, every
 * descendant already has `--plate` — and there it is the band's own ground, so
 * an untinted-by-choice card would take the exact colour it is sitting on and
 * vanish into it. The fallback that exists to keep the variant usable with no
 * hue is precisely the one case that would never run. So the two spellings are
 * kept apart and the component picks between them on the prop it was actually
 * handed, which is a decision made where the answer is known.
 */
function tintedPlate(hue: string | undefined): string {
  return hue
    ? "border-[var(--plate-border)] bg-[var(--plate)]"
    : "border-[var(--gv-line-tint)] bg-[var(--gv-layer-tint)]";
}

export function Eyebrow({
  children,
  className,
  tick = false,
}: {
  children: ReactNode;
  className?: string;
  /** Draws a short brand rule in front of the text. Use above a display. */
  tick?: boolean;
}) {
  return (
    <p className={`gv-eyebrow ${tick ? "gv-eyebrow-tick" : ""} ${className ?? ""}`}>{children}</p>
  );
}

export function Card({
  children,
  className,
  as: Tag = "div",
  variant = "default",
  hue,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
  variant?: CardVariant;
  /** A categorical hue name. See the note at the top of this file. */
  hue?: string;
}) {
  /* `tinted` already draws its own edge from the plate, so the hue edge is
     added only for the variants that do not. Two border-colour utilities on
     one element would otherwise leave the winner to the order Tailwind
     happened to emit them in, which is not a thing to leave to chance. */
  const hueEdge = hue && variant !== "tinted" ? "border-[var(--plate-border)]" : "";
  const plate = variant === "tinted" ? tintedPlate(hue) : "";
  return (
    <Tag
      style={hue ? hueStyle(hue) : undefined}
      className={`gv-card min-w-0 ${CARD_VARIANT[variant]} ${plate} ${hueEdge} ${className ?? ""}`}
    >
      {children}
    </Tag>
  );
}

/**
 * A whole card that is one link. The arrow is rendered for you and animates
 * from the card's hover and focus-within state, so keyboard users get the
 * same affordance as a mouse.
 */
export function LinkCard({
  href,
  eyebrow,
  title,
  children,
  footer,
  icon,
  className,
  hue,
  external = false,
}: {
  href: string;
  eyebrow?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
  className?: string;
  /**
   * A categorical hue name. It colours the card's edge, its icon plate and its
   * eyebrow, and takes the edge to the hue's accent on hover and focus — which
   * is what lets a row of link cards read as a row of different destinations
   * rather than as four identical white boxes.
   */
  hue?: string;
  external?: boolean;
}) {
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {icon ? (
            <span
              className={`gv-icon-plate mb-3.5 ${hue ? "border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]" : ""}`}
            >
              {icon}
            </span>
          ) : null}
          {/* The eyebrow sits on the card's white ground rather than on the
              plate, so it takes the hue's base step — the value the palette
              tunes to be read on white. */}
          {eyebrow ? (
            <p className={`gv-eyebrow mb-1.5 ${hue ? "text-[var(--plate-accent)]" : ""}`}>
              {eyebrow}
            </p>
          ) : null}
          <h3 className="text-[16px] text-ink">{title}</h3>
        </div>
        {/* The arrow is coloured by `.gv-card-interactive:hover .gv-card-arrow`
            in globals.css, which hands it the brand navy. On a card wearing
            some other hue that leaves the one moving part of the hover state
            disagreeing with the border and the icon plate beside it, so a hued
            card takes the accent off the same plate they read. The trailing `!`
            is what keeps a single class decisive against a three-class
            descendant selector, and `group` is added only on the hued path so a
            card with no hue renders exactly the markup it rendered before. */}
        <ArrowCorner
          className={`gv-card-arrow mt-0.5 shrink-0 ${
            hue
              ? "group-hover:text-[var(--plate-accent)]! group-focus-within:text-[var(--plate-accent)]!"
              : ""
          }`}
        />
      </div>
      {children ? <div className="gv-support mt-2.5">{children}</div> : null}
      {footer ? <div className="gv-micro mt-4">{footer}</div> : null}
    </>
  );

  /* The hover edge is spelled out rather than left to `.gv-card-interactive`,
     whose brand border would contradict the hue the card is already wearing. */
  const hueEdge = hue
    ? "group border-[var(--plate-border)] hover:border-[var(--plate-accent)] focus-within:border-[var(--plate-accent)]"
    : "";
  const classes = `gv-card gv-card-interactive block min-w-0 p-5 no-underline ${hueEdge} ${className ?? ""}`;
  const style = hue ? hueStyle(hue) : undefined;

  if (external) {
    return (
      <a href={href} style={style} className={classes} target="_blank" rel="noreferrer noopener">
        {inner}
      </a>
    );
  }
  return (
    <Link href={href} style={style} className={classes}>
      {inner}
    </Link>
  );
}

const PANEL_TONE = {
  default: "gv-card",
  /** The 14px radius and the raised shadow, for a panel that holds cards. */
  raised: "gv-panel",
  /** A panel cut into a hue's soft plate. The plate comes from `tintedPlate`. */
  tinted: "gv-card",
} as const;

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  tone = "default",
  hue,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** `raised` gives the panel the 14px radius and the raised shadow, for a
   *  panel that holds other cards rather than holding content directly;
   *  `tinted` puts it on the hue's soft plate instead of white. */
  tone?: keyof typeof PANEL_TONE;
  /** A categorical hue name. See the note at the top of this file. */
  hue?: string;
}) {
  return (
    <section
      style={hue ? hueStyle(hue) : undefined}
      className={`${PANEL_TONE[tone]} min-w-0 overflow-hidden ${tone === "tinted" ? tintedPlate(hue) : hue ? "border-[var(--plate-border)]" : ""} ${className ?? ""}`}
    >
      {(title || actions) && (
        <header className="gv-toolbar items-start">
          <div className="min-w-0">
            {title ? <h3 className="text-[15px] text-ink">{title}</h3> : null}
            {description ? <p className="gv-help mt-1">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      )}
      <div className={bodyClassName ?? "p-5"}>{children}</div>
    </section>
  );
}

/**
 * A sunken plane cut into a panel: a payload, a log, a diagram, a preview.
 * Use it instead of nesting a white card inside a white card.
 */
export function Well({
  children,
  className,
  grid = false,
}: {
  children: ReactNode;
  className?: string;
  /** Paints the 16px hairline grid behind the content. For diagrams. */
  grid?: boolean;
}) {
  return (
    <div className={`gv-well min-w-0 ${grid ? "gv-grid-fine" : ""} ${className ?? ""}`}>
      {children}
    </div>
  );
}

/**
 * The visual half of a feature card, or any inline drawing. A tinted plane
 * with an inner hairline, so a diagram sits *in* the card rather than floating
 * on it. Wide contents get their own horizontal scroller.
 */
export function Figure({
  children,
  caption,
  className,
  hue,
  scroll = false,
}: {
  children: ReactNode;
  caption?: ReactNode;
  className?: string;
  /**
   * A categorical hue name, which moves the frame onto that hue's plate. Worth
   * setting whenever the drawing inside is itself hued, so the line work is not
   * one colour sitting on a wash of another.
   *
   * It has no business inside a diagram that distinguishes a language model
   * from deterministic code: teal and navy are a claim about how an answer was
   * reached, and a decorative frame in a third colour makes that reading
   * harder. Frame those in the hue they already argue in, or leave them alone.
   */
  hue?: string;
  scroll?: boolean;
}) {
  return (
    <figure style={hue ? hueStyle(hue) : undefined} className={`min-w-0 ${className ?? ""}`}>
      <div
        className={`gv-figure ${hue ? "border-[var(--plate-border)] bg-[var(--plate)]" : ""} ${scroll ? "gv-scroll-x" : ""} p-4 sm:p-5`}
      >
        {children}
      </div>
      {caption ? <figcaption className="gv-micro mt-2.5">{caption}</figcaption> : null}
    </figure>
  );
}

/**
 * A hairline cell grid: one bordered block subdivided by 1px rules instead of
 * a row of floating cards. Use it when a group of facts has to read as one
 * instrument — a spec strip, a fact row, a four-up of figures.
 *
 * Pass the column counts through `columns`; do NOT add a `gap-*` utility, the
 * 1px gap is the rule itself.
 */
const CELLS_TONE = {
  raised: "",
  tint: "gv-cells-tint",
  /**
   * The cells on a hue's plate, and the 1px rules between them in that hue's
   * edge. The rules are the block's own background showing through a 1px gap,
   * so colouring them means colouring the container — which is why this tone
   * sets a background on the grid itself as well as on every cell.
   *
   * The child selector has to be written as an arbitrary variant because the
   * cells are `children`, not elements this component renders: `.gv-cells > *`
   * in globals.css already paints them white, and only a utility of equal
   * specificity emitted after it can take that back.
   */
  hue: "border-[var(--plate-border,var(--gv-line))] bg-[var(--plate-border,var(--gv-line))] [&>*]:bg-[var(--plate,var(--gv-layer-tint))]",
} as const;

export function Cells({
  children,
  columns = 4,
  tone = "raised",
  raised = false,
  className,
  hue,
  as: Tag = "div",
}: {
  children: ReactNode;
  columns?: 2 | 3 | 4;
  /** `tint` puts the cells on the brand wash instead of white; `hue` puts them
   *  on the plate of whichever categorical hue is in force. */
  tone?: keyof typeof CELLS_TONE;
  /** Adds the raised shadow, for a block that is the point of its section. */
  raised?: boolean;
  className?: string;
  /** A categorical hue name. See the note at the top of this file. */
  hue?: string;
  as?: "div" | "ul" | "dl" | "section";
}) {
  const cols =
    columns === 2
      ? "sm:grid-cols-2"
      : columns === 3
        ? "sm:grid-cols-2 lg:grid-cols-3"
        : "sm:grid-cols-2 lg:grid-cols-4";
  return (
    <Tag
      style={hue ? hueStyle(hue) : undefined}
      className={`gv-cells ${CELLS_TONE[tone]} ${raised ? "gv-cells-raised" : ""} ${cols} ${className ?? ""}`}
    >
      {children}
    </Tag>
  );
}

/**
 * The horizontal scroller a wide table or diagram has to sit in. The page
 * itself must never scroll sideways at 400px; this is where the width goes.
 */
export function ScrollX({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  /** Names the region so a keyboard user knows what they are scrolling. A
   *  scrollable region needs to be focusable to be reachable by keyboard. */
  label?: string;
}) {
  return (
    <div
      className={`gv-scroll-x min-w-0 ${className ?? ""}`}
      role={label ? "region" : undefined}
      aria-label={label}
      tabIndex={label ? 0 : undefined}
    >
      {children}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  lede,
  className,
  id,
  size = "md",
  align = "start",
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  lede?: ReactNode;
  className?: string;
  id?: string;
  /** `lg` is the 48px band head; `md` the default; `sm` a block inside one. */
  size?: "sm" | "md" | "lg";
  align?: "start" | "center";
  actions?: ReactNode;
}) {
  const titleClass = size === "lg" ? "gv-heading" : size === "sm" ? "gv-subheading" : "gv-heading";
  const widthClass = size === "sm" ? "max-w-2xl" : "max-w-3xl";
  return (
    <div
      className={`${widthClass} ${align === "center" ? "mx-auto text-center" : ""} ${className ?? ""}`}
    >
      {eyebrow ? (
        <Eyebrow
          tick={size === "lg" && align === "start"}
          className={`mb-3 text-brand ${align === "center" ? "justify-center" : ""}`}
        >
          {eyebrow}
        </Eyebrow>
      ) : null}
      <h2 id={id} className={size === "md" ? "text-[26px] sm:text-[32px]" : titleClass}>
        {title}
      </h2>
      {lede ? <p className="gv-lede mt-4">{lede}</p> : null}
      {actions ? (
        <div
          className={`mt-6 flex flex-wrap items-center gap-3 ${align === "center" ? "justify-center" : ""}`}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** A key/value row used across every detail view. */
export function DefinitionRow({
  term,
  children,
  mono = false,
}: {
  term: ReactNode;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 border-b border-line py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,12rem)_1fr]">
      <dt className="gv-label pt-px text-ink-3">{term}</dt>
      <dd
        className={`text-[13.5px] text-ink ${mono ? "font-mono text-[12.5px] break-all" : ""}`}
        data-numeric={mono ? "" : undefined}
      >
        {children}
      </dd>
    </div>
  );
}
