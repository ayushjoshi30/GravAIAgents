"use client";

/**
 * The canvas.
 *
 * Built on React Flow, which this repository already depends on because the
 * console's Agent Studio canvas uses it — reusing it costs the marketing bundle
 * nothing that is not already paid for elsewhere in the app, and it brings
 * pan, zoom, drag, the minimap and a keyboard-navigable node layer that would
 * otherwise have to be written again here.
 *
 * The sketch is the truth and this is a view of it. Positions are the one
 * exception: they change on every frame of a drag, and pushing each
 * intermediate position through the sketch would re-render the whole graph
 * mid-drag and fill the undo stack with a hundred entries per gesture. They are
 * committed once, when the drag settles.
 *
 * Two scroll decisions, both for the phone. The wheel and a touch drag are left
 * to the page rather than captured for zoom, because a canvas that eats the
 * scroll gesture is a canvas a visitor cannot scroll past. Zoom is on the
 * buttons instead, where it can be reached deliberately.
 */

import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BUILD_NODE_TYPES, type BuildNodeData } from "@/components/build/BuildNode";
import { blockFor } from "@/components/build/blocks";
import type { Sketch } from "@/components/build/sketch";

import "@xyflow/react/dist/style.css";

export interface BuilderCanvasProps {
  sketch: Sketch;
  /**
   * Which steps React Flow currently has selected.
   *
   * It is mirrored up into the builder and handed straight back rather than
   * left to React Flow alone, because the node list is rebuilt whenever the
   * sketch changes — and a rebuild that did not carry the selection would drop
   * it the instant a nudged step committed its new position, which is exactly
   * when someone moving a step with the arrow keys needs it kept.
   */
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onMoveNodes: (positions: Record<string, { x: number; y: number }>) => void;
  onConnectNodes: (source: string, target: string, branch: string) => void;
  onRemoveNodes: (ids: string[]) => void;
  onRemoveEdges: (ids: string[]) => void;
  onDropBlock: (type: string, position: { x: number; y: number }) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

/**
 * How long a viewport move should take.
 *
 * Read at the moment of the move rather than at render, so the answer is
 * current and there is nothing to hydrate. Someone who has asked for less
 * motion gets the same new viewport, immediately, rather than a slide into it.
 */
function moveDuration(): number {
  if (typeof window === "undefined") return 0;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 280;
}

function toFlowNodes(sketch: Sketch, selectedIds: string[]): Node<BuildNodeData>[] {
  return sketch.nodes.map((node) => {
    const block = blockFor(node.type);
    return {
      id: node.id,
      type: block?.branching ? "branch" : "step",
      position: node.position,
      selected: selectedIds.includes(node.id),
      /* React Flow labels a node "Node <id>" by default. Tabbing through a
         graph and hearing eight ids is no use; the step's own name and what
         kind of thing it is, is. */
      ariaLabel: block
        ? `${node.name || block.label}, ${block.kind}`
        : `${node.name || node.id}, type not recognised`,
      data: { blockType: node.type, name: node.name },
    };
  });
}

function toFlowEdges(sketch: Sketch): Edge[] {
  const nameOf = (id: string) => sketch.nodes.find((node) => node.id === id)?.name || id;

  return sketch.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.branch || undefined,
    label: edge.branch || undefined,
    type: "smoothstep",
    /* Dashed means conditional. An edge leaving a branch is travelled only when
       that branch is chosen — the engine skips the rest rather than failing it —
       so the two kinds of edge are drawn differently. It is not decoration.

       WHY THE BRANCH EDGES ARE NOT GREEN AND ROSE. The reference draws the two
       edges out of a decision as a green "proceed" and a rose "stop", and those
       two hues are reserved in this palette for exactly that: a run continued,
       a run halted. Neither is what a branch does here. A Condition sends the
       run down `true` or `false` and a Router down one of its configured
       branches; in every case the run carries on, and the engine marks the path
       not taken skipped rather than failed. Colouring `false` rose would tell a
       credit team the run stopped when it did not, which is the one kind of
       mistake this product cannot afford. The branch's own name is on the edge
       instead, which is both accurate and readable without colour vision.
       If the engine ever gains an edge that genuinely terminates a run, that is
       the edge those two hues belong to. */
    style: {
      stroke: "var(--color-navy)",
      strokeWidth: 1.5,
      strokeDasharray: edge.branch ? "5 5" : undefined,
    },
    labelStyle: { fontSize: 10.5, fill: "var(--gv-ink-2)", fontWeight: 600 },
    labelBgStyle: { fill: "var(--gv-surface)", stroke: "var(--gv-line)" },
    labelBgPadding: [5, 2] as [number, number],
    labelBgBorderRadius: 3,
    ariaLabel: edge.branch
      ? `${nameOf(edge.source)} continues to ${nameOf(edge.target)} when the branch is ${edge.branch}`
      : `${nameOf(edge.source)} continues to ${nameOf(edge.target)}`,
  }));
}

