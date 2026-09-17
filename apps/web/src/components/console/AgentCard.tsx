"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import { FlowThumbnail, type FlowThumbnailNode } from "@/components/console/FlowThumbnail";
import {
  api,
  FAILURE_COPY,
  type ApiFailure,
  type WorkflowCard,
  type WorkflowRow,
  type WorkflowThumbnailNode,
} from "@/lib/api";
import { formatDateTimeIst } from "@/lib/format";
import { useToken } from "@/lib/session";

/**
 * One workflow on the "Your agents" page, as a card or as a list row.
 *
 * The page is called "Your agents" and the thing is called a workflow, because
 * that is what the engine, the API and every other file in this repo call it.
 * The two names are not reconciled here on purpose: renaming the code to match
 * the label would touch the studio, the router and the generated catalog, and
 * the label is the only place a person ever reads the word.
 *
 * WHAT THIS COMPONENT IS ALLOWED TO CLAIM. Every count, name and date on a card
 * comes from the row the server sent. Nothing is derived, inferred or filled in
 * from a sensible-looking default: a card that said "9 connections" because it
 * counted the edges it happened to be given would be wrong the moment the
 * thumbnail is truncated, and wrong in a way nobody would think to check.
 */

/* ---------- where a card points ---------- */

/**
 * Where a card points.
 *
 * Exported so the page, the command palette and anything else that opens a
 * workflow spell the link one way. The studio reads the workflow to open from
 * the query string; if that ever moves to a path segment, it moves here once
 * rather than in every caller.
 */
export function studioHref(id: string): string {
  return `/console/studio?workflow=${encodeURIComponent(id)}`;
}

/* ---------- the row, and the calls a row makes ---------- */

/**
 * Both come from `lib/api.ts` rather than being declared here.
 *
 * `WorkflowCard` is the payload the page, this card and the create dialog all
 * have to agree about, and `api.renameWorkflow` and friends are the only calls
 * this component makes. A second copy of either in this file would be a second
 * description of one endpoint, which stays correct exactly until the first time
 * somebody changes the other one.
 *
 * Worth knowing about two of them. `renameWorkflow` answers with a
 * `WorkflowRow` — no thumbnail, because a rename does not touch the graph — so
 * the rename path below propagates a row and not a card. And ownership is
 * enforced server-side by answering 404 for a workflow that is not the
 * caller's, never 403, so there is no "forbidden" case to handle: not yours and
 * not there are the same answer, which is the point of it.
 */


/**
 * What went wrong, in one line, with the two things that make it actionable.
 *
 * The status and the correlation id are printed because "Rename failed" on its
 * own tells someone only that they should try again, while a 409 and a
 * correlation id tell them what to try instead and gives support something to
 * search for. `FAILURE_COPY` is the fallback rather than the lead: the API's own
 * message ("A workflow with this name already exists") is almost always the
 * more useful sentence.
 */
function failureLine(what: string, failure: ApiFailure): string {
  const said = failure.message?.trim() || FAILURE_COPY[failure.kind];
  const status = failure.status ? ` (HTTP ${failure.status})` : "";
  const correlation = failure.correlationId ? ` · correlation ${failure.correlationId}` : "";
  return `${what} — ${said}${status}${correlation}`;
}

/* ---------- time ---------- */

const RELATIVE = new Intl.RelativeTimeFormat("en-IN", { numeric: "auto" });
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Parse an API timestamp, treating a missing zone as UTC.
 *
 * Every timestamp column in this platform is `DateTime(timezone=True)` and every
 * value in them is UTC, so a string that arrives without a zone designator is
 * UTC that lost its suffix somewhere — not local time. `new Date()` would read
 * it as local, which in IST reports everything as five and a half hours older
 * than it is: "Edited 6 hours ago" for something saved thirty minutes back. A
 * wrong date is worse than no date, so this is worth the four lines.
 */
function parseApiTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const date = new Date(zoned);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * "2 hours ago", in the units a person would have used.
 *
 * `Intl.RelativeTimeFormat` rather than a hand-rolled ladder, so "1 day ago"
 * comes out as "yesterday" and nothing is ever pluralised wrongly. A timestamp
 * in the future is clock skew between this browser and the API, not a fact
 * about the workflow, so it is reported as "just now" rather than as "in 3
 * minutes" — the exact value is one hover away on the `title`.
 */
