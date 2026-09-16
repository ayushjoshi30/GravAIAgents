"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { GravAIWordmark } from "@/brand/Logo";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { Arrow } from "@/components/ui/Button";
import { AGENTS, TIERS } from "@/lib/agents";

const NAV = [
  { href: "/platform", label: "Platform" },
  { href: "/agents", label: "Agents", menu: true },
  { href: "/how-it-works", label: "How it works" },
  { href: "/security", label: "Security" },
  { href: "/docs", label: "Docs" },
];

/**
 * Two things the design system has no vocabulary for, both scoped to this
 * component so nothing else can pick them up by accident.
 *
 * 1. The bottom edge strengthens as the page scrolls. It is a scroll-driven
 *    animation, not a scroll listener: no state, no re-render, no client JS
 *    beyond the menu logic that was already here. The whole thing sits behind
 *    `@supports`, so a browser without scroll timelines simply keeps the
 *    resting edge — which is the correct fallback, not a broken one.
 *
 *    The global `prefers-reduced-motion` block forces a 0.01ms duration on
 *    every animation. On a progress-based timeline that collapses the ramp to
 *    a step, so a reduced-motion user gets the strengthened edge immediately
 *    instead of a gradient of it. That is the right outcome: the edge is a
 *    state signal, and the signal survives.
 *
 * 2. The arrow on an action travels 3px on hover, matching `.gv-link-arrow`
 *    from the design system. Written here rather than as utilities because
 *    two competing transform utilities on one element resolve by stylesheet
 *    order, which is not something to leave to chance.
 */
const HEADER_CSS = `
.gv-header-arrow > svg:last-child {
  transition: transform var(--gv-dur) var(--gv-ease);
}
.gv-header-arrow:hover > svg:last-child {
  transform: translateX(3px);
}
@supports (animation-timeline: scroll()) {
  @keyframes gv-header-settle {
    from {
      background-color: rgb(255 255 255 / 0.85);
      border-bottom-color: var(--gv-line);
      box-shadow:
        0 1px 0 0 rgb(20 40 78 / 0),
        0 6px 16px -10px rgb(20 40 78 / 0);
    }
    to {
      background-color: rgb(255 255 255 / 0.93);
      border-bottom-color: var(--gv-line-strong);
      box-shadow:
        0 1px 0 0 rgb(20 40 78 / 0.04),
        0 6px 16px -10px rgb(20 40 78 / 0.3);
    }
  }
  .gv-site-header {
    animation-name: gv-header-settle;
    animation-timing-function: linear;
    animation-fill-mode: both;
    animation-timeline: scroll(root block);
    animation-range: 0 72px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .gv-header-arrow:hover > svg:last-child {
    transform: none;
  }
}
`;

/**
 * The dropdown indicator, drawn here rather than taken from the icon set: at
 * 14px a 24-grid chevron wants a shallower angle and a shorter span than the
 * general-purpose one, and `AgentIcon.tsx` is not this component's to edit.
 * Same rules as the set — 24x24 grid, 1.4 stroke, square caps, no fill.
 */
function Chevron({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M6.75 9.75 12 15l5.25-5.25" />
    </svg>
  );
}

/**
 * "Document Intelligence Agent" is the catalog name, but in a list of fourteen
 * the word "Agent" is on every line and carries nothing. Drop it — unless that
 * would leave a single bare word, where the full name reads better.
 */
function menuLabel(name: string) {
  const short = name.replace(/\s+Agent$/, "");
  return short.includes(" ") ? short : name;
}

/**
 * The menu is grouped the way /agents is grouped, so the two never tell a
 * different story. P1 carries eight agents and takes two columns; the others
 * take one, which is what keeps every column four rows or fewer.
 */
const TIER_COLUMNS = TIERS.map((tier) => {
  const [code, rest] = tier.label.split("—");
  return {
    tier: tier.tier,
    code: code.trim(),
    heading: (rest ?? "").trim() || tier.label,
    agents: AGENTS.filter((agent) => agent.tier === tier.tier),
  };
});

/**
 * State is carried by a soft brand ground AND a brand edge AND `aria-current`,
 * never by hue on its own.
 */
const NAV_ITEM =
  "rounded-lg border px-3 py-2 text-[13.5px] font-medium transition-colors duration-150 ease-gv";
