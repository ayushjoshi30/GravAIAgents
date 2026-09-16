"use client";

/**
 * The workflow canvas.
 *
 * This owns the React Flow instance and translates between its node/edge shape
 * and the workflow definition the backend stores. The translation is one-way at
 * a time and explicit on purpose: the definition is the truth, React Flow's
 * state is a view of it, and letting the two drift is how a canvas starts
 * saving something other than what is on screen.
 *
 * Positions are the exception — they change on every drag, and pushing each
 * intermediate position through the definition would re-render the whole graph
 * mid-drag. They are read back out of the instance when the definition is next
 * needed.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { NODE_TYPES, hueOf, type StudioNodeData } from "@/components/studio/StudioNode";
import { NODE_BY_TYPE } from "@/lib/nodeCatalog";
import type {
  NodeTrace,
  StudioNodeSpec,
  StudioProblem,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from "@/lib/studio";

import "@xyflow/react/dist/style.css";

/**
 * Whether a node sends the run down one of several paths.
 *
 * The API's own spec is the authority, because it is the build that will
 * actually execute the workflow. The generated catalog is the fallback for the
 * case the console hits and the sketchpad cannot: a definition that names a
 * node the library response did not include — an older saved workflow, or a
 * library request that has not landed yet. Getting this wrong draws a splitting
 * node as an ordinary card with one output, which loses a branch rather than
 * merely mis-colouring one.
 */
function isBranching(type: string, spec: StudioNodeSpec | undefined): boolean {
  return spec?.branching ?? NODE_BY_TYPE[type]?.branching ?? false;
}

/** The branches a node offers, read from its own configuration. */
export function branchesOf(node: WorkflowNode, spec: StudioNodeSpec | undefined): string[] {
  if (!isBranching(node.type, spec)) return [];
  // A Condition's two outcomes are fixed by the engine — see `_branch_labels`
  // in `gravai_workflow/graph.py`. Everything else declares its own.
  if (node.type === "condition") return ["true", "false"];
  const declared = node.config.branches;
  if (!Array.isArray(declared)) return [];
  return declared
    .map((entry) => (entry && typeof entry === "object" ? String((entry as { label?: unknown }).label ?? "") : ""))
    .filter(Boolean);
}

/**
 * A rupee cost that is worth printing.
 *
 * The API sends `cost_inr` as a decimal string so the figure survives the trip
 * without a float rounding it. A node that cost nothing — every deterministic
 * one — should say nothing rather than "₹0.00", which reads as a measurement
 * when it is really the absence of one.
 */
