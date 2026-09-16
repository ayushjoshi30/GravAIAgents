"use client";

/**
 * The sketchpad.
 *
 * What this page is: a real editor. Adding a step, moving it, joining two
 * steps, naming them, describing the inputs — all of it is genuine state in
 * this tab, and all of it works. Nothing is a picture of an editor.
 *
 * What this page is not, and never claims to be: connected to anything. There
 * is no API token on a public page, so there is nothing here that could deploy,
 * run, save to an account, or validate a design against the engine — and a
 * button that said otherwise would be the worst kind of lie this product can
 * tell, because the whole promise of an auditable agent is that the screen and
 * the system agree. The sketch lives in this tab and ends with it.
 *
 * Three notes on the interaction model:
 *
 * IT IS AN APPLICATION, NOT A PANEL. This component fills the height it is
 * given and the page gives it the viewport, so the canvas is the tallest thing
 * on the screen rather than a window cut into a marketing page. Everything that
 * used to sit under the canvas and add to the document's height — the
 * connections list — is a drawer along the bottom of the shell now, and the
 * page's prose is below the shell entirely.
 *
 * UNDO IS FOR STRUCTURE. Adding, removing, connecting and moving push onto the
 * history. Typing into a name or a description does not. A per-keystroke undo
 * stack makes undo useless for the thing it is actually wanted for, and a
 * mistyped name is fixed by typing, not by undoing eleven times.
 *
 * CONNECTING IS A TWO-STEP ACT, NOT A DRAG. Dragging a handle still works for
 * anyone with a pointer, but the primary path is: press "Connect" on one step,
 * then "Connect here" on another. It is the same two decisions either way, and
 * this way a visitor who cannot drag makes them just as easily. On a branch the
 * first press also picks which branch, because a branch edge that does not know
 * its outcome is an edge nobody can read.
 */

import { useCallback, useEffect, useState } from "react";
import { BlockRail } from "@/components/build/BlockRail";
import { BuilderCanvas } from "@/components/build/BuilderCanvas";
import { WorkflowPanel } from "@/components/build/WorkflowPanel";
import { blockFor } from "@/components/build/blocks";
import { BuilderContext, type Linking } from "@/components/build/builder-context";
import {
  edgeId,
  localId,
  nextFreePosition,
  nextNodeId,
  seedSketch,
  sketchToJson,
  type Sketch,
  type SketchVariable,
} from "@/components/build/sketch";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

interface History {
  past: Sketch[];
  present: Sketch;
  future: Sketch[];
}

/** Deep enough to cover a session's worth of edits, shallow enough that a
 *  long session does not quietly hold a hundred copies of the graph. */
const HISTORY_LIMIT = 40;

