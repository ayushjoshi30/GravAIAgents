"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { GravAIWordmark } from "@/brand/Logo";
import { CommandPalette } from "@/components/console/CommandPalette";
import { API_BASE, API_ENV } from "@/lib/api";
import { formatTimeIst } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useConnection } from "@/lib/useResource";

/**
 * The console shell: the sidebar every console route sits beside, the ⌘K
 * palette, the connection and environment chips, and the phone disclosure that
 * carries the same navigation on a narrow screen.
 *
 * Eleven of the twelve items below are the production information architecture,
 * restored after an intermediate version folded them into six destinations named
 * for intent. The fold read well in isolation but cost the two things this
 * console is for: an auditor who has been told to look at the audit explorer
 * wants to see the words "Audit explorer" in the sidebar, and a link to
 * /console/mcp pasted into a ticket has to land on a page with that name at the
 * top of it.
 *
 * "Your agents" is the twelfth, and it is an addition rather than a
 * reordering — every restored item is still exactly where it was. It sits
 * between Agents and Agent Studio because those three read as one run of the
 * same subject, narrowing: the agents GravAI ships, the agents you built, and
 * the place you build them. It is the only one of the three that is yours, and
 * putting it after the builder would have made the builder easier to find than
 * the things it builds.
 *
 * The route list lives in this file. `lib/nav` used to hold it, describing the
 * sidebar is the only thing that renders it and the six-destination table in
 * that module describes an IA the shell no longer draws. Keeping one list, in
 * the file that reads it, is what stops the two drifting apart again.
 */
interface ConsoleNavItem {
  href: string;
  label: string;
}

const NAV: ConsoleNavItem[] = [
  { href: "/console", label: "Overview" },
  { href: "/console/agents", label: "Agents" },
  // The route is /console/workflows because a workflow is what the repo and the
  // API call this object. The label is what a person calls it.
  { href: "/console/workflows", label: "Your agents" },
  { href: "/console/studio", label: "Agent Studio" },
  { href: "/console/runs", label: "Runs" },
  { href: "/console/mcp", label: "MCP" },
  { href: "/console/review", label: "Review queue" },
  { href: "/console/applications", label: "Applications" },
  { href: "/console/usage", label: "Usage" },
  { href: "/console/audit", label: "Audit explorer" },
  { href: "/console/admin", label: "Admin" },
  { href: "/console/settings", label: "Settings" },
];

