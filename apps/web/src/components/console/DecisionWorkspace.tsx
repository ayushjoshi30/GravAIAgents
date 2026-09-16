"use client";

import Link from "next/link";
import { useState } from "react";
import { Chip, ConfirmCard, Eyebrow, Figure, SevChip, type ConfirmSpec } from "@/components/console/primitives";
import { Button } from "@/components/ui/Button";
import { formatDateTimeIst } from "@/lib/format";
import {
  KIND_LABEL,
  SEVERITY_ROUTING,
  slaOf,
  type ItemAction,
  type ReviewItem,
} from "@/lib/review-model";
import { canApprove, type SessionView } from "@/lib/session";

/**
 * The decision workspace.
 *
 * It reads top to bottom in the order a person actually decides: what the
 * agents recommend, the figures that recommendation rests on, what else is open
 * against the same application, then the decision itself. The note comes before
 * the buttons because the note is the record — the buttons are only how it is
 * filed.
 *
 * Three rules hold this screen together:
 *
 *   · Nothing here is reconstructed. Every figure is a value the API sent. Where
 *     the design asked for evidence the API does not expose, the screen says so
 *     in a sentence instead of drawing an empty panel.
 *   · A disabled action always says why, on the control itself. Greying a button
 *     out and leaving the reader to guess whether it is their role, their note
 *     or the product that is at fault is the single most common way a console
 *     wastes somebody's afternoon.
 *   · Nothing is recorded without a confirmation that shows the exact text
 *     about to enter the audit chain. It cannot be edited afterwards.
 */

const SLA_TONE = { ok: "green", soon: "amber", breached: "red", none: "slate" } as const;

/**
 * The note has to be a sentence an auditor can read, not an acknowledgement.
 *
 * Exported so the page that owns the write can hold the same line rather than
 * trusting this component to have held it: one number, checked on both sides of
 * the call.
 */
export const MIN_NOTE = 10;

/**
 * A decision this session has already filed.
 *
 * There used to be a `live` flag here, false when the queue on screen was the
 * illustrative one, so the confirmation could admit that nothing had actually
 * been posted. The illustrative queue is gone: an item can only reach this
 * workspace because the API returned it, and a decision on it only reaches this
 * type because the API accepted the write. Keeping a flag for a case that can
 * no longer occur would leave the workspace carrying copy about example data on
 * the one screen that must never imply such a thing exists.
 */
export interface RecordedOutcome {
  past: string;
  at: string;
}

