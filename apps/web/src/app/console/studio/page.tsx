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
import { GravAIWordmark } from "@/brand/Logo";
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
  // Both side panes can be put away, because on a laptop they cost 248 + 300 of
  // about 1280 — nearly half the width — and someone laying out a wide graph
  // wants that back. They are remembered per session rather than persisted: a
  // hidden panel is a temporary state for a particular task, and having the
  // studio open one day with its library missing and no memory of closing it is
  // worse than reopening it each visit.
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
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
      // The shell now hands this route a box exactly one viewport tall with no
      // padding of its own, so the no-token card centres in that box and brings
      // its own inset. It scrolls rather than clips because on a short window
      // the card is the only thing here and losing the link to Settings would
      // leave a reader with no way out of the state the card is describing.
      <div className="gv-scroll-y flex h-full items-center justify-center overflow-y-auto p-6">
        <div className="gv-card max-w-md p-6 text-center">
          <h1 className="gv-page-title">Agent Studio</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            The studio reads its node library and runs workflows through the API, so it cannot
            draw anything without a token. Add one and this page will load its library.
          </p>
          {/* Two ways out, because this route hides the console sidebar and
              this branch renders instead of the top bar that carries the other
              exit. Without the second link a reader arriving here with no token
              would be on a full-screen page with no navigation at all — and the
              one thing they might want, if they cannot add a token, is simply
              to leave. */}
          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
            <Link href="/console/settings" className="gv-link text-[13px]">
              Open Settings
            </Link>
            <Link href="/console" className="gv-link text-[13px] text-ink-2">
              Back to the console
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    // The studio fills the height the console shell gives it, which for this
    // one route is the viewport — or the shell's 560px floor when the window is
    // shorter than that, in which case the page scrolls rather than clipping
    // whatever the panes could not fit. It used to subtract a `--gv-console-header`
    // that no stylesheet in this app ever defines, so the fallback in the
    // expression was the only value it ever had: the canvas was cut short by a
    // guessed 64px on desktop, where the console has no header above it at all.
    // `h-full` asks the parent instead of guessing, and the parent now knows.
    //
    // Everything below is `shrink-0` except the three columns, so the canvas is
    // what grows when the window does and the bars stay the height they need.
    // `overflow-hidden` keeps a long panel inside its own scroller rather than
    // letting it push the toolbar off the top of the screen.
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* --- header ---------------------------------------------------- */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        {/* The way out.
            
            The Studio is the one console route that hides the sidebar, because
            a canvas wants the 252px more than a person in a canvas wants a nav.
            That makes this link load-bearing rather than decorative: it is the
            only exit, and a full-screen route you cannot leave is a trap.
            
            It carries the wordmark as well as the word, so the top-left corner
            still behaves the way the top-left corner of every other console
            page does — the place you press to get back out. */}
        <Link
          href="/console"
          aria-label="Leave the Studio and return to the console"
          className="-ml-1 flex shrink-0 items-center gap-2 rounded-[6px] px-1.5 py-1 text-ink-3 hover:bg-surface-2 hover:text-ink hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
        >
          <Icon name="chevron" size={13} className="rotate-180" />
          <GravAIWordmark height={19} />
        </Link>

        <span aria-hidden="true" className="h-5 w-px shrink-0 bg-line" />

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
          {/* Put a pane away, and get it back.
              
              Both live here rather than only as an X on each panel, because a
              control that can only close is half a control: once the library is
              gone there is nothing left on screen to press to bring it back,
              and a person who hid it by accident has no way to undo that
              without knowing to reload. These stay put whichever state the
              panes are in.
              
              `aria-pressed` rather than swapping the label, so a screen reader
              hears one stable control with a state instead of two controls that
              replace each other. Shown only in BUILD, where the panes exist. */}
          {mode === "build" ? (
            <>
              <Button
                size="sm"
                variant={libraryOpen ? "secondary" : "ghost"}
                onClick={() => setLibraryOpen((open) => !open)}
                aria-pressed={libraryOpen}
                title={libraryOpen ? "Hide the node library" : "Show the node library"}
                className="hidden lg:inline-flex"
              >
                Nodes
              </Button>
              <Button
                size="sm"
                variant={panelOpen ? "secondary" : "ghost"}
                onClick={() => setPanelOpen((open) => !open)}
                aria-pressed={panelOpen}
                title={panelOpen ? "Hide the workflow panel" : "Show the workflow panel"}
                className="hidden lg:inline-flex"
              >
                Workflow
              </Button>
            </>
          ) : null}
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={busy === "save"}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>

      {libraryError ? (
        <p className="shrink-0 border-b border-red bg-red-tint px-4 py-2 text-[12.5px] text-red-ink">
          The node library could not be loaded: {libraryError}. Until it can be, the sidebar has
          no nodes to offer and nothing new can be added to the canvas.
        </p>
      ) : null}

      {/* --- body -------------------------------------------------------
          The row that gets whatever height the header and the problems footer
          leave over, which is most of the screen. `min-h-0` is what lets it
          actually shrink to that: a flex child defaults to its content's size,
          and without this the three panes would push the row taller than the
          viewport and the footer off the bottom. `overflow-hidden` is the
          promise the panes rely on — each of them scrolls inside itself, and
          none of them may scroll this. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {mode === "build" && libraryOpen ? (
          // The library is as tall as the row and scrolls its own families;
          // `overflow-hidden` here so the search field it pins to its top stays
          // put while the list beneath it moves.
          <aside className="hidden w-[248px] shrink-0 overflow-hidden border-r border-line bg-surface lg:block">
            <NodeLibrary families={library?.families ?? []} onAdd={(type) => addNode(type)} />
          </aside>
        ) : null}

        {/* The canvas column: the tallest thing on the screen, and the one that
            takes every pixel the panes on either side do not. `min-h-0` and
            `min-w-0` together stop a wide node or a long deploy panel from
            stretching it past the viewport in either direction.

            A `section` rather than the `main` this used to be. The console
            shell already renders a `main` around every route — the one the skip
            link lands in — and a second one inside it is invalid and gives a
            screen reader two "main" landmarks to choose between, which is one
            more than the word means. It keeps a landmark and a name, and the
            name follows the mode, because in DEPLOY this column is not a
            canvas and calling it one would be a label that lies. */}
        <section
          aria-label={mode === "deploy" ? "Deployment" : "Canvas"}
          className="min-h-0 min-w-0 flex-1 overflow-hidden"
        >
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
        </section>

        {/* The right column is never empty in BUILD. A selected node shows its
            own configuration; with nothing selected it shows the workflow —
            its name, the signature a caller will have to satisfy, how the
            engine will run it, and which version is live. A panel that
            disappears when you click the background makes the canvas feel like
            it lost something. */}
        {mode === "build" && panelOpen ? (
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
            <div className="hidden min-h-0 min-[1100px]:block">
              <WorkflowInspector
                definition={definition}
                workflow={current}
                onChange={apply}
                onCompileAndDeploy={() => setMode("deploy")}
                busy={busy}
                problems={blocking.length}
                // Closes the panel. It used to call setMode("deploy"), so
                // dismissing the workflow panel silently threw you into the
                // Deploy tab — a close button that navigates is a close button
                // that lies, and this one moved you to the one mode where a
                // mistaken click has consequences.
                onClose={() => setPanelOpen(false)}
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
          <aside className="flex w-[min(420px,60vw)] min-h-0 shrink-0 flex-col overflow-hidden border-l border-line bg-surface">
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