const NAV_ACTIVE = "border-brand-100 bg-brand-50 text-brand";
const NAV_IDLE = "border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink";
/** The Agents trigger while its panel is down, on a page that is not /agents. */
const NAV_TRIGGER_OPEN = "border-transparent bg-surface-2 text-ink";

const MOBILE_ITEM =
  "block rounded-lg border px-3 py-2.5 text-[14px] font-medium transition-colors duration-150 ease-gv";

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const openMenu = useCallback(() => {
    cancelClose();
    setMenuOpen(true);
  }, [cancelClose]);

  /**
   * The trigger and the panel are separate boxes with a gap between them, so a
   * leave fires while the pointer is in transit. The delay is what lets the
   * pointer cross it.
   */
  const closeMenu = useCallback(
    (delay = 0) => {
      cancelClose();
      if (delay === 0) {
        setMenuOpen(false);
        return;
      }
      closeTimer.current = window.setTimeout(() => setMenuOpen(false), delay);
    },
    [cancelClose],
  );

  useEffect(() => cancelClose, [cancelClose]);

  useEffect(() => {
    setOpen(false);
    setAgentsOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  const hover = {
    onMouseEnter: openMenu,
    onMouseLeave: () => closeMenu(140),
  };

  return (
    <header className="gv-site-header sticky top-0 z-40 border-b border-line bg-surface backdrop-blur-xl backdrop-saturate-150 supports-[backdrop-filter]:bg-surface/85">
      <style>{HEADER_CSS}</style>

      <div className="relative mx-auto flex h-16 max-w-[1240px] items-center gap-4 px-5 sm:px-6 lg:gap-5">
        <Link
          href="/"
          className="-mx-2 flex shrink-0 items-center rounded-lg px-2 py-1.5 transition-colors duration-150 ease-gv hover:bg-brand-50"
          aria-label="GravAI — home"
        >
          <GravAIWordmark height={32} />
        </Link>

        {/* The join between identity and navigation, stated quietly. */}
        <span
          aria-hidden="true"
          className="hidden h-7 w-px shrink-0 bg-gradient-to-b from-transparent via-line-strong to-transparent lg:block"
        />

        <nav aria-label="Primary" className="hidden flex-1 items-center gap-0.5 lg:flex">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const className = `${NAV_ITEM} ${active ? NAV_ACTIVE : NAV_IDLE}`;

            if (!item.menu) {
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={className}
                >
                  {item.label}
                </Link>
              );
            }

            return (
              // Full header height, so the pointer never leaves the trigger on
              // its way down to a panel that starts at the header's edge.
              <div
                key={item.href}
                className="flex h-16 items-center"
                {...hover}
                onFocus={openMenu}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    closeMenu();
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && menuOpen) {
                    closeMenu();
                    triggerRef.current?.focus();
                  }
                }}
              >
                <Link
                  ref={triggerRef}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  aria-haspopup="true"
                  aria-expanded={menuOpen}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      openMenu();
                    }
                  }}
                  // Built from one exclusive branch rather than by appending an
                  // override: two competing colour utilities on one element
                  // resolve by stylesheet order, not by class order.
                  className={`inline-flex items-center gap-1.5 ${NAV_ITEM} ${
                    active ? NAV_ACTIVE : menuOpen ? NAV_TRIGGER_OPEN : NAV_IDLE
                  }`}
                >
                  {item.label}
                  <Chevron
                    className={`shrink-0 transition-transform duration-200 ease-gv ${
                      menuOpen ? "-rotate-180 text-brand" : "text-ink-3"
                    }`}
                  />
                </Link>

                {menuOpen ? (
                  <div
                    {...hover}
                    className="gv-menu-in absolute left-5 right-5 top-full mt-1.5 max-w-[1040px] overflow-hidden rounded-2xl border border-line bg-surface shadow-overlay sm:left-6 sm:right-6"
                  >
                    {/* One bordered block subdivided by hairlines, rather than
                        four floating groups: the tiers read as one catalog. */}
                    <div className="grid grid-cols-4 p-3">
                      {TIER_COLUMNS.map((column, index) => {
                        const wide = column.agents.length > 4;
                        return (
                          <div
                            key={column.tier}
                            className={`min-w-0 px-2 ${index > 0 ? "border-l border-line" : ""} ${
                              wide ? "col-span-2" : ""
                            }`}
                          >
                            <p className="flex items-center gap-2 px-2 pb-2.5">
                              <span className="shrink-0 rounded border border-brand-100 bg-brand-50 px-1.5 py-px font-mono text-[10px] font-semibold tracking-[0.06em] text-brand">
                                {column.code}
                              </span>
                              <span className="gv-eyebrow truncate">{column.heading}</span>
                            </p>
                            <ul className={wide ? "grid grid-cols-2 gap-x-1" : undefined}>
                              {column.agents.map((agent) => (
                                <li key={agent.id}>
                                  <Link
                                    href={`/agents/${agent.id}`}
                                    className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-150 ease-gv hover:bg-brand-50"
                                  >
                                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-ink-3 transition-colors duration-150 ease-gv group-hover:border-brand-200 group-hover:bg-surface group-hover:text-brand">
                                      <AgentIcon id={agent.id} size={15} />
                                    </span>
                                    <span className="min-w-0 text-[12.5px] font-medium leading-snug text-ink-2 transition-colors duration-150 ease-gv group-hover:text-brand">
                                      {menuLabel(agent.name)}
                                    </span>
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line bg-surface-2 px-5 py-2.5">
                      <Link
                        href="/agents"
                        className="gv-header-arrow inline-flex items-center gap-1.5 rounded text-[12.5px] font-semibold text-brand transition-colors duration-150 ease-gv hover:text-brand-600"
                      >
                        All {AGENTS.length} agents
                        <Arrow />
                      </Link>
                      <Link
                        href="/docs/agent-reference"
                        className="rounded text-[12.5px] font-medium text-ink-3 transition-colors duration-150 ease-gv hover:text-brand"
                      >
                        Agent reference
                      </Link>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/console"
            className="gv-btn gv-btn-primary gv-header-arrow hidden h-9 items-center gap-1.5 border px-3.5 text-[13px] sm:inline-flex"
          >
            Open console
            <Arrow />
          </Link>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close navigation" : "Open navigation"}
            className="gv-btn inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 shadow-resting hover:border-brand-300 hover:bg-brand-50 hover:text-brand lg:hidden"
          >
            <Icon name={open ? "close" : "menu"} size={16} />
          </button>
        </div>
      </div>

      {open ? (
        <nav
          id="mobile-nav"
          aria-label="Primary, mobile"
          className="max-h-[calc(100dvh-4rem)] overflow-y-auto border-t border-line bg-surface shadow-raised lg:hidden"
        >
          <ul className="mx-auto max-w-[1240px] space-y-1 px-4 py-4 sm:px-6">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const className = `${MOBILE_ITEM} ${
                active
                  ? "border-brand-100 bg-brand-50 text-brand"
                  : "border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink"
              }`;

              if (!item.menu) {
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={className}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              }

              return (
                <li key={item.href}>
                  <div className="flex items-center gap-1">
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`flex-1 ${className}`}
                    >
                      {item.label}
                    </Link>
                    <button
                      type="button"
                      onClick={() => setAgentsOpen((value) => !value)}
                      aria-expanded={agentsOpen}
                      aria-controls="mobile-agents"
                      aria-label={agentsOpen ? "Hide the agent list" : "Show the agent list"}
                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-transparent text-ink-3 transition-colors duration-150 ease-gv hover:border-line hover:bg-surface-2 hover:text-brand"
                    >
                      <Chevron
                        size={16}
                        className={`transition-transform duration-200 ease-gv ${
                          agentsOpen ? "-rotate-180 text-brand" : ""
                        }`}
                      />
                    </button>
                  </div>

                  {agentsOpen ? (
                    <ul
                      id="mobile-agents"
                      className="mt-1 ml-3 space-y-0.5 border-l-2 border-brand-100 pl-2.5"
                    >
                      {AGENTS.map((agent) => (
                        <li key={agent.id}>
                          <Link
                            href={`/agents/${agent.id}`}
                            className="group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-ink-2 transition-colors duration-150 ease-gv hover:bg-brand-50 hover:text-brand"
                          >
                            <AgentIcon
                              id={agent.id}
                              size={15}
                              className="shrink-0 text-ink-3 transition-colors duration-150 ease-gv group-hover:text-brand"
                            />
                            {menuLabel(agent.name)}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
            <li className="pt-2">
              <Link
                href="/console"
                className="gv-btn gv-btn-primary gv-header-arrow flex h-11 w-full items-center justify-center gap-1.5 border text-[14px]"
              >
                Open console
                <Arrow />
              </Link>
            </li>
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
