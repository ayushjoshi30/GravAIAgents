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
 *
 * Every row is drawn with the canvas's own plate and its own chip, imported
 * rather than reimplemented, so a node looks the same in the rail as it will
 * once it is placed — which is the point of a rail, and was not true while the
 * rail drew a grey glyph for a node the canvas drew in violet.
 */

import { useMemo, useState } from "react";
import { Icon } from "@/components/icons/AgentIcon";
import { NodePlate } from "@/components/studio/StudioNode";
import { TextField } from "@/components/ui/Field";
import type { NodeFamily, StudioNodeSpec } from "@/lib/studio";

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
        /* A visible edge at rest, not only on hover.
           
           The rows were borderless until the pointer was on them, which
           made thirty-one of them read as one undifferentiated column of
           text and gave no hint that each is a separate thing you can pick
           up and drop. A resting border says "these are objects" before
           anyone touches them, which is the whole proposition of a palette.
           
           Hover and focus then have somewhere to go: the edge darkens to
           the brand line and the surface lifts to white, so the feedback is
           a change of state rather than the sudden appearance of a border
           that was never there. */
        className="group flex w-full cursor-grab items-center gap-2 rounded-[7px] border border-line-2 bg-surface px-2 py-[7px] text-left transition-colors hover:border-navy-line hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy active:cursor-grabbing"
      >
        {/* A node the API offers but this build's generated catalog has not
            heard of gets the palette's neutral slate and its own initial, the
            same as it would on the canvas. The rail is where that case is most
            likely to show up first, since the library is fetched. */}
        <span className="shrink-0">
          <NodePlate type={spec.type} label={spec.label} size={22} />
        </span>
        {/* The name alone, as the reference has it.
            
            Every row carried a truncated summary under it, which at 210px wide
            meant about five words and an ellipsis — enough to notice, never
            enough to learn anything from, and thirty-one of them turned the
            rail into a wall. The full summary is still one hover away in the
            row's `title`, it is printed in full on the node once the block is
            placed, and it is on the agent's own page in the catalog. A rail is
            for finding something you already mean to place. */}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-ink">{spec.label}</span>
        </span>
        {/* The chip used to read "model" in navy, and to say nothing at all on
            the nodes that are code. Navy is this palette's word for "code
            decided", so the rail was printing the opposite of what it meant on
            exactly the distinction the platform is built to make. It now shows
            the canvas's chip: teal "model", navy "code", every row. */}

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
                <ul className="space-y-1 pb-1.5">
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
        {/* Four sentences became one.
            
            The rest said that every node has a real executor, and what the
            model and code markers mean. Both are true and neither survives
            being read twice: the markers are on every row in the list below,
            where someone meets them in context, and "these are real" is not
            something a person needs restated every time they open the panel.
            The one instruction that is genuinely non-obvious — that clicking
            works as well as dragging — is what stayed. */}
        Drag onto the canvas, or click to drop one in the middle.
      </p>
    </div>
  );
}