function costOf(entry: NodeTrace | undefined): number | undefined {
  if (!entry) return undefined;
  const value = Number(entry.cost_inr);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/* What a node is given to say when no tier of this build has heard of its type.
   Having been run does not teach the console what the node was, so the
   admission is the same with a trace as without one: a card that has run and
   then says nothing at all about itself is the worse of the two. */
const UNKNOWN_TYPE = "This node type is not in this build's registry.";

function toFlowNodes(
  definition: WorkflowDefinition,
  specs: Map<string, StudioNodeSpec>,
  problems: StudioProblem[],
  trace: NodeTrace[],
): Node<StudioNodeData>[] {
  const byNode = new Map<string, NodeTrace>(trace.map((entry) => [entry.node_id, entry]));

  return definition.nodes.map((node) => {
    const spec = specs.get(node.type);
    const catalog = NODE_BY_TYPE[node.type];
    const entry = byNode.get(node.id);
    const label = node.name || spec?.label || catalog?.label || node.type;
    const branches = branchesOf(node, spec);

    return {
      id: node.id,
      // A branching node is a diamond and everything else is a card. The shape
      // is decided here rather than inside the component because React Flow
      // picks the renderer from the node's `type`, and drawing a split as a
      // card is what the reference design is right to object to.
      type: isBranching(node.type, spec) ? "studioBranch" : "studio",
      position: node.position,
      /* React Flow labels a node "Node <id>" by default. Tabbing through a
         graph and hearing eight ids is no use; the node's own name and what it
         is, is. */
      ariaLabel: `${label}, ${node.type}`,
      data: {
        label,
        type: node.type,
        // Absent from both the API and the generated catalog, nothing here
        // knows whether this node reasons or computes, so the absence is passed
        // through rather than either guess. Defaulting to `false` printed the
        // navy "code" chip — this palette's promise that a figure was reached by
        // deterministic code — over something that may equally have been model
        // output. The chip now prints "unknown", which is the only true thing
        // this build can say about a type it has never heard of.
        usesLlm: spec?.uses_llm ?? catalog?.usesLlm,
        // What the node says about itself, in four tiers of usefulness: the
        // last run's own line beats the API's description, which beats the
        // generated catalog's, which beats the plain admission that this build
        // does not know the type.
        //
        // The two registry tiers are what give every node a sentence on the
        // canvas rather than a bare title — "Sends the run down one branch.
        // Conditions are deterministic." — so a workflow can be read by someone
        // who did not draw it. Nothing here is written for the canvas; every
        // sentence is the engine's own.
        summary: entry
          ? entry.error || entry.summary || spec?.summary || catalog?.summary || UNKNOWN_TYPE
          : (spec?.summary ?? catalog?.summary ?? UNKNOWN_TYPE),
        // Stated where a node cannot do the whole of what its name implies. The
        // API is preferred because it is the build that will run; it sends an
        // empty string where there is nothing to say, so the fall-through has
        // to test for emptiness rather than for absence.
        caveat: spec?.caveat || catalog?.caveat || undefined,
        branches,
        problems: problems
          .filter((problem) => problem.node_id === node.id)
          .map((problem) => ({ severity: problem.severity, message: problem.message })),
        trace: entry
          ? {
              status: entry.status,
              durationMs: entry.duration_ms,
              costInr: costOf(entry),
            }
          : undefined,
      },
    };
  });
}

/**
 * The connections, and the two things their drawing says.
 *
 * SHAPE SAYS WHETHER THE EDGE IS ALWAYS TAKEN. An edge out of a branching node
 * is followed only when that branch is chosen — the engine prunes the rest and
 * marks them skipped — so it is dashed, and the main path is solid. The branch's
 * own name is printed on it either way, which is what makes two branches
 * tellable apart with no colour vision at all.
 *
 * COLOUR SAYS WHAT HAPPENED, AND ONLY ONCE SOMETHING HAS. Green and rose are
 * reserved in this palette for outcome — a run proceeded, a run stopped — and a
 * run is the only thing that can earn them. An edge whose two ends both ran is
 * green: the run went this way. An edge into a node that failed is rose: the run
 * stopped here. Everything else is the neutral line, including every edge on a
 * canvas that has not been tested, because an untested workflow has no outcomes
 * to report.
 *
 * WHY THE BRANCH EDGES ARE NOT THEMSELVES GREEN AND ROSE. The reference design
 * draws the two edges out of a decision as a green "proceed" and a rose "stop",
 * and the sketchpad at /build already declined to copy that for the same reason
 * this canvas does. Neither hue describes what a branch does here. A Condition
 * sends the run down `true` or `false` and a Router down one of its configured
 * branches; in every case the run carries on, and `engine.py` marks the path not
 * taken skipped rather than failed. Tinting the `false` edge rose would tell a
 * credit team the run halted when it did not — a fabricated outcome, and the one
 * kind of mistake this product cannot afford. The hues are used above instead,
 * where the trace makes them true. (The engine does have a genuine halt: Human
 * Approval, which is not a branch at all, and which says so on its own card.)
 *
 * WHY A BRANCH EDGE HAS TO CLEAR ONE MORE TEST THAN AN ORDINARY ONE. A node's
 * status says that it ran; it does not say which way in the run came, and that
 * only matters where a branch point prunes the paths it did not take. Consider a
 * workflow whose `true` edge goes straight to the decision and whose `false`
 * edge reaches that same decision through an underwriter: whichever branch was
 * taken, the condition is marked ok and the decision is marked ok, so a rule
 * reading only the two ends would tint BOTH edges green and tell a credit team
 * the run went down a branch it never took. That is the same fabricated outcome
 * this file refuses to draw anywhere else, so a branch edge earns a tint only
 * when every other way into its target is closed — a parent that did not run, or
 * was skipped, or failed — and stays the neutral line when the trace genuinely
 * cannot say. An ordinary edge needs no such test: a node that is not a branch
 * point prunes nothing, so a successor that ran, ran after it.
 *
 * None of this is signalled by colour alone. A tinted edge only ever agrees with
 * the status already printed in words on the nodes at both of its ends, and each
 * edge carries the whole sentence in `ariaLabel`.
 */
function toFlowEdges(definition: WorkflowDefinition, trace: NodeTrace[]): Edge[] {
  const status = new Map(trace.map((entry) => [entry.node_id, entry.status]));
  const nameOf = (id: string) => definition.nodes.find((node) => node.id === id)?.name || id;

  /* True when some other edge into the same target came from a node that ran,
     which is exactly the case where this edge cannot be shown to be the way the
     run arrived. Compared by identity rather than by id, because an edge a
     visitor has just drawn has not been saved and need not have one yet. */
  const otherLiveParent = (edge: WorkflowEdge) =>
    definition.edges.some(
      (other) =>
        other !== edge && other.target === edge.target && status.get(other.source) === "ok",
    );

  return definition.edges.map((edge) => {
    const left = status.get(edge.source);
    const right = status.get(edge.target);
    // Only a branch edge can be ambiguous, and only when its target had another
    // live way in. Everything else is as certain as the two node statuses are.
    const certain = !edge.branch || !otherLiveParent(edge);
    const travelled = left === "ok" && right === "ok" && certain;
    const stopped = left === "ok" && right === "failed" && certain;

    const outcome = travelled ? " — the run went this way" : stopped ? " — the run stopped here" : "";

    return {
      id: edge.id || `${edge.source}->${edge.target}:${edge.branch}`,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.branch || undefined,
      label: edge.branch || undefined,
      animated: false,
      style: {
        stroke: travelled
          ? "var(--gv-hue-green)"
          : stopped
            ? "var(--gv-hue-rose)"
            : "var(--gv-line-strong)",
        strokeWidth: travelled || stopped ? 2 : 1.5,
        // Dashed describes the edge, tinted describes the run, so a branch that
        // was taken is drawn dashed and green rather than promoted to solid.
        strokeDasharray: edge.branch ? "5 5" : undefined,
      },
      labelStyle: { fontSize: 10.5, fill: "var(--gv-ink-2)", fontWeight: 600 },
      labelBgStyle: { fill: "var(--gv-surface)", stroke: "var(--gv-line)" },
      labelBgPadding: [5, 2] as [number, number],
      labelBgBorderRadius: 3,
      ariaLabel: edge.branch
        ? `${nameOf(edge.source)} continues to ${nameOf(edge.target)} when the branch is ${edge.branch}${outcome}`
        : `${nameOf(edge.source)} continues to ${nameOf(edge.target)}${outcome}`,
    };
  });
}

function CanvasInner({
  definition,
  specs,
  problems,
  trace,
  selectedId,
  onSelect,
  onChange,
  onDrop,
}: {
  definition: WorkflowDefinition;
  specs: Map<string, StudioNodeSpec>;
  problems: StudioProblem[];
  trace: NodeTrace[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (next: WorkflowDefinition) => void;
  onDrop: (type: string, position: { x: number; y: number }) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StudioNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { screenToFlowPosition } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

  // Rebuild the view whenever the definition or the overlays change. Positions
  // are excluded from the trigger deliberately: see the module note.
  const signature = useMemo(
    () =>
      JSON.stringify({
        nodes: definition.nodes.map((n) => [n.id, n.type, n.name, n.config]),
        edges: definition.edges.map((e) => [e.source, e.target, e.branch]),
        problems: problems.map((p) => [p.node_id, p.severity, p.message]),
        trace: trace.map((t) => [
          t.node_id,
          t.status,
          t.duration_ms,
          t.cost_inr,
          t.summary,
          t.error,
        ]),
      }),
    [definition, problems, trace],
  );

  useEffect(() => {
    setNodes(toFlowNodes(definition, specs, problems, trace));
    setEdges(toFlowEdges(definition, trace));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, specs]);

  /** Push positions back into the definition once a drag settles. */
  const commitPositions = useCallback(
    (changed: NodeChange[]) => {
      const moved = changed.filter(
        (change) => change.type === "position" && change.dragging === false,
      );
      if (moved.length === 0) return;
      setNodes((current) => {
        const positions = new Map(current.map((node) => [node.id, node.position]));
        onChange({
          ...definition,
          nodes: definition.nodes.map((node) => ({
            ...node,
            position: positions.get(node.id) ?? node.position,
          })),
        });
        return current;
      });
    },
    [definition, onChange, setNodes],
  );

  const handleNodesChange = useCallback(
    (changed: NodeChange[]) => {
      onNodesChange(changed as NodeChange<Node<StudioNodeData>>[]);
      commitPositions(changed);

      const removed = changed
        .filter((change) => change.type === "remove")
        .map((change) => (change as { id: string }).id);
      if (removed.length > 0) {
        onChange({
          ...definition,
          nodes: definition.nodes.filter((node) => !removed.includes(node.id)),
          edges: definition.edges.filter(
            (edge) => !removed.includes(edge.source) && !removed.includes(edge.target),
          ),
        });
      }
    },
    [commitPositions, definition, onChange, onNodesChange],
  );

  const handleEdgesChange = useCallback(
    (changed: EdgeChange[]) => {
      onEdgesChange(changed as EdgeChange<Edge>[]);
      const removed = changed
        .filter((change) => change.type === "remove")
        .map((change) => (change as { id: string }).id);
      if (removed.length > 0) {
        onChange({
          ...definition,
          edges: definition.edges.filter((edge) => !removed.includes(edge.id)),
        });
      }
    },
    [definition, onChange, onEdgesChange],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;

      const branch = connection.sourceHandle ?? "";
      const id = `${connection.source}->${connection.target}${branch ? `:${branch}` : ""}`;
      if (definition.edges.some((edge) => edge.id === id)) return;

      setEdges((current) => addEdge({ ...connection, id }, current));
      onChange({
        ...definition,
        edges: [
          ...definition.edges,
          { id, source: connection.source, target: connection.target, branch },
        ],
      });
    },
    [definition, onChange, setEdges],
  );

  return (
    <div ref={wrapper} className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          const type = event.dataTransfer.getData("text/plain");
          if (!type) return;
          onDrop(
            type,
            screenToFlowPosition({ x: event.clientX, y: event.clientY }),
          );
        }}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: false }}
        deleteKeyCode={["Backspace", "Delete"]}
        multiSelectionKeyCode={["Shift", "Meta", "Control"]}
        selectionOnDrag
        panOnScroll
        nodesFocusable
        defaultEdgeOptions={{ type: "smoothstep" }}
        className="bg-sunken"
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--gv-line)" />
        <Controls showInteractive={false} className="!shadow-sm" />
        <MiniMap
          pannable
          zoomable
          nodeStrokeWidth={2}
          /* The minimap takes each node's own hue, so the overview and the
             canvas agree on which blob is which — the whole use of a minimap on
             a graph too big to read is recognising a node by its colour.
             Interpolating the hue into a custom property NAME is safe in a way
             interpolating it into a Tailwind class is not: this string is read
             by the browser at paint time, not by the compiler at build time. The
             `var()` fallback covers a hue the stylesheet has never heard of. */
          nodeColor={(node) =>
            `var(--gv-hue-${hueOf(String((node.data as StudioNodeData)?.type ?? ""))}, var(--gv-hue-slate))`
          }
          maskColor="rgba(255,255,255,0.7)"
          className="!border !border-line !bg-surface"
        />
      </ReactFlow>
      {selectedId ? null : null}
    </div>
  );
}

export function Canvas(props: Parameters<typeof CanvasInner>[0]) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
