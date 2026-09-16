import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowCorner } from "@/components/ui/Button";

/**
 * Containers.
 *
 * There are four planes in this product — the page ground, a raised panel, an
 * elevated card and a sunken well — and five card roles on top of them:
 *
 *   default      a white card on the page. The workhorse.
 *   elevated     the one card in a section that carries the argument.
 *   secondary    supporting information that must recede.
 *   metric       a figure and its label, with a brand rule down the left edge.
 *   interactive  the whole surface is a link: lifts 3px, border goes brand,
 *                any `gv-card-arrow` inside travels.
 *   feature      a visual and its text, on a brand-tinted ground.
 *
 * The visual definition of each lives in globals.css (`.gv-card`,
 * `.gv-card-elevated`, …) so a plain `<div className="gv-card gv-card-metric">`
 * anywhere in the app looks identical to one built from this file.
 */

export type CardVariant =
  | "default"
  | "elevated"
  | "secondary"
  | "metric"
  | "interactive"
  | "feature";

const CARD_VARIANT: Record<CardVariant, string> = {
  default: "",
  elevated: "gv-card-elevated",
  secondary: "gv-card-secondary",
  metric: "gv-card-metric",
  interactive: "gv-card-interactive",
  feature: "gv-card-feature",
};

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
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
  variant?: CardVariant;
}) {
  return (
    <Tag className={`gv-card min-w-0 ${CARD_VARIANT[variant]} ${className ?? ""}`}>{children}</Tag>
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
  external = false,
}: {
  href: string;
  eyebrow?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
  className?: string;
  external?: boolean;
}) {
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {icon ? <span className="gv-icon-plate mb-3.5">{icon}</span> : null}
          {eyebrow ? <p className="gv-eyebrow mb-1.5">{eyebrow}</p> : null}
          <h3 className="text-[16px] text-ink">{title}</h3>
        </div>
        <ArrowCorner className="gv-card-arrow mt-0.5 shrink-0" />
      </div>
      {children ? <div className="gv-support mt-2.5">{children}</div> : null}
      {footer ? <div className="gv-micro mt-4">{footer}</div> : null}
    </>
  );

  const classes = `gv-card gv-card-interactive block min-w-0 p-5 no-underline ${className ?? ""}`;

  if (external) {
    return (
      <a href={href} className={classes} target="_blank" rel="noreferrer noopener">
        {inner}
      </a>
    );
  }
  return (
    <Link href={href} className={classes}>
      {inner}
    </Link>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  tone = "default",
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** `raised` gives the panel the 14px radius and the raised shadow, for a
   *  panel that holds other cards rather than holding content directly. */
  tone?: "default" | "raised";
}) {
  return (
    <section
      className={`${tone === "raised" ? "gv-panel" : "gv-card"} min-w-0 overflow-hidden ${className ?? ""}`}
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
  scroll = false,
}: {
  children: ReactNode;
  caption?: ReactNode;
  className?: string;
  scroll?: boolean;
}) {
  return (
    <figure className={`min-w-0 ${className ?? ""}`}>
      <div className={`gv-figure ${scroll ? "gv-scroll-x" : ""} p-4 sm:p-5`}>{children}</div>
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
export function Cells({
  children,
  columns = 4,
  tone = "raised",
  raised = false,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  columns?: 2 | 3 | 4;
  /** `tint` puts the cells on the brand wash instead of white. */
  tone?: "raised" | "tint";
  /** Adds the raised shadow, for a block that is the point of its section. */
  raised?: boolean;
  className?: string;
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
      className={`gv-cells ${tone === "tint" ? "gv-cells-tint" : ""} ${raised ? "gv-cells-raised" : ""} ${cols} ${className ?? ""}`}
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
