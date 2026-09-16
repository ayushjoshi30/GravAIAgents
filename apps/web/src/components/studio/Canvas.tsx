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
import { NODE_TYPES, type StudioNodeData } from "@/components/studio/StudioNode";
import type {
  NodeTrace,
  StudioNodeSpec,
  StudioProblem,
  WorkflowDefinition,
  WorkflowNode,
} from "@/lib/studio";

import "@xyflow/react/dist/style.css";

/** The branches a node offers, read from its own configuration. */
export function branchesOf(node: WorkflowNode, spec: StudioNodeSpec | undefined): string[] {
  if (!spec?.branching) return [];
  if (spec.type === "condition") return ["true", "false"];
  const declared = node.config.branches;
  if (!Array.isArray(declared)) return [];
  return declared
    .map((entry) => (entry && typeof entry === "object" ? String((entry as { label?: unknown }).label ?? "") : ""))
    .filter(Boolean);
}

/** The node type the engine uses for a step that hands the decision to a person. */
const GATE_TYPE = "human_approval";

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

function toFlowNodes(
  definition: WorkflowDefinition,
  specs: Map<string, StudioNodeSpec>,
  problems: StudioProblem[],
  trace: NodeTrace[],
): Node<StudioNodeData>[] {
  const byNode = new Map<string, NodeTrace>(trace.map((entry) => [entry.node_id, entry]));

  return definition.nodes.map((node) => {
    const spec = specs.get(node.type);
    const entry = byNode.get(node.id);

    return {
      id: node.id,
      type: "studio",
      position: node.position,
      data: {
        label: node.name || spec?.label || node.type,
        type: node.type,
        // Absent from the registry, a node is drawn as deterministic: claiming
        // a node reasons when nothing here knows what it does would put a teal
        // "AI" plate on something that may well be arithmetic.
        deterministic: spec?.deterministic ?? true,
        gate: node.type === GATE_TYPE,
        // What the node says about itself, in three tiers of usefulness: the
        // last run's own line beats the registry's description, which beats
        // the plain admission that this build does not know the type.
        //
        // The registry tier is what gives every node a sentence on the canvas
        // rather than a bare title — "Sends the run down one branch.
        // Conditions are deterministic." — so a workflow can be read by
        // someone who did not draw it.
        summary: entry
          ? entry.error || entry.summary || spec?.summary
          : (spec?.summary ?? "This node type is not in this build's registry."),
        branches: branchesOf(node, spec),
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

function toFlowEdges(definition: WorkflowDefinition, trace: NodeTrace[]): Edge[] {
  const ran = new Set(trace.filter((entry) => entry.status === "ok").map((entry) => entry.node_id));
  return definition.edges.map((edge) => {
    const travelled = ran.has(edge.source) && ran.has(edge.target);
    return {
      id: edge.id || `${edge.source}->${edge.target}:${edge.branch}`,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.branch || undefined,
      label: edge.branch || undefined,
      animated: false,
      style: {
        stroke: travelled ? "var(--gv-brand)" : "var(--gv-line-strong)",
        strokeWidth: travelled ? 2 : 1.5,
      },
      labelStyle: { fontSize: 10.5, fill: "var(--gv-ink-2)" },
      labelBgStyle: { fill: "var(--gv-surface)" },
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
          nodeColor={() => "var(--gv-brand-200)"}
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
