"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";

/* ---------- Chips and figures ---------- */

export type Tone = "navy" | "slate" | "teal" | "green" | "amber" | "red" | "outline";

export function Chip({ tone = "slate", mono, children, title }: { tone?: Tone; mono?: boolean; children: ReactNode; title?: string }) {
  return <span title={title} className={`gv-chip gv-chip-${tone} ${mono ? "font-mono" : ""}`}>{children}</span>;
}

export function SevChip({ severity }: { severity: "L1" | "L2" | "L3" }) {
  return <span className={`gv-chip gv-chip-sev-${severity}`}>{severity}</span>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="gv-eyebrow">{children}</div>;
}

/**
 * Label · figure · qualifier. The qualifier is the sentence that makes the number honest.
 *
 * The tone colours read from the theme variables rather than the literal hexes
 * the handoff inlined. They are the same three colours today, but a figure that
 * hard-codes `#b3261e` is a figure that quietly stops matching the chip beside
 * it the first time the palette moves.
 */
export function Figure({ label, value, note, tone, pct, size = 30 }: { label: string; value: string; note?: string; tone?: "amber" | "red" | "green"; pct?: number; size?: number }) {
  const color =
    tone === "red"
      ? "var(--color-red)"
      : tone === "amber"
        ? "var(--color-warn)"
        : tone === "green"
          ? "var(--color-green)"
          : "var(--color-ink)";
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div className="gv-figure mt-1" style={{ fontSize: size, color }}>{value}</div>
      {pct !== undefined && (
        <div className="h-1 bg-line-2 rounded-sm mt-2"><div className="h-1 bg-navy rounded-sm" style={{ width: `${Math.min(100, pct)}%` }} /></div>
      )}
      {note && <div className="text-xs text-ink-3 mt-1">{note}</div>}
    </div>
  );
}

export function Skeleton({ h = 14, w = "100%" }: { h?: number; w?: string | number }) {
  return <div className="gv-skeleton" style={{ height: h, width: w }} aria-hidden="true" />;
}

/* ---------- Dialog behaviour, shared by every overlay in the console ---------- */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Esc to close, Tab kept inside, and focus handed back where it came from.
 *
 * This lives here rather than in each overlay because a half-trapped dialog is
 * worse than none: a keyboard user who tabs past the last button lands on the
 * page behind an opaque scrim, with no way of knowing what has focus. The
 * listener is registered in the capture phase so that a focused input inside
 * the dialog cannot swallow Esc before the dialog has seen it.
 */
export function useDialogBehaviour(
  ref: RefObject<HTMLElement | null>,
  { open, onClose }: { open: boolean; onClose: () => void },
): void {
  // The callback is held in a ref rather than listed as a dependency because a
  // caller that passes an inline arrow would otherwise re-run this effect on
  // every parent render, and the cleanup hands focus back to whatever opened
  // the dialog — so the caret would jump out of the dialog mid-keystroke.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;

    const restoreTo = document.activeElement as HTMLElement | null;
    const items = (): HTMLElement[] => {
      const node = ref.current;
      if (!node) return [];
      return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
    };

    // Give focus to the dialog only if it has not already claimed it itself;
    // an `autoFocus` input should keep the caret it just took.
    const node = ref.current;
    if (node && !node.contains(document.activeElement)) items()[0]?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = items();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      const inside = ref.current?.contains(current) ?? false;
      if (event.shiftKey && (current === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      restoreTo?.focus?.();
    };
  }, [open, ref]);
}

/* ---------- Toasts: a module-level store so any component can call toast() ---------- */

export interface Toast { id: number; message: string; seq?: string; tone?: "ok" | "info" | "error" }
let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(message: string, opts: { seq?: string; tone?: Toast["tone"]; ms?: number } = {}) {
  const id = Date.now() + Math.random();
  toasts = [...toasts, { id, message, seq: opts.seq, tone: opts.tone ?? "ok" }];
  emit();
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); emit(); }, opts.ms ?? 4200);
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function ToastHost({ bottom = 16 }: { bottom?: number }) {
  const list = useSyncExternalStore(subscribe, () => toasts, () => toasts);
  return (
    <div aria-live="polite" className="fixed right-4 z-50 grid gap-2 max-w-[min(420px,calc(100vw-32px))]" style={{ bottom }}>
      {list.map((t) => (
        <div key={t.id} className="gv-rise flex items-center gap-3 px-3.5 py-3 rounded-lg bg-ink text-white text-[13px] shadow-lg">
          <span className="gv-dot" style={{ background: t.tone === "error" ? "#f2a09a" : t.tone === "info" ? "#c9d6ec" : "#7fd1a4" }} />
          <span className="flex-1 leading-snug">{t.message}</span>
          {t.seq && <span className="font-mono text-xs text-navy-line whitespace-nowrap">{t.seq}</span>}
        </div>
      ))}
    </div>
  );
}

/* ---------- Confirm card: shows exactly what will be hashed into the chain ---------- */

export interface ConfirmSpec {
  title: string;
  sub: string;
  cta: string;
  danger?: boolean;
  rows: { k: string; v: string; mono?: boolean }[];
}

export function ConfirmCard({ spec, onBack, onConfirm, busy }: { spec: ConfirmSpec; onBack: () => void; onConfirm: () => void; busy?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogBehaviour(dialog, { open: true, onClose: onBack });

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/35" onClick={onBack} />
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={spec.title} className="gv-overlay gv-rise fixed left-1/2 top-1/2 z-40 -translate-x-1/2 -translate-y-1/2 w-[min(480px,calc(100vw-32px))] p-6">
        <div className="font-display font-semibold text-2xl leading-tight">{spec.title}</div>
        <div className="text-[13px] text-ink-3 mt-1">{spec.sub}</div>
        <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] mt-3.5 p-3.5 bg-surface-2 rounded-md leading-snug">
          {spec.rows.map((r) => (
            <div key={r.k} className="contents">
              <div className="text-ink-3">{r.k}</div>
              <div className={r.mono ? "font-mono break-words" : "break-words"}>{r.v}</div>
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 mt-4 flex-wrap">
          <button className="gv-btn h-10" onClick={onBack}>Back</button>
          <button className={`gv-btn h-10 ${spec.danger ? "gv-btn-primary !bg-red !border-red" : "gv-btn-primary"}`} onClick={onConfirm} disabled={busy}>{busy ? "Recording…" : spec.cta}</button>
        </div>
      </div>
    </>
  );
}
