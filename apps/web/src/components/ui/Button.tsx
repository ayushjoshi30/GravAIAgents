"use client";

import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Buttons. Four variants, four sizes, one definition.
 *
 * Primary is brand blue with white text and a brand-tinted shadow that lifts
 * on hover; secondary is white with a brand border and brand text; ghost is
 * chrome-free for toolbars; danger is reserved for destructive or rejecting
 * actions. Nothing in the product styles a button inline.
 *
 * The visual definition of each variant lives in globals.css as `.gv-btn`
 * plus `.gv-btn-<variant>`, so the same chassis can be reused by anything
 * that has to look like a button but is not this component — and so the
 * inverse band can flip the primary without this file knowing about it.
 */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg" | "xl";

const BASE =
  "gv-btn inline-flex items-center justify-center gap-1.5 border font-medium disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

const VARIANT: Record<Variant, string> = {
  primary: "gv-btn-primary",
  secondary: "gv-btn-secondary",
  ghost: "gv-btn-ghost",
  danger: "gv-btn-danger",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-[12.5px]",
  md: "h-9 px-3.5 text-[13.5px]",
  lg: "h-11 px-5 text-[14.5px]",
  xl: "h-12 px-6 text-[15px]",
};

function classesFor(variant: Variant, size: Size, className?: string) {
  return `${BASE} ${VARIANT[variant]} ${SIZE[size]} ${className ?? ""}`;
}

export function Button({
  children,
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
}) {
  return (
    <button type="button" className={classesFor(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "secondary",
  size = "md",
  className,
  external = false,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  className?: string;
  external?: boolean;
}) {
  const classes = classesFor(variant, size, className);
  if (external) {
    return (
      <a href={href} className={classes} target="_blank" rel="noreferrer noopener" {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={classes} {...rest}>
      {children}
    </Link>
  );
}

/** Compact icon-only control for toolbars and table rows. */
export function IconButton({
  children,
  label,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`gv-btn inline-flex h-9 w-9 items-center justify-center border border-line bg-surface text-ink-2 shadow-resting hover:border-brand-300 hover:bg-brand-50 hover:text-brand ${className ?? ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * A text link that reads as an action: brand, medium, with an arrow that
 * travels on hover. Use instead of a secondary button when the link sits in
 * running text or at the bottom of a card.
 */
export function TextLink({
  href,
  children,
  className,
  external = false,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  external?: boolean;
}) {
  const classes = `gv-link gv-link-arrow text-[14px] ${className ?? ""}`;
  const content = (
    <>
      {children}
      <Arrow />
    </>
  );
  if (external) {
    return (
      <a href={href} className={classes} target="_blank" rel="noreferrer noopener">
        {content}
      </a>
    );
  }
  return (
    <Link href={href} className={classes}>
      {content}
    </Link>
  );
}

export function Arrow({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        d="M2.5 7h9M7.8 3.5 11.3 7l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The diagonal arrow used on an interactive card, drawn to the same rules as
 * the icon set: 24x24 grid scaled down, 1.4 stroke, square caps, no fill.
 * Give it the `gv-card-arrow` class so the parent card animates it.
 */
export function ArrowCorner({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        d="M7 17 17 7M8.5 7H17v8.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
