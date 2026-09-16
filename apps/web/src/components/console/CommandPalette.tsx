"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDialogBehaviour } from "./primitives";

export interface PaletteEntry { group: string; label: string; sub?: string; href: string; mono?: boolean }

/**
 * Every destination in the new information architecture, plus the sub-tabs that
 * no longer have a top-level home. The hrefs are the post-redesign routes: the
 * redirects in next.config.mjs would forgive `/console/mcp`, but sending a
 * person through a 307 to reach a page they asked for by name is a round trip
 * we can simply not make.
 */
/**
 * The eleven console destinations, in the order the sidebar lists them.
 *
 * Kept deliberately in step with `ConsoleShell`'s nav: a palette that offers a
 * page the sidebar does not have — or misses one it does — is worse than no
 * palette, because the whole point of ⌘K is that a person stops checking where
 * things are. Three entries here used to point at Attention, Portfolio and
 * Tools, which no longer exist; they were dead links that the sidebar restore
 * did not touch.
 */
const PAGES: PaletteEntry[] = [
  { group: "Page", label: "Overview", sub: "In flight, activity, spend, quota", href: "/console" },
  { group: "Page", label: "Agents", sub: "The agent catalog", href: "/console/agents" },
  { group: "Page", label: "Agent Studio", sub: "Workflow canvas", href: "/console/studio" },
  { group: "Page", label: "Runs", sub: "Every agent run", href: "/console/runs" },
  { group: "Page", label: "MCP", sub: "What a model host is offered", href: "/console/mcp" },
  { group: "Page", label: "Review queue", sub: "Decisions waiting on a person", href: "/console/review" },
  { group: "Page", label: "Applications", sub: "The journey, stage by stage", href: "/console/applications" },
  { group: "Page", label: "Usage", sub: "Throughput and spend", href: "/console/usage" },
  { group: "Page", label: "Audit explorer", sub: "Hash-chained events", href: "/console/audit" },
  { group: "Page", label: "Admin", sub: "Tenants, people, credentials", href: "/console/admin" },
  { group: "Page", label: "Settings", sub: "Connection, rate card, roles", href: "/console/settings" },
];

/** Recognises the identifiers the product uses and turns them into direct jumps. */
function idJumps(q: string): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  const m = q.trim();
  if (/^GRV-\d+$/i.test(m)) out.push({ group: "Application", label: m.toUpperCase(), sub: "Open application", href: `/console/applications/${m.toUpperCase()}`, mono: true });
  if (/^r-[0-9a-f]+$/i.test(m)) out.push({ group: "Run", label: m, sub: "Open run graph", href: `/console/runs/${m}`, mono: true });
  if (/^(seq\s*)?\d{3,}$/i.test(m)) out.push({ group: "Audit", label: `seq ${m.replace(/^seq\s*/i, "")}`, sub: "Open in the chain", href: `/console/audit?seq=${m.replace(/^seq\s*/i, "")}`, mono: true });
  if (/^[a-z_]+\.[a-z_]+$/i.test(m) || /^[a-z_]{6,}$/i.test(m)) out.push({ group: "Tool", label: m, sub: "Open in MCP", href: `/console/mcp?tool=${encodeURIComponent(m)}`, mono: true });
  return out;
}

export function CommandPalette({ open, onClose, extra = [] }: { open: boolean; onClose: () => void; extra?: PaletteEntry[] }) {
  const router = useRouter();
  const dialog = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  useEffect(() => { if (open) { setQ(""); setI(0); } }, [open]);
  useDialogBehaviour(dialog, { open, onClose });

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // Identifier jumps are derived from the query, so they are already a match
    // and are never filtered again. Pages and caller-supplied entries are
    // filtered on the needle — the handoff let every non-Page entry through
    // unfiltered, which meant a caller passing a hundred open items showed all
    // hundred of them no matter what was typed.
    const matches = (e: PaletteEntry) =>
      !needle || `${e.label} ${e.sub ?? ""} ${e.group}`.toLowerCase().includes(needle);
    const list = [...idJumps(q), ...[...PAGES, ...extra].filter(matches)];
    return needle ? list.slice(0, 10) : list.slice(0, 8);
  }, [q, extra]);

  if (!open) return null;
  const go = (e: PaletteEntry) => { onClose(); router.push(e.href); };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/35" onClick={onClose} />
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Search or jump to" className="gv-overlay gv-rise fixed left-1/2 top-[12vh] z-40 -translate-x-1/2 w-[min(640px,calc(100vw-32px))] overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 h-[52px] border-b border-line-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => { setQ(e.target.value); setI(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setI((v) => Math.min(results.length - 1, v + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setI((v) => Math.max(0, v - 1)); }
              else if (e.key === "Enter" && results[i]) go(results[i]);
            }}
            placeholder="Application id, run, tool, agent, page or audit sequence…"
            aria-label="Search or jump to"
            className="flex-1 h-[52px] border-0 outline-none text-[15px] bg-transparent"
          />
          <kbd className="font-mono text-[11px] text-ink-3 border border-line-2 rounded px-1">esc</kbd>
        </div>
        <div className="max-h-[52vh] overflow-auto p-1.5">
          {results.length === 0 && <div className="p-6 text-center text-[13px] text-ink-3">No match. Try an application id like GRV-18301, a tool like bre.evaluate, or a page.</div>}
          {results.map((e, idx) => (
            <button key={`${e.group}-${e.label}`} onClick={() => go(e)} onMouseEnter={() => setI(idx)}
              className={`grid grid-cols-[76px_minmax(0,1fr)] gap-3 items-center w-full text-left px-3 py-2.5 rounded-md ${idx === i ? "bg-navy-tint" : "hover:bg-surface-3"}`}>
              <span className="gv-eyebrow">{e.group}</span>
              <span className="text-sm font-medium truncate"><span className={e.mono ? "font-mono" : ""}>{e.label}</span> <span className="font-normal text-ink-3 text-[13px]">{e.sub}</span></span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
