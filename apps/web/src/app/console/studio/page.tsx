"use client";

/**
 * GravAI Agent Studio.
 *
 * Three modes over one workflow definition: BUILD draws it, TEST runs it and
 * shows what every node did, DEPLOY freezes it into a version and gives it an
 * endpoint.
 *
 * The definition is the single source of truth. The canvas renders it, the
 * config panel edits it, validation annotates it, and a run is executed against
 * it server-side — the browser never interprets a workflow, it only edits one.
 * That separation is what makes a deployed agent behave the same whether it is
 * called from this page or by a cron job six months later.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@/components/studio/Canvas";
import { ConfigPanel } from "@/components/studio/ConfigPanel";
import { DeployPanel } from "@/components/studio/DeployPanel";
import { NodeLibrary } from "@/components/studio/NodeLibrary";
import { TestPanel } from "@/components/studio/TestPanel";
import { WorkflowInspector } from "@/components/studio/WorkflowInspector";
import { Icon } from "@/components/icons/AgentIcon";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/Field";
import { useToken } from "@/lib/session";
import {
  blankWorkflow,
  defaultConfig,
  nextNodeId,
  studio,
  type NodeLibrary as Library,
  type RunResult,
  type RunSummary,
  type StudioNodeSpec,
  type StudioProblem,
  type WorkflowDefinition,
  type WorkflowDetail,
  type WorkflowSummary,
} from "@/lib/studio";

type Mode = "build" | "test" | "deploy";

const MODES = [
  { value: "build", label: "Build" },
  { value: "test", label: "Test" },
  { value: "deploy", label: "Deploy" },
];

export default function StudioPage() {
  const [token] = useToken();

  const [library, setLibrary] = useState<Library | null>(null);
  const [libraryError, setLibraryError] = useState("");
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [current, setCurrent] = useState<WorkflowDetail | null>(null);
  const [definition, setDefinition] = useState<WorkflowDefinition>(() => blankWorkflow());
  const [problems, setProblems] = useState<StudioProblem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("build");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  //: What was last written to the server, so the page can say when the canvas
  //: has moved past it. Runs and validation both use the stored version.
  const [savedJson, setSavedJson] = useState("");

  const [inputText, setInputText] = useState("{}");
  const [result, setResult] = useState<RunResult | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  //: The schema the test input was last seeded from, so someone's own edits
  //: are not overwritten every time the definition object changes identity.
  const seeded = useRef("");

  // Undo is a stack of whole definitions. They are small, and diffing a graph
  // to store deltas would cost more in complexity than it saves in memory.
  const history = useRef<WorkflowDefinition[]>([]);
  const future = useRef<WorkflowDefinition[]>([]);

  const specs = useMemo(() => {
    const map = new Map<string, StudioNodeSpec>();
    for (const family of library?.families ?? []) {
      for (const spec of family.nodes) map.set(spec.type, spec);
    }
    return map;
  }, [library]);

  const blocking = problems.filter((problem) => problem.severity === "error");

  // --- loading ----------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const outcome = await studio.nodes(token);
      if (cancelled) return;
      if (outcome.ok) setLibrary(outcome.data);
      else setLibraryError(outcome.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const refreshList = useCallback(async () => {
    const outcome = await studio.list(token);
    if (outcome.ok) setWorkflows(outcome.data);
  }, [token]);

  const refreshRuns = useCallback(async () => {
    const outcome = await studio.runs(token);
    if (outcome.ok) setRuns(outcome.data);
  }, [token]);

  useEffect(() => {
    void refreshList();
    void refreshRuns();
  }, [refreshList, refreshRuns]);

  // --- validation -------------------------------------------------------

  const revalidate = useCallback(
    async (id: string) => {
      const outcome = await studio.validate(token, id);
      if (outcome.ok) setProblems(outcome.data.problems);
    },
    [token],
  );

  // Validation runs against what the server has stored, so it is re-checked
  // after a save rather than on every keystroke. Checking the local draft
  // instead would report a graph the engine will never see.
  useEffect(() => {
    if (current) void revalidate(current.id);
  }, [current, revalidate]);

  /**
   * Seed the test input from the Input node's declared schema.
   *
   * Without this, TEST accepts any JSON while a deployed agent enforces the
   * compiled schema — so a workflow that tested perfectly is refused the moment
   * it is called by name, which is the worst possible moment to find out.
   * Starting from the declaration makes the two agree from the outset.
   */
  useEffect(() => {
    const input = definition.nodes.find((node) => node.type === "input");
    const schema = input?.config?.schema;
    if (!schema || typeof schema !== "object") return;

    const signature = JSON.stringify(schema);
    if (seeded.current === signature) return;
    seeded.current = signature;

    const example: Record<string, unknown> = {};
    for (const [name, kind] of Object.entries(schema as Record<string, unknown>)) {
      const type = String(kind);
      example[name] = type === "number" ? 0 : type === "boolean" ? false : "";
    }
    setInputText(JSON.stringify(example, null, 2));
  }, [definition]);

  // --- editing ----------------------------------------------------------

  const apply = useCallback(
    (next: WorkflowDefinition) => {
      history.current = [...history.current.slice(-49), definition];
      future.current = [];
      setDefinition(next);
    },
    [definition],
  );

  const undo = useCallback(() => {
    const previous = history.current.pop();
    if (!previous) return;
    future.current.push(definition);
    setDefinition(previous);
  }, [definition]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    history.current.push(definition);
    setDefinition(next);
  }, [definition]);

  const addNode = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      const spec = specs.get(type);
      if (!spec) return;
      const id = nextNodeId(type, definition.nodes);
      apply({
        ...definition,
        nodes: [
          ...definition.nodes,
          {
            id,
            type,
            name: spec.label,
            config: defaultConfig(spec),
            position: position ?? { x: 360, y: 60 + definition.nodes.length * 30 },
          },
        ],
      });
      setSelectedId(id);
    },
    [apply, definition, specs],
  );

  const updateConfig = useCallback(
    (nodeId: string, name: string, value: unknown) => {
      apply({
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.id === nodeId ? { ...node, config: { ...node.config, [name]: value } } : node,
        ),
      });
    },
    [apply, definition],
  );

  const removeNode = useCallback(
    (nodeId: string) => {
      apply({
        ...definition,
        nodes: definition.nodes.filter((node) => node.id !== nodeId),
        edges: definition.edges.filter(
          (edge) => edge.source !== nodeId && edge.target !== nodeId,
        ),
      });
      setSelectedId(null);
    },
    [apply, definition],
  );

  const duplicateNode = useCallback(
    (nodeId: string) => {
      const original = definition.nodes.find((node) => node.id === nodeId);
      if (!original) return;
      const id = nextNodeId(original.type, definition.nodes);
      apply({
        ...definition,
        nodes: [
          ...definition.nodes,
          {
            ...original,
            id,
            name: `${original.name} copy`,
            config: { ...original.config },
            position: { x: original.position.x + 40, y: original.position.y + 40 },
          },
        ],
      });
      setSelectedId(id);
    },
    [apply, definition],
  );

  // --- persistence ------------------------------------------------------

  const save = useCallback(async () => {
    setBusy("save");
    setMessage("");
    const outcome = current
      ? await studio.save(token, current.id, definition)
      : await studio.create(token, definition);
    if (outcome.ok) {
      setCurrent(outcome.data);
      setSavedJson(JSON.stringify(outcome.data.definition));
      setMessage(`Saved ${outcome.data.name}`);
      void refreshList();
    } else {
      setMessage(outcome.message);
    }
    setBusy("");
    return outcome.ok ? outcome.data : null;
  }, [current, definition, refreshList, token]);

  const open = useCallback(
    async (id: string) => {
      const outcome = await studio.get(token, id);
      if (!outcome.ok) {
        setMessage(outcome.message);
        return;
      }
      setCurrent(outcome.data);
      setDefinition(outcome.data.definition);
      setSavedJson(JSON.stringify(outcome.data.definition));
      history.current = [];
      future.current = [];
      setResult(null);
      setSelectedId(null);
    },
    [token],
  );

  const run = useCallback(async () => {
    let inputs: Record<string, unknown> = {};
    try {
      inputs = JSON.parse(inputText || "{}");
    } catch {
      return;
    }

    // The server runs the stored draft, so an unsaved canvas is saved first.
    // Running the local one instead would produce a trace for a definition
    // that never existed as a record, which is exactly what makes a run
    // impossible to reconstruct afterwards.
    let workflow = current;
    if (!workflow || JSON.stringify(definition) !== savedJson) {
      setBusy("run");
      workflow = await save();
      if (!workflow) {
        setBusy("");
        return;
      }
    }

    setBusy("run");
    setResult(null);
    const outcome = await studio.run(token, workflow.id, inputs);
    if (outcome.ok) {
      setResult(outcome.data);
      void refreshRuns();
      void revalidate(workflow.id);
    } else {
      setMessage(outcome.message);
    }
    setBusy("");
  }, [current, definition, inputText, refreshRuns, revalidate, save, savedJson, token]);

  const compile = useCallback(
    async (version: string, description: string) => {
      if (!current) return;
      setBusy("compile");
      const outcome = await studio.compile(token, current.id, version, description);
      setMessage(outcome.ok ? `Compiled v${outcome.data.version}` : outcome.message);
      if (outcome.ok) await open(current.id);
      setBusy("");
    },
    [current, open, token],
  );

  const deploy = useCallback(
    async (versionId: string) => {
      if (!current) return;
      setBusy(`deploy:${versionId}`);
      const outcome = await studio.deploy(token, current.id, versionId);
      setMessage(
        outcome.ok
          ? `Deployed v${outcome.data.deployed.version}` +
            (outcome.data.retired ? `, retiring v${outcome.data.retired}` : "")
          : outcome.message,
      );
      if (outcome.ok) await open(current.id);
      setBusy("");
    },
    [current, open, token],
  );

  // --- keyboard ---------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      if (event.key === "s") {
        event.preventDefault();
        void save();
      } else if (event.key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((event.key === "z" && event.shiftKey) || event.key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [redo, save, undo]);

  const selected = definition.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedSpec = selected ? specs.get(selected.type) : undefined;
  //: The canvas has moved past what the server holds. Read once per render
  //: because the header states it twice — as a chip and in the save affordance.
  const dirty = current !== null && JSON.stringify(definition) !== savedJson;

  if (!token) {
    return (
      <div className="flex h-[70vh] items-center justify-center px-6">
        <div className="gv-card max-w-md p-6 text-center">
          <h1 className="gv-page-title">Agent Studio</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            The studio reads its node library and runs workflows through the API, so it cannot
            draw anything without a token. Add one and this page will load its library.
          </p>
          <Link href="/console/settings" className="gv-link mt-3 inline-block text-[13px]">
            Open Settings
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-var(--gv-console-header,64px))] min-h-0 flex-col">
      {/* --- header ---------------------------------------------------- */}
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        <div className="min-w-0">
          {/* `gv-page-title` is drawn at 26–32px, which is right for a document
              page and wrong here: this header is a tool bar sitting on top of a
              canvas that wants every pixel of height. The display face and the
              weight are what carry the system; the size is not. It is, though,
              now the page's only h1 — the studio had none at all. */}
          <h1>
            <input
              value={definition.name}
              onChange={(event) => setDefinition({ ...definition, name: event.target.value })}
              aria-label="Agent name"
              className="w-full max-w-[280px] truncate border-0 bg-transparent p-0 font-display text-[20px] leading-tight font-semibold text-ink outline-none focus:ring-0"
            />
          </h1>
          <p className="gv-id text-[11px] text-ink-3">
            {current ? current.id : "unsaved"} · {definition.nodes.length} nodes ·{" "}
            {definition.edges.length} connections
          </p>
        </div>

        <div className="ml-2">
          <SegmentedControl
            label="Mode"
            value={mode}
            options={MODES}
            onChange={(value) => setMode(value as Mode)}
          />
        </div>

        {blocking.length > 0 ? (
          <span className="gv-chip gv-chip-red">
            <span className="gv-dot bg-bad" aria-hidden="true" />
            {blocking.length} to fix
          </span>
        ) : definition.nodes.length > 0 ? (
          <span className="gv-chip gv-chip-green">
            <span className="gv-dot bg-ok" aria-hidden="true" />
            valid
          </span>
        ) : null}

        {dirty ? <span className="gv-chip gv-chip-amber">unsaved changes</span> : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {message ? <span className="text-[12px] text-ink-2">{message}</span> : null}

          <select
            value={current?.id ?? ""}
            onChange={(event) => {
              if (event.target.value) void open(event.target.value);
            }}
            aria-label="Open a workflow"
            className="gv-input h-8 w-[150px] text-[12.5px]"
          >
            <option value="">Open…</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setCurrent(null);
              setDefinition(blankWorkflow());
              setResult(null);
              setProblems([]);
              setSavedJson("");
              history.current = [];
            }}
          >
            New
          </Button>
          <Button size="sm" variant="secondary" onClick={undo} aria-label="Undo">
            <Icon name="chevron" size={12} className="rotate-90" />
          </Button>
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={busy === "save"}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>

      {libraryError ? (
        <p className="border-b border-red bg-red-tint px-4 py-2 text-[12.5px] text-red-ink">
          The node library could not be loaded: {libraryError}. Until it can be, the sidebar has
          no nodes to offer and nothing new can be added to the canvas.
        </p>
      ) : null}

      {/* --- body ------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1">
        {mode === "build" ? (
          <aside className="hidden w-[248px] shrink-0 border-r border-line bg-surface lg:block">
            <NodeLibrary families={library?.families ?? []} onAdd={(type) => addNode(type)} />
          </aside>
        ) : null}

        <main className="min-w-0 flex-1">
          {mode === "deploy" ? (
            <DeployPanel
              workflow={current}
              inputSchema={
                (definition.nodes.find((node) => node.type === "input")?.config?.schema ??
                  {}) as Record<string, unknown>
              }
              problems={blocking.length}
              onCompile={(version, description) => void compile(version, description)}
              onDeploy={(versionId) => void deploy(versionId)}
              busy={busy}
              runs={runs}
              message={message}
            />
          ) : (
            <Canvas
              definition={definition}
              specs={specs}
              problems={problems}
              trace={mode === "test" ? (result?.trace ?? []) : []}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChange={apply}
              onDrop={(type, position) => addNode(type, position)}
            />
          )}
        </main>

        {/* The right column is never empty in BUILD. A selected node shows its
            own configuration; with nothing selected it shows the workflow —
            its name, the signature a caller will have to satisfy, how the
            engine will run it, and which version is live. A panel that
            disappears when you click the background makes the canvas feel like
            it lost something. */}
        {mode === "build" ? (
          selected && selectedSpec ? (
            <ConfigPanel
              node={selected}
              spec={selectedSpec}
              problems={problems.filter((problem) => problem.node_id === selected.id)}
              onChange={(name, value) => updateConfig(selected.id, name, value)}
              onRename={(name) =>
                apply({
                  ...definition,
                  nodes: definition.nodes.map((node) =>
                    node.id === selected.id ? { ...node, name } : node,
                  ),
                })
              }
              onDuplicate={() => duplicateNode(selected.id)}
              onDelete={() => removeNode(selected.id)}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <div className="hidden min-[1100px]:block">
              <WorkflowInspector
                definition={definition}
                workflow={current}
                onChange={apply}
                onCompileAndDeploy={() => setMode("deploy")}
                busy={busy}
                problems={blocking.length}
                onClose={() => setMode("deploy")}
              />
            </div>
          )
        ) : null}

        {/* The test panel is clamped against the viewport as well as fixed at
            420, so a narrow screen loses canvas rather than pushing the whole
            page sideways. The phone treatment the redesign calls for — library
            and test as sheets — is not in this package and is not attempted
            here. */}
        {mode === "test" ? (
          <aside className="flex w-[min(420px,60vw)] shrink-0 flex-col border-l border-line bg-surface">
            <TestPanel
              inputText={inputText}
              onInputText={setInputText}
              running={busy === "run"}
              onRun={() => void run()}
              result={result}
              canRun={blocking.length === 0}
              blockedReason={
                blocking.length > 0 ? `${blocking.length} problem(s) to fix in Build.` : ""
              }
            />
          </aside>
        ) : null}
      </div>

      {/* --- problems --------------------------------------------------- */}
      {mode === "build" && problems.length > 0 ? (
        <footer
          aria-label="Validation problems"
          className="gv-scroll-y max-h-28 shrink-0 overflow-y-auto border-t border-line bg-surface px-4 py-2"
        >
          <ul className="space-y-1">
            {problems.map((problem, index) => (
              <li
                key={`${problem.node_id}-${index}`}
                className="flex items-start gap-2 text-[12px] leading-relaxed"
              >
                <span
                  className={`mt-px shrink-0 ${problem.severity === "error" ? "text-bad" : "text-warn"}`}
                >
                  <Icon name="warning" size={12} />
                </span>
                <button
                  type="button"
                  onClick={() => problem.node_id && setSelectedId(problem.node_id)}
                  className="text-left text-ink-2 hover:text-ink"
                >
                  {problem.message}
                </button>
              </li>
            ))}
          </ul>
        </footer>
      ) : null}
    </div>
  );
}
