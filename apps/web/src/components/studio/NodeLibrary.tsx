"use client";

/**
 * The node library.
 *
 * Every entry is fetched from the backend registry rather than listed here, so
 * the sidebar cannot offer a node the engine has no executor for. That is the
 * one property this product cannot lose: a box you can drag onto a canvas and
 * connect up, which then does nothing, is worse than not offering it.
 *
 * Dragging sets a plain `text/plain` payload of the node type. Dropping is
 * handled by the canvas, which knows where the pointer landed.
 */

import { useMemo, useState } from "react";
import { AgentIcon, Icon, type IconName } from "@/components/icons/AgentIcon";
import { TextField } from "@/components/ui/Field";
import type { NodeFamily, StudioNodeSpec } from "@/lib/studio";

function Glyph({ spec }: { spec: StudioNodeSpec }) {
  if (spec.type.startsWith("agent.")) {
    return <AgentIcon id={spec.type.slice("agent.".length)} size={15} />;
  }
  return <Icon name={(spec.icon || "bolt") as IconName} size={14} />;
}

function LibraryItem({ spec, onAdd }: { spec: StudioNodeSpec; onAdd: (type: string) => void }) {
  return (
    <li>
      <button
        type="button"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData("text/plain", spec.type);
          event.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => onAdd(spec.type)}
        title={spec.caveat ? `${spec.summary}\n\n${spec.caveat}` : spec.summary}
        className="group flex w-full cursor-grab items-start gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-line hover:bg-surface-2 active:cursor-grabbing"
      >
        <span className="mt-px shrink-0 text-ink-3 group-hover:text-brand">
          <Glyph spec={spec} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-ink">{spec.label}</span>
          <span className="block truncate text-[11px] text-ink-3">{spec.summary}</span>
        </span>
        {spec.uses_llm ? (
          <span className="mt-0.5 shrink-0 rounded bg-brand-50 px-1 py-px text-[9.5px] font-medium text-brand">
            model
          </span>
        ) : null}
      </button>
    </li>
  );
}

export function NodeLibrary({
  families,
  onAdd,
}: {
  families: NodeFamily[];
  onAdd: (type: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return families;
    return families
      .map((family) => ({
        ...family,
        nodes: family.nodes.filter(
          (spec) =>
            spec.label.toLowerCase().includes(needle) ||
            spec.type.toLowerCase().includes(needle) ||
            spec.summary.toLowerCase().includes(needle),
        ),
      }))
      .filter((family) => family.nodes.length > 0);
  }, [families, query]);

  const total = families.reduce((sum, family) => sum + family.nodes.length, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-3 py-3">
        <TextField
          label="Node library"
          value={query}
          onChange={setQuery}
          type="search"
          placeholder={`Search ${total} nodes`}
        />
      </div>

      <div className="gv-scroll-y min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {filtered.length === 0 ? (
          <p className="px-2 py-4 text-[12px] text-ink-3">Nothing matches {query}.</p>
        ) : null}

        {filtered.map((family) => {
          const isCollapsed = collapsed[family.key] && !query;
          return (
            <section key={family.key} className="mb-1">
              <button
                type="button"
                onClick={() => setCollapsed((prev) => ({ ...prev, [family.key]: !prev[family.key] }))}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
              >
                <Icon
                  name="chevron"
                  size={11}
                  className={`text-ink-3 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                />
                <span className="gv-eyebrow">{family.label}</span>
                <span className="ml-auto font-mono text-[10.5px] text-ink-3" data-numeric="">
                  {family.nodes.length}
                </span>
              </button>
              {!isCollapsed ? (
                <ul className="space-y-0.5 pb-1">
                  {family.nodes.map((spec) => (
                    <LibraryItem key={spec.type} spec={spec} onAdd={onAdd} />
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>

      <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-3">
        Drag onto the canvas, or click to drop one in the middle. Every node here has a real
        executor behind it.
      </p>
    </div>
  );
}