function relativeTime(date: Date, now: number): string {
  const elapsed = now - date.getTime();
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return RELATIVE.format(-Math.round(elapsed / MINUTE), "minute");
  if (elapsed < DAY) return RELATIVE.format(-Math.round(elapsed / HOUR), "hour");
  if (elapsed < 30 * DAY) return RELATIVE.format(-Math.round(elapsed / DAY), "day");
  if (elapsed < 365 * DAY) return RELATIVE.format(-Math.round(elapsed / (30 * DAY)), "month");
  return RELATIVE.format(-Math.round(elapsed / (365 * DAY)), "year");
}

/**
 * "Edited 2 hours ago", with the exact IST timestamp on hover.
 *
 * Takes a parsed `Date` rather than the raw string: the caller has to know
 * whether a date exists before it draws the separator in front of one, so the
 * parse happens there and the result is passed in rather than done twice. A row
 * whose `updated_at` this browser cannot read renders no date at all — printing
 * "Edited just now" for it would be inventing the one fact it lacks.
 */
function EditedAt({ at }: { at: Date }) {
  const date = at;
  return (
    <time
      dateTime={date.toISOString()}
      title={formatDateTimeIst(date)}
      /* The relative label is computed from this browser's clock, so a server
         render and the hydration that follows can legitimately disagree by a
         minute. In practice cards never render on the server — the list needs
         a token out of localStorage — but the warning would be noise rather
         than a signal if they ever did. */
      suppressHydrationWarning
    >
      Edited {relativeTime(date, Date.now())}
    </time>
  );
}

/* ---------- the thumbnail's nodes ---------- */

/**
 * The API's thumbnail nodes in the shape `FlowThumbnail` takes.
 *
 * The two disagree on one point: the API declares `x` and `y` nullable, because
 * a node saved by something other than the canvas may carry no position, while
 * the drawing declares them plain numbers. A missing
 * coordinate becomes `NaN` rather than `0` — deliberately, and not as a way of
 * passing the type check. `FlowThumbnail` drops any node whose coordinates are
 * not finite from the DRAWING while still counting it in the description it
 * announces, which is the honest handling of "this step exists and we do not
 * know where its author put it". Substituting `0` would instead place the step
 * somewhere nobody put it and drag the whole bounding box to the origin with
 * it, so a graph would be drawn wrong rather than drawn short.
 */
function drawable(nodes: WorkflowThumbnailNode[]): FlowThumbnailNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type,
    x: node.x ?? Number.NaN,
    y: node.y ?? Number.NaN,
  }));
}

/* ---------- counts ---------- */

/** "8 steps · 9 connections", and "1 step · 1 connection" when it is one. */
function countsLine(nodes: number, edges: number): string {
  const steps = `${nodes} ${nodes === 1 ? "step" : "steps"}`;
  const connections = `${edges} ${edges === 1 ? "connection" : "connections"}`;
  return `${steps} · ${connections}`;
}

/* ---------- motion ---------- */

/**
 * True when the reader has asked for less motion.
 *
 * Read in JavaScript rather than left to the stylesheet because the countdown
 * on the undo toast is drawn from state, not from a CSS animation, and the
 * global reduced-motion block has nothing to switch off. Reduced motion must
 * STOP the bar, so the bar is not rendered at all — the same information stays
 * on screen as a number of seconds, which changes once a second and does not
 * move.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/* ---------- the "..." menu ---------- */

function MoreGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="3.5" cy="8" r="1.35" fill="currentColor" />
      <circle cx="8" cy="8" r="1.35" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.35" fill="currentColor" />
    </svg>
  );
}

interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /**
   * Whether closing the menu should hand focus back to the "..." button.
   *
   * True for anything that leaves the card standing, so a keyboard user is put
   * back where they were. False for the two that do not: Rename gives focus to
   * the field it opens, and Delete gives it to the Undo on the toast, because
   * in both cases the button focus would return to is about to be replaced or
   * removed.
   */
  returnFocus?: boolean;
}

/**
 * The card's own menu, and the reason it is a sibling of the link rather than
 * a child of it.
 *
 * A `<button>` inside an `<a>` is invalid HTML. Browsers do not agree on what
 * to do with it: some fire the click on both, some swallow the button's click
 * entirely, and the accessibility tree ends up describing one control where
 * there are two. So the card's link is the name, stretched over the card by a
 * pseudo-element, and this button sits above that pseudo-element in the
 * stacking order. Two controls, two tab stops, two focus rings, no nesting.
 */
function CardMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    // Closing on scroll rather than repositioning: the menu is anchored to a
    // card in a grid that scrolls, and a menu left floating beside the wrong
    // card is worse than one that went away.
    const onScroll = () => setOpen(false);

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close]);

  // Roving focus with the arrow keys, which is what `role="menu"` promises a
  // screen reader the moment it is announced.
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const nodes = Array.from(
      wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (nodes.length === 0) return;
    const at = nodes.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = at === -1 ? (step === 1 ? 0 : nodes.length - 1) : (at + step + nodes.length) % nodes.length;
    nodes[next]?.focus();
  };

  return (
    /* `relative z-10` is what lifts the whole menu above the stretched link's
       pseudo-element. Without it the link covers the button and the menu can
       be tabbed to but not clicked. */
    <div ref={wrap} className="relative z-10 shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="gv-btn flex h-8 w-8 items-center justify-center rounded-md border border-transparent bg-transparent text-ink-3 hover:border-line hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand aria-expanded:border-line aria-expanded:bg-surface-2 aria-expanded:text-ink"
      >
        <MoreGlyph />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className="gv-menu-in gv-overlay absolute right-0 top-full z-20 mt-1.5 w-44 overflow-hidden border border-line py-1"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                // Close before acting: several of these unmount or replace what
                // is under the menu, and a menu still painted over a card that
                // has gone is a menu pointing at nothing.
                close(item.returnFocus ?? true);
                item.onSelect();
              }}
              className={`block w-full px-3 py-2 text-left text-[13px] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand ${
                item.danger ? "text-red" : "text-ink-2"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- the undo toast ---------- */

const UNDO_MS = 8_000;

/**
 * The strip that offers Undo after a delete, portalled to the body.
 *
 * It is a portal rather than a toast in `primitives.tsx` because that store
 * carries a message and nothing else — it has no room for a control, and an
 * "Undo" that is only a word is not an undo. Portalling to the body keeps it
 * clear of the card grid's stacking and scrolling while leaving it inside this
 * component's React tree, which is what lets the card own the timer that
 * decides whether the delete becomes final.
 */
function UndoToast({
  name,
  confirmed,
  remainingMs,
  onUndo,
  busy,
}: {
  name: string;
  /** True once the server has answered the DELETE. Until then there is nothing
   *  to undo, and saying "Deleted" would be reporting a state nobody confirmed. */
  confirmed: boolean;
  remainingMs: number;
  onUndo: () => void;
  busy: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const undoRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  /* The control that had focus was inside the card, and the card has gone — so
     without this, focus falls to the body and a keyboard user has lost their
     place and cannot reach the undo they have eight seconds to use. Taking
     focus is right here for the same reason it is usually wrong: the thing the
     person was on no longer exists. */
  useEffect(() => {
    if (confirmed) undoRef.current?.focus();
  }, [confirmed]);

  if (!mounted) return null;

  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const pct = Math.max(0, Math.min(100, (remainingMs / UNDO_MS) * 100));

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-50 w-[min(460px,calc(100vw-32px))] -translate-x-1/2"
    >
      <div className="overflow-hidden rounded-lg bg-ink text-white shadow-lg">
        <div className="flex items-center gap-3 px-3.5 py-3 text-[13px]">
          <span className="min-w-0 flex-1 leading-snug">
            {confirmed ? "Deleted " : "Deleting "}
            <span className="font-medium">{name}</span>
            {confirmed ? "." : "…"}
          </span>
          {/* No Undo until there is something to undo. A button offered while
              the DELETE is still in flight would be a restore racing a delete,
              and whichever won would be a coin toss the person could not see. */}
          {confirmed ? (
            <button
              ref={undoRef}
              type="button"
              onClick={onUndo}
              disabled={busy}
              className="rounded-md border border-white/30 px-2.5 py-1 text-[12.5px] font-medium text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-60"
            >
              {busy ? "Restoring…" : `Undo · ${seconds}s`}
            </button>
          ) : null}
        </div>
        {/* The bar is the only moving thing here, so reduced motion removes it
            rather than shortening it. The seconds on the button carry the same
            information and do not move. */}
        {confirmed && !reduced ? (
          <div className="h-0.5 bg-white/15">
            <div className="h-full bg-white/70" style={{ width: `${pct}%` }} />
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/* ---------- the card ---------- */

export type AgentCardView = "grid" | "list";

export interface AgentCardProps {
  workflow: WorkflowCard;
  /** Same data, two densities. There is no second component. */
  view?: AgentCardView;
  /**
   * The row as it now stands, after the server confirmed a change made from
   * this card. A rename reports through it, and so does an undone delete: both
   * are "the server has a newer version of this row than you do", and the page
   * does the same thing with either — replace the row with this id.
   */
  onRenamed?: (workflow: WorkflowRow) => void;
  /** The copy the server made. The page inserts it; nothing opens it. */
  onDuplicated?: (workflow: WorkflowCard) => void;
  /** Called when the delete is FINAL — the undo window closed without an undo. */
  onDeleted?: (workflow: WorkflowCard) => void;
}

export function AgentCard({
  workflow,
  view = "grid",
  onRenamed,
  onDuplicated,
  onDeleted,
}: AgentCardProps) {
  const [token] = useToken();
  const router = useRouter();
  const list = view === "list";

  /* The name shown is optimistic: it changes the moment Enter is pressed and
     goes back to `workflow.name` if the server refuses. `workflow.name` is the
     last name the server confirmed, so a rollback is just dropping this. */
  const [pendingName, setPendingName] = useState<string | null>(null);
  const name = pendingName ?? workflow.name;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(workflow.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState(false);

  /**
   * How far through being deleted this card is.
   *
   * The card stops drawing itself the moment Delete is chosen, which is what
   * "the card leaves immediately" asks for, but it stays MOUNTED — that is what
   * lets it own the undo timer and the toast, and it is why `onDeleted` can be
   * the single moment the row really goes. The page is never asked to take back
   * a row it has already dropped.
   *
   * `pending` and `staged` are separate because the countdown must not start
   * until the server has agreed the thing is deleted. Running one clock from
   * the click would mean a slow DELETE spends most of the undo window in
   * flight, and a DELETE that took longer than eight seconds would see
   * `onDeleted` fire — the row removed from the page — for a request that might
   * still come back a failure, with nowhere left to report it.
   */
  const [stage, setStage] = useState<"idle" | "pending" | "staged" | "gone">("idle");
  const [remaining, setRemaining] = useState(UNDO_MS);
  const [restoring, setRestoring] = useState(false);
  const reduced = usePrefersReducedMotion();

  const inputRef = useRef<HTMLInputElement>(null);
  const menuLabel = `Actions for ${name}`;

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startRename = useCallback(() => {
    setDraft(pendingName ?? workflow.name);
    setNameError(null);
    setNotice(null);
    setEditing(true);
  }, [pendingName, workflow.name]);

  const commitRename = useCallback(async () => {
    const next = draft.trim();
    // Rejected out loud. An empty name that simply closed the editor would look
    // exactly like a rename that worked and then quietly did not.
    if (!next) {
      setNameError("A name is required. Type one, or press Escape to keep the old name.");
      inputRef.current?.focus();
      return;
    }
    if (next === (pendingName ?? workflow.name)) {
      setEditing(false);
      setNameError(null);
      return;
    }

    const previous = pendingName;
    setEditing(false);
    setNameError(null);
    setNotice(null);
    setPendingName(next);

    const result = await api.renameWorkflow(token, workflow.id, next);
    if (result.ok) {
      /* Held rather than dropped. Clearing this would fall back to
         `workflow.name`, which is still the OLD name until the page re-renders
         the row — so a page that handled `onRenamed` slowly, or not at all,
         would show the new name flick back to the old one, which is precisely
         the silent revert this card is not allowed to do. The effect below
         lets go of it once the prop has caught up. */
      setPendingName(result.data.name);
      onRenamed?.(result.data);
      return;
    }
    // Visibly back to where it was, with the reason on the card. A rename that
    // reverts without saying why teaches people to distrust the whole page.
    setPendingName(previous);
    setNotice(failureLine(`Could not rename to "${next}"`, result));
  }, [draft, onRenamed, pendingName, token, workflow.id, workflow.name]);

  const duplicate = useCallback(async () => {
    setNotice(null);
    setDuplicating(true);
    const result = await api.duplicateWorkflow(token, workflow.id);
    setDuplicating(false);
    if (result.ok) {
      onDuplicated?.(result.data);
      return;
    }
    setNotice(failureLine("Could not duplicate this agent", result));
  }, [onDuplicated, token, workflow.id]);

  const beginDelete = useCallback(async () => {
    setNotice(null);
    // The card goes at once, before the request is answered. The countdown does
    // not: see the note on `stage` for why those are two different moments.
    setStage("pending");

    const result = await api.deleteWorkflow(token, workflow.id);
    if (result.ok) {
      setRemaining(UNDO_MS);
      setStage("staged");
      return;
    }
    // The card comes back, carrying the reason. Nothing was handed up, so the
    // page's list never lost the row and there is nothing to reconcile.
    setStage("idle");
    setNotice(failureLine("Could not delete this agent", result));
  }, [token, workflow.id]);

  const undoDelete = useCallback(async () => {
    setRestoring(true);
    const result = await api.restoreWorkflow(token, workflow.id);
    setRestoring(false);
    setStage("idle");
    if (result.ok) {
      // The server's row rather than the one this card was holding: a restore
      // moves `updated_at`, and the card should say what the server says.
      onRenamed?.(result.data);
      return;
    }
    setNotice(failureLine("Could not restore this agent", result));
  }, [onRenamed, token, workflow.id]);

  /**
   * The undo window.
   *
   * `onDeleted` and the row are read through refs rather than listed as
   * dependencies. The obvious spelling — listing them — restarts this effect
   * every time the parent re-renders, because the natural way to write the
   * prop is an inline arrow and an inline arrow is a new function each render.
   * The timeout would be cleared and re-armed on every keystroke elsewhere on
   * the page and would, in the limit, never fire: the delete would hang in the
   * undo state forever and the toast would sit there counting down from eight
   * and never reaching zero. Same argument as the one on `useDialogBehaviour`
   * in `primitives.tsx`.
   *
   * The tick is coarse under reduced motion because the only thing left to
   * redraw then is the number of seconds; the bar that needs the fine one is
   * not rendered.
   */
  const finalise = useRef<() => void>(() => {});
  finalise.current = () => onDeleted?.(workflow);

  useEffect(() => {
    if (stage !== "staged") return;
    const startedAt = Date.now();
    const tick = window.setInterval(
      () => setRemaining(Math.max(0, UNDO_MS - (Date.now() - startedAt))),
      reduced ? 1000 : 100,
    );
    const done = window.setTimeout(() => {
      // Nobody undid it, so it stays deleted and the page may drop the row.
      setStage("gone");
      finalise.current();
    }, UNDO_MS);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(done);
    };
  }, [stage, reduced]);

  /* Once the page's row carries the name the server confirmed, the local copy
     has nothing left to say and gets out of the way, so a later rename from
     anywhere else is not masked by this one. */
  useEffect(() => {
    setPendingName((held) => (held === workflow.name ? null : held));
  }, [workflow.name]);

  if (stage !== "idle") {
    /* "Gone" draws nothing at all: `onDeleted` has been called, so the page is
       dropping this row and a toast still counting down over it would be
       offering an undo that has already expired. */
    if (stage === "gone") return null;
    return (
      <UndoToast
        name={name}
        confirmed={stage === "staged"}
        remainingMs={remaining}
        onUndo={undoDelete}
        busy={restoring}
      />
    );
  }

  const menuItems: MenuItem[] = [
    // The same destination the card's own link has, pushed through the router
    // rather than assigned to `location`, so opening from the menu is the same
    // client-side navigation as clicking the card rather than a full reload.
    { label: "Open", onSelect: () => router.push(studioHref(workflow.id)) },
    { label: "Rename", onSelect: startRename, returnFocus: false },
    { label: "Duplicate", onSelect: () => void duplicate() },
    { label: "Delete", onSelect: () => void beginDelete(), danger: true, returnFocus: false },
  ];

  /* No picture at all rather than an empty frame.

     The type says a card always carries a thumbnail and the list endpoint
     always sends one, so this branch should never be taken. It is here because
     the alternative to taking it is a TypeError on `graph.nodes` that takes a
     whole page of cards down for want of a decoration. Drawing an EMPTY
     thumbnail would be worse than either: `FlowThumbnail` renders "No steps
     yet" for a graph with no nodes, which is true of a new agent and a lie
     about a row whose thumbnail did not arrive — and the counts printed beside
     it would then be contradicting the picture. */
  const graph: WorkflowCard["thumbnail"] | undefined = workflow.thumbnail;
  const thumbnail = !graph ? null : (
    <div
      className={`relative overflow-hidden rounded-md border border-line bg-surface-2 ${
        list ? "h-14 w-24 shrink-0" : "aspect-[16/9] w-full"
      }`}
    >
      <FlowThumbnail
        nodes={drawable(graph.nodes)}
        edges={graph.edges}
        /* Same component, same data, two densities — the thumbnail draws
           relatively bigger marks on the smaller ground so a plate is still a
           mark rather than four pixels of mush in a table cell. */
        density={list ? "row" : "card"}
        /* The SVG carries its own width and height attributes; these let the
           wrapper's box win. Both densities are 16:9, which is what the two
           wrappers below are sized to. */
        className="h-full w-full"
      />
      {/* Said, not hidden. The counts beside the picture are the server's and
          are right; the picture is the part that is short, and a reader
          comparing "24 steps" to eleven drawn boxes deserves to be told which
          of the two is incomplete. */}
      {graph.truncated ? (
        <span
          title={`Showing part of a ${workflow.node_count}-step graph. Open the agent to see all of it.`}
          className="absolute bottom-1 right-1 rounded bg-ink/70 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white uppercase"
        >
          Part
        </span>
      ) : null}
    </div>
  );

  const title = editing ? (
    <div>
      <label htmlFor={`rename-${workflow.id}`} className="sr-only">
        Rename {workflow.name}
      </label>
      <input
        id={`rename-${workflow.id}`}
        ref={inputRef}
        value={draft}
        autoFocus
        aria-invalid={nameError ? true : undefined}
        aria-describedby={nameError ? `rename-error-${workflow.id}` : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          if (nameError) setNameError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commitRename();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
            setNameError(null);
          }
        }}
        /* No blur-to-save. Enter saves and Escape cancels, as promised on the
           card; a blur that also saved would commit a half-typed name the
           moment someone clicked away to check something. */
        className="gv-input w-full font-medium"
      />
      {nameError ? (
        <p id={`rename-error-${workflow.id}`} role="alert" className="mt-1.5 text-[12px] text-red">
          {nameError}
        </p>
      ) : null}
    </div>
  ) : (
    <h3 className={`min-w-0 font-medium text-ink ${list ? "text-[14px]" : "text-[15px]"}`}>
      <Link
        href={studioHref(workflow.id)}
        /* The stretched link: the anchor's text is the agent's name, which is
           what a screen reader should announce, and `after:absolute after:inset-0`
           spreads its hit area over the whole card. The focus ring stays on the
           name so a keyboard user can see what is focused, and the card's own
           `:focus-within` styling lights the surface at the same time.
           `block` rather than the anchor's default inline, because `truncate`
           and `line-clamp-2` are both overflow rules and overflow does nothing
           to an inline box — the name would simply run past the card. */
        className={`block rounded-sm after:absolute after:inset-0 after:content-[''] hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
          list ? "truncate" : "line-clamp-2"
        }`}
      >
        {name}
      </Link>
    </h3>
  );

  /* Parsed here rather than inside `EditedAt`, because the separator in front
     of the date has to know whether there is going to be a date. A component
     that returns null is still a truthy element, so asking it would always say
     yes and leave a bullet floating after the counts — the one visible trace of
     the fact this card does not have. */
  const editedAt = parseApiTime(workflow.updated_at);
  const meta = (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-3">
      <span>{countsLine(workflow.node_count, workflow.edge_count)}</span>
      {editedAt ? (
        <>
          <span aria-hidden="true">·</span>
          <EditedAt at={editedAt} />
        </>
      ) : null}
    </p>
  );

  const state = (
    <>
      {duplicating ? (
        <p role="status" className="text-[12px] text-ink-3">
          Duplicating…
        </p>
      ) : null}
      {notice ? (
        <p
          role="alert"
          className="rounded-md border border-red bg-red-tint px-2.5 py-1.5 text-[12px] leading-snug text-red-ink"
        >
          {notice}{" "}
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="relative z-10 underline underline-offset-2"
          >
            Dismiss
          </button>
        </p>
      ) : null}
    </>
  );

  if (list) {
    return (
      <div className="gv-card gv-card-interactive relative flex items-center gap-3.5 p-3">
        {thumbnail}
        <div className="grid min-w-0 flex-1 gap-1">
          {title}
          {workflow.description ? (
            <p className="truncate text-[12.5px] text-ink-2">{workflow.description}</p>
          ) : null}
          {meta}
          {state}
        </div>
        <CardMenu items={menuItems} label={menuLabel} />
      </div>
    );
  }

  return (
    <div className="gv-card gv-card-interactive relative flex flex-col gap-3 p-3.5">
      {thumbnail}
      <div className="flex items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-1.5">
          {title}
          {/* Two lines and no more. A description is a reminder of what this
              agent is, not the place to read it. */}
          {workflow.description ? (
            <p className="line-clamp-2 text-[12.5px] leading-snug text-ink-2">
              {workflow.description}
            </p>
          ) : null}
        </div>
        <CardMenu items={menuItems} label={menuLabel} />
      </div>
      {meta}
      {state}
    </div>
  );
}

export default AgentCard;