export function DecisionWorkspace({
  item,
  related,
  session,
  now,
  recorded,
  onRecord,
  onSelect,
  onBack,
  openCount,
}: {
  item: ReviewItem;
  /** Other open items against the same application, recovered from the queue. */
  related: ReviewItem[];
  session: SessionView;
  /** The instant SLAs are measured against; see the note on `slaOf`. */
  now: number;
  recorded?: RecordedOutcome;
  /** Resolves true when the decision was accepted, so the note can be cleared. */
  onRecord: (item: ReviewItem, action: ItemAction, note: string) => Promise<boolean>;
  onSelect: (id: string) => void;
  /** Phone only: hands the screen back to the queue list. */
  onBack?: () => void;
  openCount?: number;
}) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<ItemAction | null>(null);
  const [busy, setBusy] = useState(false);

  const sla = slaOf(item.dueAt, now);
  const mayApprove = item.queue ? canApprove(session, item.queue) : false;
  const noteOk = note.trim().length >= MIN_NOTE;
  const actorName = session.claims?.subject ?? "this session";
  const roleLabel = session.roleLabel ?? "no role claim";

  /**
   * Returned in the order a person hits them, so the message always names the
   * next thing standing between them and the decision rather than all of them.
   */
  const blockedReason = (action: ItemAction): string | null => {
    if (action.endpoint === null) {
      return action.unavailable ?? "The API has no endpoint for this action yet.";
    }
    if (!session.token) {
      // Named for where Settings actually sits in the console nav, which is a
      // top-level destination rather than a child of a "Platform" group.
      return "No API token is set for this console. Add one under Settings before recording a decision.";
    }
    if (!item.queue) {
      return "This item is not assigned to a queue, so the approval matrix cannot say who may sign it.";
    }
    if (!mayApprove) {
      return `Requires the ${item.queue} queue. This session holds ${
        session.roles.length ? session.roles.join(", ") : "no role"
      }.`;
    }
    if (!noteOk) {
      return `Write a note of at least ${MIN_NOTE} characters. It is what the auditor reads.`;
    }
    return null;
  };

  /** Actions the API cannot carry out at all, as opposed to not yet, here. */
  const unavailable = item.actions.filter((action) => action.endpoint === null);

  const confirmSpec: ConfirmSpec | null = pending
    ? {
        title: `${pending.label} · ${item.entityId ?? item.id}?`,
        sub: "This enters the audit chain with your identity and cannot be edited.",
        cta: `Confirm: ${pending.label.toLowerCase()}`,
        danger: pending.kind === "danger",
        rows: [
          { k: "Actor", v: `${actorName} · ${roleLabel}` },
          { k: "Entity", v: `${KIND_LABEL[item.kind].toLowerCase()} on ${item.entityId ?? item.id}`, mono: true },
          // The formatter the rest of the console uses, rather than a second
          // spelling of the same instant: this row and the banner it becomes a
          // moment later should not disagree about how a time is written.
          { k: "Time", v: formatDateTimeIst(new Date()), mono: true },
          { k: "Note", v: note.trim() },
        ],
      }
    : null;

  const record = async () => {
    if (!pending) return;
    /**
     * The gate is checked again here, at the moment of the write, and not only
     * on the button that opened the dialog.
     *
     * Today the two cannot disagree — the confirmation traps focus behind a
     * scrim, so the note cannot be edited while it is open. But that is a
     * property of a dialog somebody may reasonably change later, and the thing
     * standing between an unsigned note and the audit chain should not be a
     * scrim. If the reason has come back, the dialog closes and the reader is
     * returned to the note rather than being told nothing happened.
     */
    if (blockedReason(pending) !== null) {
      setPending(null);
      return;
    }
    setBusy(true);
    try {
      const ok = await onRecord(item, pending, note.trim());
      setPending(null);
      if (ok) setNote("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Decision workspace" className="min-w-0 flex-[2_1_520px]">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="mb-3 bg-transparent p-0 text-sm font-medium text-navy min-[720px]:hidden"
        >
          ← Open items{typeof openCount === "number" ? ` (${openCount})` : ""}
        </button>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={item.kind === "decision" ? "navy" : "slate"}>{KIND_LABEL[item.kind]}</Chip>
        {item.severity ? <SevChip severity={item.severity} /> : null}
        <Chip tone={SLA_TONE[sla.state]}>{sla.label}</Chip>
      </div>

      {/* An h2, not an h1: the route's h1 is "Review queue" above, and this
          panel is one item within that queue. */}
      <h2 className="gv-page-title mt-2.5 mb-1.5">{item.title}</h2>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-ink-3">
        {item.entityId ? (
          <Link href={`/console/applications/${encodeURIComponent(item.entityId)}`} className="gv-id">
            {item.entityId}
          </Link>
        ) : (
          <span>not attached to an application</span>
        )}
        {item.agent ? (
          <span>
            raised by <span className="font-mono">{item.agent}</span>
          </span>
        ) : null}
        <span>{formatDateTimeIst(item.raisedAt)}</span>
        {/* The chip above counts down; this is the instant it counts down to. The
            old review page showed it and a person needs it: "due in 4h" is not
            something anybody can paste into a ticket or quote to a borrower. */}
        {item.dueAt ? <span>due {formatDateTimeIst(item.dueAt)}</span> : null}
        {item.queue ? <span className="font-mono">{item.queue}</span> : <span>unassigned</span>}
      </div>

      <div className="gv-panel mt-6 flex flex-wrap items-center gap-6 px-6 py-5">
        {item.recommendation ? (
          <Figure
            label={item.recommendation.label}
            value={item.recommendation.value}
            tone={item.recommendation.tone}
            size={40}
          />
        ) : null}
        <p className="m-0 flex-[1_1_280px] text-[15px] leading-relaxed text-ink-2">{item.summary}</p>
      </div>

      {item.facts.length > 0 ? (
        <div className="gv-panel mt-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-5 px-6 py-5">
          {item.facts.map((fact) => (
            <Figure key={fact.label} label={fact.label} value={fact.value} note={fact.caption} size={28} />
          ))}
        </div>
      ) : null}

      {/* The design specifies a rule-outcome table and an agent latency trail
          here. Neither is on the task payload, and reconstructing them from the
          summary text would be a guess presented as evidence. Saying what is
          missing, and where the working actually lives, is the honest version. */}
      <p className="mt-3 mb-0 text-[13px] leading-relaxed text-ink-3">
        Rule-by-rule outcomes and the agent trail are not carried on the task itself in this API build, so
        they are not shown here rather than inferred.{" "}
        {item.entityId ? (
          <>
            <Link href={`/console/applications/${encodeURIComponent(item.entityId)}`}>
              Open {item.entityId}
            </Link>{" "}
            for the working behind these figures.
          </>
        ) : null}
      </p>

      {item.kind === "deviation" ? (
        <div className="gv-panel mt-4 px-6 py-5">
          <h3 className="m-0 text-base font-semibold">Who signs</h3>
          <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4 text-sm">
            <div>
              <Eyebrow>Severity</Eyebrow>
              <div className="mt-1 font-semibold">
                {item.severity ? `${item.severity} · ${SEVERITY_ROUTING[item.severity]}` : "Not graded"}
              </div>
            </div>
            <div>
              <Eyebrow>Approval matrix</Eyebrow>
              <div className="mt-1 font-mono">{item.queue ?? "unassigned"}</div>
            </div>
            {item.agent ? (
              <div>
                <Eyebrow>Raised by</Eyebrow>
                <div className="mt-1 font-mono">{item.agent}</div>
              </div>
            ) : null}
          </div>
          <p className="mt-3.5 mb-0 text-[13px] leading-relaxed text-ink-2">
            Nothing self-approves, at any severity. The decision on the parent application waits until this
            deviation is signed or declined.
          </p>
        </div>
      ) : null}

      {related.length > 0 ? (
        <div className="gv-panel mt-4 px-6 py-5">
          <h3 className="m-0 text-base font-semibold">Also open on {item.entityId}</h3>
          <p className="mt-1 mb-0 text-[13px] text-ink-3">
            Raised against the same application, and part of the same decision.
          </p>
          {related.map((other) => (
            <button
              key={other.id}
              type="button"
              onClick={() => onSelect(other.id)}
              className="gv-row mt-2.5 flex w-full flex-wrap items-center gap-2.5 rounded-md border border-line px-3.5 py-3 text-left text-ink"
            >
              {other.severity ? <SevChip severity={other.severity} /> : <Chip tone="slate">{KIND_LABEL[other.kind]}</Chip>}
              <span className="text-sm font-medium">{other.title}</span>
              <span className="ml-auto text-[13px] text-ink-3">
                {other.queue ? (
                  <>
                    queue <span className="font-mono">{other.queue}</span> ·{" "}
                  </>
                ) : null}
                open →
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {recorded ? (
        // Green because the decision proceeded, which is an outcome — not
        // because a language model or a piece of code was involved in it.
        <div
          role="status"
          className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-green bg-green-tint px-6 py-4 text-green-ink"
        >
          <span
            className="gv-dot"
            style={{ width: 10, height: 10, background: "var(--color-green)" }}
            aria-hidden="true"
          />
          <span className="font-semibold">{recorded.past}</span>
          <span className="font-mono text-xs">{recorded.at}</span>
          <span className="flex-[1_1_220px] text-[13px] leading-relaxed">
            Recorded with your identity and hashed into the chain. It cannot be edited; a correction is a
            new event. The response does not carry the chain sequence, so read the entry in{" "}
            <Link href="/console/audit">the audit chain</Link>.
          </span>
        </div>
      ) : (
        <div className="gv-panel mt-4 px-6 py-5 max-md:sticky max-md:bottom-16 max-md:z-10 max-md:shadow-[0_-8px_24px_rgba(20,26,36,.08)]">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="decision-heading" className="m-0 text-base font-semibold">
              Your decision
            </h3>
            <span className="text-xs text-ink-3">
              Note required · stored with your identity, the time and the entity
            </span>
          </div>
          <textarea
            id="decision-note"
            aria-labelledby="decision-heading"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            placeholder="Why. Ten characters minimum; this sentence is what the auditor reads."
            className="gv-textarea mt-3"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* The shared Button, not a hand-rolled `gv-btn`. In this codebase
                `.gv-btn` is only a chassis — radius, weight, transitions — and
                every size, border and, critically, the disabled treatment lives
                in Button.tsx. A bare `gv-btn` here rendered an unpadded control
                that looked exactly the same whether it was live or dead, which
                on the one screen whose entire purpose is a gated action is the
                single worst thing it could do. */}
            {item.actions.map((action) => {
              const reason = blockedReason(action);
              return (
                <Button
                  key={action.label}
                  variant={
                    action.kind === "primary" ? "primary" : action.kind === "danger" ? "danger" : "secondary"
                  }
                  disabled={reason !== null}
                  title={reason ?? undefined}
                  onClick={() => setPending(action)}
                  className="max-md:h-12 max-md:flex-[1_1_100%]"
                >
                  {action.label}
                </Button>
              );
            })}
            <span
              className={`flex-[1_1_220px] text-[13px] leading-snug ${
                mayApprove ? "text-ink-3" : "text-amber-ink"
              }`}
            >
              {!session.token
                ? "This console has no token, so nothing can be recorded. Set one under Settings."
                : !item.queue
                  ? "This item is unassigned, so the approval matrix cannot place it. Assign it to a queue before acting."
                  : !mayApprove
                    ? `Only ${item.queue} may act on this item. You can still read it and add context.`
                    : noteOk
                      ? "The note is stored verbatim with your identity, the time and the entity."
                      : "A note is required before any action enables."}
            </span>
          </div>

          {/* `title` is a hover affordance and a disabled button cannot take
              focus, so on a phone or a keyboard the tooltip explaining a
              permanently unavailable action is unreachable. An action that will
              never fire has to say so in text a person can actually read. */}
          {unavailable.length > 0 ? (
            <ul className="mt-3 grid gap-1.5 border-t border-line-2 pt-3 text-[13px] leading-relaxed text-ink-3">
              {unavailable.map((action) => (
                <li key={action.label}>
                  <span className="font-medium text-ink-2">{action.label}</span> — {blockedReason(action)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {confirmSpec ? (
        <ConfirmCard spec={confirmSpec} onBack={() => setPending(null)} onConfirm={record} busy={busy} />
      ) : null}
    </section>
  );
}