function CanvasButton({
  children,
  label,
  onClick,
  disabled = false,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] border border-line bg-surface text-ink-2 transition-colors hover:border-navy hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-2"
    >
      {children}
    </button>
  );
}

/** Stroke-only glyphs on the same 24x24 grid as the rest of the icon set. */
function Glyph({ d }: { d: string[] }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {d.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

const UNDO = ["M4 10h10a5 5 0 0 1 0 10h-6", "M8 6l-4 4 4 4"];
const REDO = ["M20 10H10a5 5 0 0 0 0 10h6", "M16 6l4 4-4 4"];
const FIT = ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"];
const PLUS = ["M12 5v14", "M5 12h14"];
const MINUS = ["M5 12h14"];

function CanvasInner(props: BuilderCanvasProps) {
  const {
    sketch,
    selectedIds,
    onSelectionChange,
    onMoveNodes,
    onConnectNodes,
    onRemoveNodes,
    onRemoveEdges,
    onDropBlock,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
  } = props;

  const [nodes, setNodes] = useState<Node<BuildNodeData>[]>(() => toFlowNodes(sketch, selectedIds));
  const [edges, setEdges] = useState<Edge[]>(() => toFlowEdges(sketch));
  const [zoom, setZoom] = useState(1);
  const { screenToFlowPosition, zoomIn, zoomOut, fitView } = useReactFlow();

  /* Rebuild the view whenever the sketch or the selection changes. Positions
     are in the signature — unlike the console's canvas, where the definition is
     owned elsewhere — because undoing a move has to put the node back, and a
     signature that ignored positions would leave it where it was dragged. */
  const signature = useMemo(
    () =>
      JSON.stringify({
        selectedIds,
        nodes: sketch.nodes.map((n) => [n.id, n.type, n.name, n.position.x, n.position.y]),
        edges: sketch.edges.map((e) => [e.id, e.source, e.target, e.branch]),
      }),
    [sketch, selectedIds],
  );

  useEffect(() => {
    setNodes(toFlowNodes(sketch, selectedIds));
    setEdges(toFlowEdges(sketch));
    // The signature is the dependency; `sketch` and `selectedIds` are read through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  /* Changes are folded inside the updater rather than over a value read from
     the closure: a rapid drag emits changes faster than a render, and the
     closure's `nodes` would already be a frame behind. Nothing else happens in
     here — a state updater runs during render, so reaching out of one to push a
     change into the sketch would be a setState on another component mid-render.
     The sketch is updated from the drag and delete callbacks below instead,
     which are ordinary event handlers. */
  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<BuildNodeData>>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));

      /* A position change that is not part of a drag in progress is a keyboard
         nudge — React Flow moves a focused, selected node with the arrow keys,
         and announces it in its own live region. Committing it here is what
         makes that movement survive the next rebuild instead of being undone by
         it. Mid-drag changes are skipped; the drag's own stop handler commits
         once, at the end. */
      const moved: Record<string, { x: number; y: number }> = {};
      for (const change of changes) {
        if (change.type === "position" && change.dragging !== true && change.position) {
          moved[change.id] = change.position;
        }
      }
      if (Object.keys(moved).length > 0) onMoveNodes(moved);
    },
    [onMoveNodes],
  );

  const handleEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  /** One commit per gesture: the positions as they are when the drag lets go. */
  const commitDrag = useCallback(
    (dragged: Node<BuildNodeData>[]) => {
      if (dragged.length === 0) return;
      const positions: Record<string, { x: number; y: number }> = {};
      for (const node of dragged) positions[node.id] = node.position;
      onMoveNodes(positions);
    },
    [onMoveNodes],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      onConnectNodes(connection.source, connection.target, connection.sourceHandle ?? "");
    },
    [onConnectNodes],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={BUILD_NODE_TYPES}
      onNodesChange={handleNodesChange}
      onEdgesChange={handleEdgesChange}
      onNodeDragStop={(_, node, dragged) => commitDrag(dragged.length > 0 ? dragged : [node])}
      onSelectionDragStop={(_, dragged) => commitDrag(dragged)}
      onNodesDelete={(deleted) => onRemoveNodes(deleted.map((node) => node.id))}
      onEdgesDelete={(deleted) => onRemoveEdges(deleted.map((edge) => edge.id))}
      onConnect={handleConnect}
      onSelectionChange={({ nodes: chosen }) => onSelectionChange(chosen.map((node) => node.id))}
      onMove={(_, viewport) => setZoom(viewport.zoom)}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        const type = event.dataTransfer.getData("text/plain");
        if (!type) return;
        onDropBlock(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      }}
      fitView
      /* Fit, but not at any cost. The example sketch is about two thousand
         units wide, and fitting all of it into a phone — or into the middle
         column of a laptop — would shrink a node's title to a few pixels and
         present an unreadable smudge as the first thing on the page. The fit
         stops at 0.6 and the canvas opens on the middle of the graph at a size
         a node can be read at; panning, or the Fit button, which has no floor,
         reaches the rest. Legible and partial beats complete and unreadable. */
      fitViewOptions={{ padding: 0.12, minZoom: 0.6, maxZoom: 1 }}
      minZoom={0.25}
      maxZoom={1.5}
      /* See the module note: the page keeps the scroll gesture, the buttons own
         the zoom. Pinch is left on, because a pinch is never an attempt to
         scroll the page. */
      preventScrolling={false}
      zoomOnScroll={false}
      panOnScroll={false}
      zoomOnPinch
      panOnDrag
      nodesFocusable
      edgesFocusable
      nodesConnectable
      deleteKeyCode={["Backspace", "Delete"]}
      proOptions={{ hideAttribution: false }}
      className="bg-sunken"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--gv-line-strong)" />

      <Panel position="top-right" style={{ margin: 10 }}>
        <div className="flex items-center gap-1 rounded-[6px] border border-line bg-surface/95 p-1 shadow-resting backdrop-blur-sm">
          <CanvasButton label="Undo" onClick={onUndo} disabled={!canUndo}>
            <Glyph d={UNDO} />
          </CanvasButton>
          <CanvasButton label="Redo" onClick={onRedo} disabled={!canRedo}>
            <Glyph d={REDO} />
          </CanvasButton>
          <span
            className="px-1.5 text-[11.5px] font-medium text-ink-2 tabular-nums"
            aria-label={`Zoom ${Math.round(zoom * 100)} percent`}
          >
            {Math.round(zoom * 100)}%
          </span>
          <CanvasButton
            label="Fit the whole sketch in view"
            onClick={() => void fitView({ padding: 0.22, duration: moveDuration() })}
          >
            <Glyph d={FIT} />
          </CanvasButton>
        </div>
      </Panel>

      <MiniMap
        position="bottom-left"
        pannable
        zoomable
        ariaLabel="Small map of the whole sketch"
        /* Sized down from the 200x150 default so it does not take a quarter of a
           phone screen, and given its colours inline because a minimap node is
           an SVG rect that no utility class reaches. */
        style={{ margin: 10, width: 128, height: 86 }}
        maskColor="rgb(32 72 135 / 0.08)"
        /* The map follows the cards' hues rather than the model/code pair. At
           this size a dot is a position, not a reading: what makes the map
           usable is being able to find the orange one you were just looking at.
           The model/code distinction stays on the cards, where it is a word. */
        nodeColor={(node) => {
          const block = blockFor(String(node.data.blockType ?? ""));
          return `var(--gv-hue-${block?.hue ?? "slate"})`;
        }}
        nodeStrokeWidth={2}
        className="rounded-[6px] border border-line shadow-resting"
      />

      <Panel position="bottom-left" style={{ margin: 10, marginLeft: 148 }}>
        <div className="flex flex-col gap-1 rounded-[6px] border border-line bg-surface/95 p-1 shadow-resting">
          <CanvasButton label="Zoom in" onClick={() => void zoomIn({ duration: moveDuration() })}>
            <Glyph d={PLUS} />
          </CanvasButton>
          <CanvasButton label="Zoom out" onClick={() => void zoomOut({ duration: moveDuration() })}>
            <Glyph d={MINUS} />
          </CanvasButton>
        </div>
      </Panel>
    </ReactFlow>
  );
}

export function BuilderCanvas(props: BuilderCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