/**
 * Which sidebar item the current route belongs to.
 *
 * Overview is matched exactly because its href is a prefix of every other one,
 * and a prefix test would light it up on all twelve pages. Everything else
 * matches its own subtree so that a run detail page keeps Runs marked as the
 * current page.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === "/console") return pathname === "/console" || pathname === "/console/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function ConsoleShell({ children, openCount }: { children: ReactNode; openCount?: number }) {
  const pathname = usePathname() ?? "/console";
  const connection = useConnection();

  // The Studio is the only console route that is an application rather than a
  // document. Runs, Usage and Audit are pages a reader scrolls as a whole, and
  // the padded, centred, capped main below is exactly right for them; a canvas
  // is not a page, and has to own the viewport and scroll inside its own panels
  // instead. This single boolean is the whole difference — it changes the class
  // on `<main>` and whether the children are wrapped in the reading-width box,
  // and nothing else in the shell.
  //
  // It is read from the pathname rather than passed down as a prop because the
  // console layout that renders this shell is a server component with no
  // pathname to test, and any layout nested under /console/studio would sit
  // *below* this component and so would have nothing to pass upward. Sniffing
  // the route here is the shorter honest option, and `isActive` already knows
  // how to match a route's own subtree.
  const studioRoute = isActive(pathname, "/console/studio");

  // `reachable` is tri-state on purpose. While the first health check is in
  // flight nobody knows, and `undefined` says so; collapsing that to `false`
  // would flash "Not reachable" at every user on every page load.
  const reachable = connection.status === "checking" ? undefined : connection.status !== "unreachable";
  const session = useSession(reachable);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Esc is the palette's own business — it traps focus, so it is the component
  // that knows whether the key was meant for it.

  // On a phone the sidebar is a disclosure over the page, so it has to close
  // itself once a link has been followed; leaving it open would hide the page
  // the reader just asked for behind the menu they used to ask for it.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  const connectionPill = describeConnection(
    connection.status,
    session.token,
    session.claims?.expired,
    tenantLabel(session),
  );
  const checked = connection.checkedAt ? formatTimeIst(connection.checkedAt) : "not yet";
  const connectionTitle = `${connectionPill.why} API ${API_BASE} (${API_ENV}); last checked ${checked}.`;

  return (
    // The floor under the whole shell. A document route keeps `100vh`, which is
    // what it has always had: for a page that scrolls anyway the unit only
    // decides how far the white reaches on a short page, and leaving it alone
    // keeps the other eleven routes byte-for-byte what they were.
    //
    // The Studio cannot keep it. Its main is sized in `dvh`, and on a phone
    // browser `100vh` is the *tallest* the viewport ever gets — taller than
    // `100dvh` by exactly the height of the address bar. A `100vh` floor under
    // a `100dvh` box makes the document an address bar taller than the window
    // and hands the one route that promises "no page scroll, the panes scroll
    // themselves" a stray inch of page scroll on every phone. Matching the unit
    // to the box is what makes the promise true; on a desktop the two units are
    // the same number, so nothing there moves.
    <div className={studioRoute ? "min-h-[100dvh] bg-white md:flex" : "min-h-screen bg-white md:flex"}>
      <a href="#console-main" className="gv-skip">
        Skip to console content
      </a>

      {/* The phone header. It carries the brand, the connection state and the
          control that reveals the sidebar, because on a narrow screen the
          sidebar is not on the page until it is asked for — and whether this
          console is connected is the one thing a reader should not have to open
          a menu to find out. */}
      <header
        className={`sticky top-0 z-30 h-14 items-center gap-2 border-b border-line-2 bg-white px-4 md:hidden ${
          studioRoute ? "hidden" : "flex"
        }`}
      >
        <Link href="/console" className="flex shrink-0 items-center hover:no-underline" aria-label="Console home">
          <GravAIWordmark height={22} />
        </Link>
        <span className="text-sm font-medium text-ink-3">Console</span>

        <div className="ml-auto flex items-center gap-2">
          <span title={connectionTitle} className="gv-chip gv-chip-outline">
            <span className={`gv-dot ${connectionPill.dot}`} aria-hidden="true" />
            {connectionPill.label}
          </span>
          <button
            type="button"
            onClick={() => setNavOpen((value) => !value)}
            aria-expanded={navOpen}
            aria-controls="console-nav"
            className="flex h-9 items-center rounded-[6px] border border-line bg-surface-2 px-3 text-[13px] font-medium text-ink-2 hover:border-ink-4 hover:bg-white"
          >
            {navOpen ? "Close" : "Menu"}
          </button>
        </div>
      </header>

      {/* The sidebar. On a phone it is a disclosure that opens above the page;
          from `md` up it is a column beside the main area, stuck to the top of
          the viewport with the nav list scrolling inside it, so a short window
          never hides Settings at the bottom of twelve items.

          Its height is `100dvh` rather than `100vh` for the same reason the
          Studio's main is: on a viewport whose chrome slides in and out — a
          tablet wide enough to reach `md` — `100vh` is the tallest the viewport
          ever gets, and a sidebar that tall makes the document taller than the
          window and gives every route a stray inch of scroll. On a desktop the
          two units are the same number, so nothing else moves. */}
      <div
        id="console-nav"
        className={`${
          // THE STUDIO GETS THE WHOLE SCREEN.
          //
          // Every other console route keeps the sidebar, because moving between
          // twelve destinations is most of what a person does in a console. The
          // Studio is not that: it is a canvas, and the 252px the nav costs is
          // 252px of workspace on a laptop — about a fifth of the width, or two
          // node cards. Someone in here is building one thing, not navigating.
          //
          // Hidden rather than unmounted, so the nav's own state and the
          // command palette it hosts stay alive and the sidebar reappears
          // instantly on the way out. The way back is a link in the Studio's own
          // top bar; a full-screen route with no exit is a trap, and this one
          // must never be.
          studioRoute ? "hidden" : navOpen ? "block" : "hidden"
        } border-b border-line-2 bg-surface-2 ${
          studioRoute ? "" : "md:sticky md:top-0 md:flex md:h-[100dvh] md:w-[252px] md:shrink-0 md:flex-col md:border-r md:border-b-0"
        }`}
      >
        <div className="hidden items-center gap-2 px-4 pt-4 pb-3 md:flex">
          <Link href="/console" className="flex shrink-0 items-center hover:no-underline" aria-label="Console home">
            <GravAIWordmark height={24} />
          </Link>
          <span className="text-sm font-medium text-ink-3">Console</span>
        </div>

        {/* The palette lives in the sidebar rather than in the phone header so
            that there is exactly one of it: a second copy would be a second
            place for the shortcut it advertises and the label a screen reader
            hears to drift out of step. On a phone it comes into view with the
            rest of the sidebar, which is also where a person goes to navigate. */}
        <div className="px-4 pt-4 pb-3 md:pt-0">
          <PaletteButton onOpen={() => setPaletteOpen(true)} />
        </div>

        {/* The chips say what a reader is looking at before they read a single
            figure: which deployment, and whether anything on the page can have
            come from it. Each one carries its own word, so none of them relies
            on its colour to be understood. */}
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
          <span title={connectionTitle} className="gv-chip gv-chip-outline hidden md:inline-flex">
            <span className={`gv-dot ${connectionPill.dot}`} aria-hidden="true" />
            {connectionPill.label}
          </span>
          <span className="gv-chip gv-chip-slate" title={`This console is pointed at the ${API_ENV} deployment.`}>
            {API_ENV}
          </span>
          {session.roleLabel ? <span className="gv-chip gv-chip-navy">{session.roleLabel}</span> : null}
        </div>

        <nav aria-label="Console" className="px-2 pb-3 md:flex-1 md:overflow-y-auto">
          <ul className="m-0 list-none p-0">
            {NAV.map((item) => {
              const on = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={on ? "page" : undefined}
                    // The current item carries a left rule and a tint as well
                    // as its own colour, and `aria-current` says the same thing
                    // again to anything that is not reading the colours at all.
                    className={`box-border flex items-center gap-2 rounded-[6px] border-l-[3px] py-2 pr-3 pl-[9px] text-[13.5px] font-medium hover:no-underline ${
                      on
                        ? "border-l-navy bg-navy-tint text-navy-ink"
                        : "border-l-transparent text-ink-2 hover:bg-white"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.href === "/console/review" && openCount ? (
                      <span className="font-mono text-xs text-ink-3">
                        {openCount}
                        <span className="sr-only"> items open</span>
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Which API this console is talking to, in full and in mono, because
            the one question a person asks when a screen is empty is whether it
            was pointed at the right place. */}
        <div className="border-t border-line-2 px-4 py-3 md:mt-auto">
          <p className="gv-eyebrow m-0">API base</p>
          <p className="mt-1 mb-0 break-all font-mono text-[11.5px] leading-relaxed text-ink-3">{API_BASE}</p>
        </div>
      </div>

      <main
        id="console-main"
        // `tabIndex={-1}` is what makes the skip link do what it says: a main
        // element is not focusable on its own, and some browsers move only the
        // scroll position when the fragment lands on something that cannot take
        // focus, leaving a keyboard user back in the sidebar on the next Tab.
        // The focus ring that the global `:focus-visible` rule then draws is
        // left in place on purpose: it is how a keyboard user sees that the
        // skip actually moved them.
        tabIndex={-1}
        className={
          studioRoute
            ? // The application treatment. No padding, because a canvas is
              // drawn to its own edges and the panes beside it carry their own;
              // a locked height, because the Studio lays out three panes that
              // each scroll internally and it cannot do that against a box that
              // is free to grow downward; and `overflow-hidden`, so a pane that
              // overflows scrolls itself rather than lengthening the document.
              //
              // `dvh` rather than `vh` so that a phone's address bar sliding
              // into view shortens the canvas instead of cropping the bottom of
              // it — with `vh` the last inch of the canvas, and whatever sits
              // along it, lives permanently under the browser's own chrome.
              //
              // The 3.5rem taken off below `md` is the phone header's `h-14`.
              // That header is sticky rather than fixed, so it occupies real
              // layout height above this element; taking it off here is what
              // makes the document exactly one viewport tall, which in turn is
              // what keeps the header — and the menu button that reveals the
              // nav — on screen instead of pushed off the top by a main that
              // was a header taller than the window. From `md` up the header is
              // gone and the main sits beside the sidebar, so it takes the
              // whole viewport.
              //
              // `min-h-[560px]` is the floor /build already uses, and it is
              // what keeps the lock from becoming a trap. The Studio spends a
              // fixed share of this box on a toolbar that wraps to three rows
              // on a phone and on the problems footer; below about 560px the
              // remainder is smaller than the test panel's own input block, and
              // because this box clips, the Run button it ends with was drawn
              // outside the clip with no page scroll left to reach it. Under
              // the floor the box stops shrinking, the document grows past the
              // window instead, and the page scrolls to whatever the panes
              // could not fit — which is what a short window did before this
              // route was locked to the viewport at all.
              "box-border h-[calc(100dvh-3.5rem)] min-h-[560px] min-w-0 flex-1 overflow-hidden md:h-[100dvh]"
            : "box-border min-w-0 flex-1 px-[clamp(16px,3vw,32px)] pt-[clamp(16px,3vw,32px)] pb-12"
        }
      >
        {/* A document is centred and capped, because a line of prose or a table
            of runs is unreadable at 2,000px wide. An application is given the
            whole main and decides for itself what to do with the width. */}
        {studioRoute ? children : <div className="mx-auto w-full max-w-[1320px]">{children}</div>}
      </main>

      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  );
}

/**
 * The palette opener.
 *
 * The keyboard hint is hidden from assistive technology rather than read out,
 * because `aria-keyshortcuts` already states the shortcut in the form a screen
 * reader is meant to announce; the glyph beside the label is for the eye.
 */
function PaletteButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Search or jump to"
      aria-keyshortcuts="Meta+K Control+K"
      className="flex h-9 w-full items-center gap-2.5 rounded-[6px] border border-line bg-white px-3 text-[13px] text-ink-3 hover:border-ink-4"
    >
      <span className="flex-1 truncate text-left">Search or jump to…</span>
      <span
        aria-hidden="true"
        className="shrink-0 rounded border border-line-2 bg-surface-2 px-1 font-mono text-[11px]"
      >
        ⌘K
      </span>
    </button>
  );
}

/** A tenant id is a UUID and tells a reader nothing, so show only enough to tell two apart. */
function tenantLabel(session: { tenantName?: string; claims: { tenantId?: string } | null }): string | undefined {
  const name = session.tenantName;
  if (!name) return undefined;
  return name === session.claims?.tenantId ? name.slice(0, 8) : name;
}

/**
 * What the pill says, and why. The order matters: an unreachable API outranks an
 * expired token because a person who fixes the token first will only be told the
 * same thing again.
 *
 * The pill used to read "Example data" when no token was set, because the
 * screens behind it were then filled from a hand-written dossier. They are not
 * any more — without a token this console has nothing to show, and the header
 * says that rather than naming a data source that no longer exists. In a
 * lending-compliance product the header is the one place a reader glances at to
 * decide whether what is on screen can be quoted; it has to be exactly right.
 */
function describeConnection(
  status: "checking" | "connected" | "unreachable" | "no-token",
  token: string | null,
  expired: boolean | undefined,
  tenant: string | undefined,
): { dot: string; label: string; why: string } {
  if (status === "checking") {
    return { dot: "bg-ink-4", label: "Checking", why: "Asking the API whether it is up." };
  }
  if (status === "unreachable") {
    return {
      dot: "bg-bad",
      label: "Not reachable",
      why: "The API did not answer, so the screens have nothing to show and say so.",
    };
  }
  if (expired) {
    return {
      dot: "bg-bad",
      label: "Token expired",
      why: "The API is up but this token is past its expiry; paste a current one in Settings.",
    };
  }
  if (!token) {
    return {
      // Neutral, not teal: teal means a language model is reasoning, and
      // nothing is reasoning here. A missing token is a state of the world,
      // not a fault, so it does not take the fault colour either.
      dot: "bg-ink-4",
      label: "No token",
      why: "The API is up but this browser holds no token, so no screen can show data. Add one in Settings.",
    };
  }
  return { dot: "bg-ok", label: `Live · ${tenant ?? "tenant"}`, why: "Connected." };
}

/**
 * The page header every console route sits under.
 *
 * The props are unchanged from the shell this replaced, because a dozen routes
 * already call it and a rename would have bought nothing but a dozen edits in
 * files four other people are holding open.
 */
export function ConsolePage({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="gv-page-title">{title}</h1>
          {description ? (
            <p className="mt-1.5 max-w-3xl text-[13.5px] leading-relaxed text-ink-2">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}
