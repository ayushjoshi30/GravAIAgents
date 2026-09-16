"use client";

/**
 * The block library.
 *
 * Every row is a real button before it is a drag source. Dragging is the nicer
 * gesture when you have a pointer, but it is the addition — pressing Enter on a
 * row puts the block on the canvas just as surely, which is the whole reason a
 * visitor who cannot drag can still build something here.
 *
 * The rail is narrow, so a row shows its plate and its name and nothing else.
 * The block's sentence is not dropped, though: it is in the row for a screen
 * reader, and it is printed in full on the card the moment the block lands on
 * the canvas.
 */

import { useState } from "react";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { groupedBlocks, hueStyle, type Block } from "@/components/build/blocks";

const CHEVRON = "M8 10l4 4 4-4";

/** The same plate the canvas card carries, at rail size, so a block is
 *  recognisable before and after it is placed. */
function Plate({ block }: { block: Block }) {
  return (
    <span
      className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-[5px] border border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]"
      style={hueStyle(block.hue)}
      aria-hidden="true"
    >
      {block.agentId ? (
        <AgentIcon id={block.agentId} size={14} />
      ) : block.icon ? (
        <Icon name={block.icon} size={13} />
      ) : (
        <Icon name="grid" size={13} />
      )}
    </span>
  );
}

export function BlockRail({ onAdd }: { onAdd: (type: string) => void }) {
  const [query, setQuery] = useState("");
  // Agents and control flow are what a first sketch is made of; the rest are
  // there when they are wanted rather than in the way until then.
  const [open, setOpen] = useState<Set<string>>(new Set(["gravai", "control"]));

  const searching = query.trim().length > 0;
  const groups = groupedBlocks(query).filter((group) => group.blocks.length > 0);
  const total = groups.reduce((sum, group) => sum + group.blocks.length, 0);

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line p-2.5">
        <label htmlFor="gv-block-search" className="sr-only">
          Search the block library
        </label>
        <input
          id="gv-block-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search blocks"
          className="gv-field h-8 text-[12.5px]"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {total === 0 ? (
          <p className="px-1 py-3 text-[12px] leading-relaxed text-ink-2">
            Nothing in the library matches “{query.trim()}”. The library is the platform's own node
            registry, so a block that is not here is a block GravAI does not have.
          </p>
        ) : (
          groups.map((group) => {
            // A search opens every group that matched it; closing one by hand
            // while searching would hide the thing that was searched for.
            const expanded = searching || open.has(group.key);
            return (
              <section key={group.key} className="mb-1">
                <h3>
                  <button
                    type="button"
                    onClick={() => toggle(group.key)}
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-1.5 rounded-[4px] px-1.5 py-1.5 text-left text-[11px] font-semibold tracking-[0.07em] text-ink-2 uppercase hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      aria-hidden="true"
                      className={`flex-none text-ink-3 transition-transform ${expanded ? "" : "-rotate-90"}`}
                    >
                      <path d={CHEVRON} />
                    </svg>
                    <span className="flex-1">{group.label}</span>
                    <span className="font-normal text-ink-3 tabular-nums">{group.blocks.length}</span>
                  </button>
                </h3>

                {expanded ? (
                  <ul className="mt-0.5 space-y-0.5">
                    {group.blocks.map((block) => (
                      <li key={block.type}>
                        <button
                          type="button"
                          draggable
                          onDragStart={(event) => {
                            event.dataTransfer.setData("text/plain", block.type);
                            event.dataTransfer.effectAllowed = "copy";
                          }}
                          onClick={() => onAdd(block.type)}
                          title={block.summary}
                          className="flex w-full cursor-grab items-center gap-2 rounded-[5px] border border-transparent px-1.5 py-1.5 text-left hover:border-line hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy active:cursor-grabbing"
                        >
                          <Plate block={block} />
                          <span className="min-w-0 flex-1 truncate text-[12.5px] leading-tight text-ink">
                            {block.label}
                          </span>
                          {/* The sentence the rail has no room for, kept for
                              anyone reading this page with their ears. The
                              model/code distinction is in here too, because the
                              plate beside the row is a hue and hues are silent. */}
                          <span className="sr-only">
                            . {block.kind}. {block.usesLlm ? "A language model reasons." : "Code decides."}{" "}
                            {block.summary} Adds it to the canvas.
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })
        )}
      </div>

      {/* Two colour channels run on this canvas and they are not equal, so the
          legend says which is which rather than leaving a visitor to guess that
          a teal plate still means what it used to. */}
      <div className="border-t border-line p-2.5">
        <p className="gv-label mb-1.5 text-ink-3">Reading the canvas</p>
        <ul className="space-y-1.5 text-[11px] leading-[1.4] text-ink-2">
          <li className="flex items-start gap-1.5">
            <span className="mt-[3px] flex flex-none gap-px" aria-hidden="true">
              <span className="h-3 w-[7px] rounded-l-[3px] border border-r-0 border-[var(--gv-hue-violet-border)] bg-[var(--gv-hue-violet-soft)]" />
              <span className="h-3 w-[7px] border-y border-[var(--gv-hue-orange-border)] bg-[var(--gv-hue-orange-soft)]" />
              <span className="h-3 w-[7px] rounded-r-[3px] border border-l-0 border-[var(--gv-hue-cyan-border)] bg-[var(--gv-hue-cyan-soft)]" />
            </span>
            <span>
              The plate colour is the node's <strong className="font-semibold text-ink">kind</strong>,
              so a step is recognisable before its title is read. It is a label, not a claim.
            </span>
          </li>
          <li className="flex items-start gap-1.5">
            <span
              className="mt-[1px] inline-flex flex-none items-center rounded-full border border-[var(--gv-hue-teal-border)] bg-[var(--gv-hue-teal-soft)] px-1.5 py-px text-[9.5px] font-semibold tracking-[0.06em] text-[var(--gv-hue-teal-strong)] uppercase"
              aria-hidden="true"
            >
              model
            </span>
            <span>A language model reasons inside that step.</span>
          </li>
          <li className="flex items-start gap-1.5">
            <span
              className="mt-[1px] inline-flex flex-none items-center rounded-full border border-[var(--gv-hue-navy-border)] bg-[var(--gv-hue-navy-soft)] px-1.5 py-px text-[9.5px] font-semibold tracking-[0.06em] text-[var(--gv-hue-navy-strong)] uppercase"
              aria-hidden="true"
            >
              code
            </span>
            <span>Code reaches a fixed answer. No model is called.</span>
          </li>
          <li className="flex items-start gap-1.5">
            <svg
              width="18"
              height="12"
              viewBox="0 0 18 12"
              className="mt-[3px] flex-none text-navy"
              aria-hidden="true"
            >
              <path d="M0 3h18" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <path d="M0 9h18" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" fill="none" />
            </svg>
            <span>A solid edge always runs; a dashed one leaves a branch, so it runs only when that branch is chosen.</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