export function AgentBuilder() {
  const [history, setHistory] = useState<History>(() => ({
    past: [],
    present: seedSketch(),
    future: [],
  }));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [linking, setLinking] = useState<Linking | null>(null);
  const [status, setStatus] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [railOpen, setRailOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);

  const sketch = history.present;

  /** A structural change: goes on the undo stack. */
  const commit = useCallback((next: (current: Sketch) => Sketch) => {
    setHistory((current) => {
      const value = next(current.present);
      if (value === current.present) return current;
      return {
        past: [...current.past, current.present].slice(-HISTORY_LIMIT),
        present: value,
        future: [],
      };
    });
  }, []);

  /** An edit to a label: changes the sketch without touching the undo stack. */
  const amend = useCallback((next: (current: Sketch) => Sketch) => {
    setHistory((current) => {
      const value = next(current.present);
      if (value === current.present) return current;
      return { ...current, present: value };
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((current) => {
      if (current.past.length === 0) return current;
      const previous = current.past[current.past.length - 1];
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future],
      };
    });
    setStatus("Undone.");
  }, []);

  const redo = useCallback(() => {
    setHistory((current) => {
      if (current.future.length === 0) return current;
      const next = current.future[0];
      return {
        past: [...current.past, current.present],
        present: next,
        future: current.future.slice(1),
      };
    });
    setStatus("Redone.");
  }, []);

  // --- blocks and steps -----------------------------------------------------

  const addBlock = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      const block = blockFor(type);
      if (!block) return;
      commit((current) => {
        const id = nextNodeId(type, current.nodes);
        return {
          ...current,
          nodes: [
            ...current.nodes,
            { id, type, name: block.label, position: position ?? nextFreePosition(current.nodes) },
          ],
        };
      });
      setStatus(
        `Added ${block.label}${position ? "" : " to the right of the sketch"}. Press Connect on it to join it to another step.`,
      );
    },
    [commit],
  );

  const removeNode = useCallback(
    (id: string) => {
      commit((current) => ({
        ...current,
        nodes: current.nodes.filter((node) => node.id !== id),
        edges: current.edges.filter((edge) => edge.source !== id && edge.target !== id),
      }));
      setSelectedIds((current) => current.filter((selected) => selected !== id));
      setLinking((current) => (current?.source === id ? null : current));
      setStatus("Step removed, along with anything that was connected to it.");
    },
    [commit],
  );

  const removeNodes = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const removed = sketch.nodes.filter((node) => ids.includes(node.id)).length;
      if (removed === 0) return;
      commit((current) => {
        // Deleting a node makes React Flow report the node and its edges
        // separately, and the second report arrives after this has already
        // taken both out. Returning the same object tells `commit` nothing
        // happened, so an empty step never lands on the undo stack.
        if (!current.nodes.some((node) => ids.includes(node.id))) return current;
        return {
          ...current,
          nodes: current.nodes.filter((node) => !ids.includes(node.id)),
          edges: current.edges.filter(
            (edge) => !ids.includes(edge.source) && !ids.includes(edge.target),
          ),
        };
      });
      setStatus(`${removed === 1 ? "Step" : `${removed} steps`} removed.`);
    },
    [commit, sketch],
  );

  const renameNode = useCallback(
    (id: string, name: string) => {
      amend((current) => ({
        ...current,
        nodes: current.nodes.map((node) => (node.id === id ? { ...node, name } : node)),
      }));
    },
    [amend],
  );

  /**
   * A move is committed only where something actually moved.
   *
   * React Flow reports the end of a drag twice — once as a position change with
   * the drag already finished, and again through the drag-stop handler — and a
   * keyboard nudge arrives through the first of those. Comparing the positions
   * rather than trusting the call means the second report is free, so one
   * gesture leaves one thing on the undo stack however many times it is told.
   */
  const moveNodes = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      commit((current) => {
        let changed = false;
        const nodes = current.nodes.map((node) => {
          const next = positions[node.id];
          if (!next || (next.x === node.position.x && next.y === node.position.y)) return node;
          changed = true;
          return { ...node, position: next };
        });
        return changed ? { ...current, nodes } : current;
      });
    },
    [commit],
  );

  // --- connections ----------------------------------------------------------

  const connectNodes = useCallback(
    (source: string, target: string, branch: string) => {
      if (source === target) {
        setStatus("A step cannot connect to itself.");
        return;
      }
      const targetNode = sketch.nodes.find((node) => node.id === target);
      if (!targetNode) return;
      if (targetNode.type === "input") {
        setStatus("Input is where a run starts, so nothing connects into it.");
        return;
      }
      const id = edgeId(source, target, branch);
      if (sketch.edges.some((edge) => edge.id === id)) {
        setStatus("Those two are already connected that way.");
        return;
      }
      commit((current) => ({
        ...current,
        edges: [...current.edges, { id, source, target, branch }],
      }));
      const sourceName = sketch.nodes.find((node) => node.id === source)?.name ?? source;
      setStatus(
        branch
          ? `Connected: ${sourceName} continues to ${targetNode.name} on the ${branch} branch. Branch edges are drawn dashed.`
          : `Connected: ${sourceName} continues to ${targetNode.name}.`,
      );
    },
    [commit, sketch],
  );

  const startLink = useCallback(
    (source: string, branch: string) => {
      const name = sketch.nodes.find((node) => node.id === source)?.name ?? source;
      setLinking({ source, branch });
      setStatus(
        `Connecting from ${name}${branch ? ` on the ${branch} branch` : ""}. Choose "Connect here" on the step it leads to, or press Escape to stop.`,
      );
    },
    [sketch],
  );

  const completeLink = useCallback(
    (target: string) => {
      if (!linking) return;
      connectNodes(linking.source, target, linking.branch);
      setLinking(null);
    },
    [connectNodes, linking],
  );

  const cancelLink = useCallback(() => {
    setLinking(null);
    setStatus("Connection cancelled. Nothing was changed.");
  }, []);

  /**
   * Mirror React Flow's selection, and only when it has really changed.
   *
   * The selection travels down into the node list and comes back up through
   * this, so an identical array that happened to be newly allocated would be a
   * fresh render every time the canvas reported the same thing. Comparing the
   * contents keeps the round trip from being a loop.
   */
  const syncSelection = useCallback((ids: string[]) => {
    setSelectedIds((current) =>
      current.length === ids.length && current.every((id, index) => id === ids[index])
        ? current
        : ids,
    );
  }, []);

  const removeEdges = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      /* Counted from the sketch this render is showing, not from inside the
         updater: an updater runs later, during a render, so a count taken in
         there would still be zero by the time the message is written. */
      const removed = sketch.edges.filter((edge) => ids.includes(edge.id)).length;
      if (removed === 0) return;
      commit((current) => {
        const kept = current.edges.filter((edge) => !ids.includes(edge.id));
        if (kept.length === current.edges.length) return current;
        return { ...current, edges: kept };
      });
      setStatus(`${removed === 1 ? "Connection" : `${removed} connections`} removed.`);
    },
    [commit, sketch],
  );

  // --- variables ------------------------------------------------------------

  const addVariable = useCallback(() => {
    commit((current) => ({
      ...current,
      variables: [...current.variables, { id: localId("var"), name: "", type: "string" }],
    }));
    setStatus("Added an input variable. Give it a name.");
  }, [commit]);

  const changeVariable = useCallback(
    (id: string, patch: Partial<Omit<SketchVariable, "id">>) => {
      amend((current) => ({
        ...current,
        variables: current.variables.map((variable) =>
          variable.id === id ? { ...variable, ...patch } : variable,
        ),
      }));
    },
    [amend],
  );

  const removeVariable = useCallback(
    (id: string) => {
      commit((current) => ({
        ...current,
        variables: current.variables.filter((variable) => variable.id !== id),
      }));
      setStatus("Input variable removed.");
    },
    [commit],
  );

  // --- keyboard -------------------------------------------------------------

  /* Escape is the one key this component claims. Everything else on the canvas
     — Tab to a step, Enter or Space to select it, the arrow keys to move it,
     Shift to move it further, Delete to take it out — is React Flow's own
     keyboard layer, which also announces each move in its own live region.
     Reimplementing it here would mean two things moving the same node. */
  useEffect(() => {
    if (!linking) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelLink();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [cancelLink, linking]);

  // --- actions --------------------------------------------------------------

  const copyJson = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sketchToJson(sketch));
      setCopyState("copied");
      setStatus("The sketch is on your clipboard as JSON. It was not sent anywhere.");
    } catch {
      // A refused clipboard is ordinary — an insecure context, a permission
      // prompt declined. Say so plainly rather than pretending it worked.
      setCopyState("failed");
      setStatus("This browser would not give the page clipboard access. Nothing was sent anywhere.");
    }
  }, [sketch]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 4000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const startOver = useCallback(() => {
    commit(() => seedSketch());
    setSelectedIds([]);
    setLinking(null);
    setStatus("Back to the example sketch. Undo will bring your version back.");
  }, [commit]);

  const nameOf = (id: string) => sketch.nodes.find((node) => node.id === id)?.name ?? id;

  return (
    <BuilderContext.Provider
      value={{
        linking,
        startLink,
        completeLink,
        cancelLink,
        removeNode,
        renameNode,
      }}
    >
      {/* --- THE APPLICATION SHELL ---
          Fills the height its parent is given, which the page sets to the
          viewport. Everything in here is shrink-0 except the three columns, so
          the canvas is what grows when the window does and the bars stay the
          height they need. Nothing in this subtree scrolls the document: the
          rail, the panel and the connections drawer each scroll inside
          themselves. */}
      <div className="relative flex h-full min-h-0 flex-col bg-surface">
        {/* --- app bar ---
            The reference's top bar: the sketch's name, a Draft chip, its one
            line of description, actions on the right. The page's only h1 lives
            here and is hidden, because the bold text beside it is the name of
            the visitor's own document rather than the title of the page — the
            two are not the same thing, and the name changes as they type. */}
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
          <h1 className="sr-only">Sketch an agent</h1>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-[15px] font-semibold text-ink">
                {sketch.name || "Untitled agent"}
              </p>
              <Badge tone="neutral" dot>
                Draft · not saved
              </Badge>
            </div>
            <p className="gv-help mt-0.5 max-w-2xl truncate">
              {sketch.description || "No description yet — add one in the panel on the right."}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* The honest framing, kept in the furniture now that there is no
                hero to carry it. It is also the way back to the full
                explanation, which sits below the shell: a visitor who wants to
                know what this page can and cannot do is one keystroke from it
                rather than left to guess that scrolling is worth trying. */}
            <a
              href="#about-this-page"
              className="rounded-[4px] px-1 text-[12px] text-ink-2 underline decoration-line-strong underline-offset-[3px] hover:text-navy hover:decoration-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
            >
              It draws; it does not run.
              {/* The visible words are the claim, which is what a reader needs
                  to see. The destination is what a screen reader needs to hear
                  before deciding to follow it, and the two are not the same
                  sentence. It is never hidden at small widths: a phone is
                  exactly where a visitor is least likely to scroll far enough
                  to find this stated anywhere else. */}
              <span className="sr-only"> Read what this page does, and what it does not.</span>
            </a>
            <Button variant="ghost" size="sm" onClick={startOver}>
              Start over
            </Button>
          </div>
        </header>

        {/* The one running commentary on the page. It is a live region so a
            screen reader hears every add, connect and removal, and it is
            visible so everyone else sees the same sentence.
            
            It floats over the canvas rather than sitting in the column as a
            full-width strip. As a strip it cost the canvas a permanent 39px —
            about six per cent of a laptop screen — to say "Drag a block onto
            the canvas" for the entire session after the reader had done so
            once. Floating, it costs nothing when idle and is more noticeable
            when it changes, because a thing that appears draws the eye better
            than a thing that was always there.
            
            It stays in the DOM at all times rather than being conditionally
            rendered: a live region has to exist before it changes for a screen
            reader to announce the change, and one that is mounted at the moment
            it gains text is frequently missed. When idle it therefore carries
            the hint rather than nothing.
            
            Centred rather than left, so it never lands on the minimap, and
            `pointer-events-none` so a message can never swallow a click meant
            for a node underneath it. */}
        <p
          role="status"
          aria-live="polite"
          className={`pointer-events-none absolute bottom-3 left-1/2 z-20 max-w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 truncate rounded-full border px-3 py-1.5 text-[12px] leading-relaxed shadow-[var(--gv-shadow-raised)] ${
            linking
              ? "border-navy-line bg-navy-tint text-navy-ink"
              : "border-line bg-surface/95 text-ink-2"
          }`}
        >
          {status || "Drag a block onto the canvas, or press Enter on one to add it."}
        </p>

        {/* --- the three columns ---
            At `lg` and above these are three real columns filling the shell,
            each scrolling inside itself, and the canvas is the tallest thing on
            the screen. At phone width three columns cannot survive — squeezing
            them would give a 90px rail and a canvas too narrow to read a node
            in — so below `lg` they stop being columns: the library collapses
            into a disclosure above the canvas, the canvas keeps a real height
            of its own and pans by drag, and the workflow panel becomes a
            stacked section beneath. That stack scrolls inside this box rather
            than as the document, so the app still owns the viewport on a phone.
            Nothing is hidden from the small screen — it is reordered into a
            column, which is the shape a phone has. */}
        <div className="grid min-h-0 flex-1 divide-y divide-line overflow-y-auto lg:grid-cols-[224px_minmax(0,1fr)_296px] lg:grid-rows-[minmax(0,1fr)] lg:divide-x lg:divide-y-0 lg:overflow-hidden">
          {/* Each of the four regions opens with a hidden h2. The page's h1 is
              in the app bar, and the `h3`s inside the rail and the panel would
              otherwise hang off nothing — a heading outline that skips a level
              is how a screen-reader user loses the ability to jump between the
              parts of an application. They are hidden because on screen the
              column itself, or the button above it, already says the word. */}
          <div className="min-w-0 lg:min-h-0">
            <h2 className="sr-only">Block library</h2>
            <button
              type="button"
              onClick={() => setRailOpen((open) => !open)}
              aria-expanded={railOpen}
              aria-controls="gv-block-rail"
              className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-[13px] font-medium text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-navy lg:hidden"
            >
              Block library
              <span className="text-[12px] font-normal text-ink-3">
                {railOpen ? "Hide" : "Show"}
              </span>
            </button>
            <div
              id="gv-block-rail"
              className={`${railOpen ? "block h-[46dvh]" : "hidden"} overflow-hidden lg:block lg:h-full`}
            >
              <BlockRail onAdd={(type) => addBlock(type)} />
            </div>
          </div>

          {/* On a phone the canvas is given a definite share of the viewport
              rather than left flexible, because its parent scrolls there and a
              flexible child of a scrolling box collapses to its content — which
              for a canvas is nothing at all. `dvh` rather than `vh` so the
              browser's own chrome sliding in and out resizes it instead of
              cropping it. */}
          {/* The heading is `sr-only`, which is absolutely positioned, so it
              takes no room from the canvas that fills this column. */}
          <div className="h-[56dvh] min-h-[320px] min-w-0 lg:h-full lg:min-h-0">
            <h2 className="sr-only">Canvas</h2>
            <BuilderCanvas
              sketch={sketch}
              selectedIds={selectedIds}
              onSelectionChange={syncSelection}
              onMoveNodes={moveNodes}
              onConnectNodes={connectNodes}
              onRemoveNodes={removeNodes}
              onRemoveEdges={removeEdges}
              onDropBlock={(type, position) => addBlock(type, position)}
              canUndo={history.past.length > 0}
              canRedo={history.future.length > 0}
              onUndo={undo}
              onRedo={redo}
            />
          </div>

          <div className="min-w-0 lg:h-full lg:min-h-0 lg:overflow-hidden">
            <h2 className="sr-only">This sketch</h2>
            <WorkflowPanel
              name={sketch.name}
              description={sketch.description}
              variables={sketch.variables}
              stepCount={sketch.nodes.length}
              connectionCount={sketch.edges.length}
              onRename={(name) => amend((current) => ({ ...current, name }))}
              onDescribe={(description) => amend((current) => ({ ...current, description }))}
              onVariableChange={changeVariable}
              onVariableAdd={addVariable}
              onVariableRemove={removeVariable}
              onCopyJson={() => void copyJson()}
              copyState={copyState}
            />
          </div>
        </div>

        {/* --- the sketch in words ---
            The canvas is the good way to read a graph and a poor way to edit one
            with a keyboard alone, so the same graph is here as a list: every
            connection, named at both ends, each with a button that removes it.
            It is also the only readable view of a wide graph on a phone.

            It is a drawer along the bottom of the shell rather than a section
            underneath it, because the shell now owns the whole viewport and
            anything below it would be off the screen. Closed it costs one row;
            open it takes a share of the height and scrolls inside itself, so
            opening it never pushes the canvas out of view. */}
        <div className="shrink-0 border-t border-line">
          <button
            type="button"
            onClick={() => setOutlineOpen((open) => !open)}
            aria-expanded={outlineOpen}
            aria-controls="gv-sketch-outline"
            className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-[13px] font-medium text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-navy"
          >
            <span>
              Connections{" "}
              <span className="font-normal text-ink-3 tabular-nums">({sketch.edges.length})</span>
            </span>
            <span className="text-[12px] font-normal text-ink-3">
              {outlineOpen ? "Hide" : "List and remove"}
            </span>
          </button>
          <h2 className="sr-only">The sketch in words</h2>

          {outlineOpen ? (
            <div
              id="gv-sketch-outline"
              className="max-h-[38dvh] overflow-y-auto border-t border-line px-4 py-3"
            >
              {sketch.edges.length === 0 ? (
                <p className="text-[12.5px] text-ink-2">
                  Nothing is connected yet. Press Connect on a step, then Connect here on another.
                </p>
              ) : (
                <ul className="gv-divide">
                  {sketch.edges.map((edge) => (
                    <li key={edge.id} className="flex items-center gap-3 py-1.5">
                      <span className="min-w-0 flex-1 text-[12.5px] text-ink">
                        {nameOf(edge.source)}
                        <span className="px-1.5 text-ink-3" aria-hidden="true">
                          →
                        </span>
                        <span className="sr-only"> continues to </span>
                        {nameOf(edge.target)}
                        {edge.branch ? (
                          <span className="ml-2 rounded border border-navy-line bg-navy-tint px-1.5 py-px text-[10.5px] text-navy-ink">
                            {edge.branch} branch · dashed
                          </span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeEdges([edge.id])}
                        className="shrink-0 rounded-[4px] border border-line px-2 py-1 text-[11.5px] font-medium text-ink-2 hover:border-fail hover:text-fail focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy"
                      >
                        Remove
                        <span className="sr-only">
                          {" "}
                          the connection from {nameOf(edge.source)} to {nameOf(edge.target)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="gv-label mt-4 text-ink" id="gv-without-a-mouse">
                Without a mouse
              </h3>
              <ul className="gv-checklist mt-1.5 text-[12.5px]">
                <li>Tab to a block in the library and press Enter to put it on the canvas.</li>
                <li>
                  Press Connect on one step, then Connect here on another. On a branch, press the
                  branch you mean first.
                </li>
                <li>Escape stops a connection before it is made.</li>
                <li>
                  Tab to a step and press Enter to select it, then move it with the arrow keys —
                  hold Shift to move it further.
                </li>
                <li>Delete removes whatever is selected, step or connection.</li>
                <li>Every step has a Remove button; every connection has one in the list above.</li>
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </BuilderContext.Provider>
  );
}
