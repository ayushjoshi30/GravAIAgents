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
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
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

/**
 * Where the Studio goes back to: the signed-in list of agents a person has
 * built, which is where they came from to get here.
 *
 * The route says "workflows" and the link says "Your agents" because both are
 * this product's own words for the same object — a workflow is what the repo
 * and the API call it, and "Your agents" is what it is called on screen. The
 * mismatch is deliberate and neither name is renamed here.
 */
const AGENTS_HREF = "/console/workflows";

export default function StudioPage() {
  const [token] = useToken();
  const router = useRouter();

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

  //: The open workflow, mirrored where an async caller can read it without
  //: waiting for a render. See `persist` for why that matters.
  const currentRef = useRef<WorkflowDetail | null>(null);
  //: The write that is in flight, or null. See `save`.
  const saving = useRef<Promise<WorkflowDetail | null> | null>(null);
  //: What the API said about the last write, kept where a caller can read it
  //: the instant that write resolves. `message` below cannot serve: it is state
  //: an awaiting caller cannot see until the next render, and it is a running
  //: commentary that the next run, compile or deploy overwrites — an alert that
  //: quoted it would sooner or later attribute an unrelated sentence to a save
  //: that failed ten seconds earlier.
  const lastWriteMessage = useRef("");
  //: True while the back link is flushing the canvas before it navigates, so
  //: the header can say the wait is a save and not a hung link.
  const [leaving, setLeaving] = useState(false);
  //: Why the last attempt to leave did not leave. Empty when there was none.
  //: Kept apart from `message`, which is a running commentary that the next
  //: action overwrites — this one is a refusal to navigate and has to stay on
  //: screen until it is dealt with.
  const [leaveError, setLeaveError] = useState("");

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

  const persist = useCallback(async () => {
    setBusy("save");
    setMessage("");
    // Read from the ref rather than from `current`, because a write can start
    // while an earlier one is still in the air — pressing ⌘S and then leaving
    // does exactly that. React will not have committed the first write's result
    // yet, so the closure still says there is no record, and a second POST
    // would put a duplicate workflow beside the one just created. The ref is
    // written the instant the server answers, which is early enough.
    const existing = currentRef.current;
    const outcome = existing
      ? await studio.save(token, existing.id, definition)
      : await studio.create(token, definition);
    lastWriteMessage.current = outcome.ok ? "" : outcome.message;
    if (outcome.ok) {
      currentRef.current = outcome.data;
      setCurrent(outcome.data);
      setSavedJson(JSON.stringify(outcome.data.definition));
      setMessage(`Saved ${outcome.data.name}`);
      // A successful write of any kind answers the "your work is unsaved"
      // notice, however it was started. Leaving it up after a manual ⌘S had
      // gone through would be the notice lying about the state of the world.
      setLeaveError("");
      void refreshList();
    } else {
      setMessage(outcome.message);
    }
    setBusy("");
    return outcome.ok ? outcome.data : null;
  }, [definition, refreshList, token]);

  /**
   * Write the canvas, and leave the promise somewhere other callers can find it.
   *
   * Registering it synchronously is the whole point. Anything that needs the
   * server to be caught up — the back link, above all — can then wait for the
   * write that is already running instead of starting a second one, and can
   * read what that write actually stored rather than guessing.
   */
  const save = useCallback((): Promise<WorkflowDetail | null> => {
    const pending = persist();
    saving.current = pending;
    void pending
      .finally(() => {
        // Only clear the slot if it is still this write's. A later write will
        // have replaced it, and clearing it then would hide a live save.
        if (saving.current === pending) saving.current = null;
      })
      // `request` resolves with a failure rather than throwing, so this arm is
      // for the genuinely unexpected. It exists so the bookkeeping copy of the
      // promise cannot surface as an unhandled rejection; every caller that
      // cares still awaits `pending` itself and reports what it gets.
      .catch(() => {});
    return pending;
  }, [persist]);

  const open = useCallback(
    async (id: string) => {
      const outcome = await studio.get(token, id);
      if (!outcome.ok) {
        setMessage(outcome.message);
        return;
      }
      currentRef.current = outcome.data;
      setCurrent(outcome.data);
      setDefinition(outcome.data.definition);
      setSavedJson(JSON.stringify(outcome.data.definition));
      history.current = [];
      future.current = [];
      setResult(null);
      setSelectedId(null);
      // The canvas this warning was about has just been replaced, so the
      // warning is about nothing.
      setLeaveError("");
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

  // --- leaving ----------------------------------------------------------

  //: Work the canvas holds and the server does not.
  //:
  //: Two cases, and they are not the same one. An open workflow is unsaved when
  //: it has moved past the JSON that came back from its last write. A workflow
  //: that was never saved has no write to have moved past, so it is compared
  //: against exactly the canvas this page starts from instead — a new canvas
  //: arrives with an input and an output node already on it, so "has nodes"
  //: would call every untouched visit unsaved and, on the way out, write an
  //: empty record for anyone who opened the Studio and changed their mind.
  //:
  //: The baseline keeps `blankWorkflow`'s own default name rather than being
  //: rebuilt around whatever is currently in the name field. That field is this
  //: header's editable h1, and typing in it is work like any other; normalising
  //: the name out of the comparison made naming an agent the one edit the chip
  //: stayed silent about and the one edit that leaving threw away without a
  //: word — while typing a description, two inches lower, was saved.
  //:
  //: Read once per render because the header states it twice: as the chip, and
  //: as the thing the back link flushes before it navigates.
  const unsaved =
    current !== null
      ? JSON.stringify(definition) !== savedJson
      : JSON.stringify(definition) !== JSON.stringify(blankWorkflow());

  /**
   * Leave for "Your agents", but not before the server has what is on screen.
   *
   * Navigating and hoping is what this replaces. A client-side route change
   * unmounts this page and takes the definition, the undo stack and the test
   * input with it, so an unsaved canvas at that moment is not delayed — it is
   * gone. The order here is therefore: wait for any write already in flight,
   * write whatever the canvas still holds beyond it, and only then move.
   *
   * If the write fails, this does not navigate. Saying nothing and leaving
   * would destroy the work; saying nothing and staying would look like a dead
   * link. It says which, and leaves the canvas exactly where it was.
   */
  const flushAndLeave = useCallback(async () => {
    // Quote the words the failed write itself came back with, read at the
    // moment it failed. The alert has to carry the status and correlation id
    // the API put in them, and it has to be this write's copy and no other.
    const withDetail = (what: string) =>
      lastWriteMessage.current ? `${what} The API said: ${lastWriteMessage.current}.` : what;

    // A previous refusal is deliberately NOT cleared here. This function is
    // what the alert's own "Try again" calls, and tearing the alert down on the
    // press would destroy the button under the pressing finger — which for
    // anyone driving this by keyboard means focus dropped to the document and a
    // Tab sequence restarted from the top. The alert stays, says "Saving…" on
    // its own button, and is cleared by the write that succeeds.

    // Nothing in flight and nothing to write: this is an ordinary link.
    if (!saving.current && !unsaved) {
      router.push(AGENTS_HREF);
      return;
    }

    setLeaving(true);
    try {
      // What the server holds once the write already running has finished. Its
      // own answer is used rather than `savedJson`, because that state will not
      // have been committed by the time this line runs and would send a second,
      // identical write.
      let written = savedJson;
      const inFlight = saving.current;
      if (inFlight) {
        const settled = await inFlight;
        if (!settled) {
          setLeaveError(withDetail("The save that was already running did not reach the server."));
          return;
        }
        written = JSON.stringify(settled.definition);
      }

      if (JSON.stringify(definition) !== written) {
        const saved = await save();
        if (!saved) {
          setLeaveError(withDetail("This agent could not be saved."));
          return;
        }
      }

      router.push(AGENTS_HREF);
    } catch {
      // `request` reports failures rather than throwing, so reaching here means
      // something outside the API client broke. The canvas is still intact, and
      // that is the part worth saying.
      setLeaveError("Something went wrong while saving.");
    } finally {
      setLeaving(false);
    }
  }, [definition, router, save, savedJson, unsaved]);

  /**
   * The back link's click.
   *
   * A modified or middle click is handed straight back to the browser: it opens
   * the list in a new tab and leaves this one, and the canvas in it, alone —
   * there is nothing to flush because nobody is going anywhere.
   */
  const onLeaveClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      if (leaving) return;
      void flushAndLeave();
    },
    [flushAndLeave, leaving],
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
        {/* The two ways out, and why there are two of them.

            The Studio is the one console route that hides the sidebar, because
            a canvas wants the 252px more than a person in a canvas wants a nav.
            That makes whatever sits here load-bearing rather than decorative: a
            full-screen route you cannot leave is a trap, and this one was one
            once already.

            "Your agents" is the new link and it does NOT replace the wordmark.
            They answer two different questions. The wordmark is the corner of
            every console page — the mark you press when you want out of
            wherever you are — and deleting it would make this the only route in
            the console whose top-left corner does not go home. "Your agents" is
            narrower and more useful: it is the list this agent belongs to and,
            nearly always, the page you were on a moment ago. Keeping only the
            wordmark would send someone who came from the list back to the
            Overview and make them find the list again.

            The chevron moved with the meaning. On the wordmark it read as a
            vague "back"; on a link that names a destination it says which way
            back, which is what a chevron is for. */}
        <Link
          href="/console"
          aria-label="Leave the Studio and return to the console"
          className="-ml-1 flex shrink-0 items-center rounded-[6px] px-1.5 py-1 hover:bg-surface-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
        >
          <GravAIWordmark height={19} />
        </Link>

        {/* The back link flushes before it navigates, so it is not a plain
            anchor — but it stays an anchor, so it keeps a real href for the
            status bar, for ⌘-click, and for anyone driving this page by
            keyboard. `aria-busy` is how the wait is announced without the
            accessible name changing underneath a screen reader mid-press. */}
        <Link
          href={AGENTS_HREF}
          onClick={onLeaveClick}
          aria-busy={leaving || undefined}
          title={
            unsaved
              ? "Save this agent and go back to Your agents"
              : "Go back to Your agents"
          }
          className="flex shrink-0 items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-[13px] font-medium text-ink-3 hover:bg-surface-2 hover:text-ink hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
        >
          <Icon name="chevron" size={13} className="rotate-180" />
          Your agents
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

        {unsaved ? <span className="gv-chip gv-chip-amber">unsaved changes</span> : null}

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
              // The ref has to be cleared with the state it mirrors, or the
              // next save would PUT this blank canvas over the workflow that
              // was open a moment ago.
              currentRef.current = null;
              setCurrent(null);
              setDefinition(blankWorkflow());
              setResult(null);
              setProblems([]);
              setSavedJson("");
              setLeaveError("");
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

      {/* What happened when someone tried to leave.

          A refusal to navigate has to be visible, because from the reader's
          side a link that did nothing is indistinguishable from a link that is
          broken — and the difference here is whether their work still exists.
          It is `role="alert"`, not a line in the header's running `message`,
          because the next save or run would overwrite that and take the only
          notice of the failure with it.

          Both ways forward are offered and neither is hidden: try the save
          again, or go without it and lose the changes. The second is spelled
          out rather than dressed up, since that is exactly what it does.

          `leaveError` already carries the API's own sentence, captured when the
          write failed. It is not read out of `message` here: that line is the
          header's running commentary, and the next run or deploy would replace
          it while this alert was still up, leaving the alert to introduce an
          unrelated sentence with "The API said". */}
      {leaveError ? (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-red bg-red-tint px-4 py-2 text-[12.5px] text-red-ink"
        >
          <span>
            {leaveError} Nothing has moved — this canvas is still exactly as you left it, and
            the changes since your last save exist nowhere else. You can try again, or go
            without saving and lose them.
          </span>
          {/* Busy, not disabled. A disabled button is removed from the tab
              order the moment it is pressed, which throws a keyboard user's
              focus back to the document; `aria-busy` says the same thing and
              leaves the focus where the person put it. The second press is
              turned away in the handler instead. */}
          <Button
            size="sm"
            variant="secondary"
            aria-busy={leaving || undefined}
            onClick={() => {
              if (leaving) return;
              void flushAndLeave();
            }}
          >
            {leaving ? "Saving…" : "Try again"}
          </Button>
          <Link href={AGENTS_HREF} className="gv-link text-[12.5px] text-red-ink">
            Leave without saving
          </Link>
        </div>
      ) : leaving ? (
        // The wait is a save, not a hung link. Said out loud as well as shown,
        // because the thing that is slow is off screen.
        <p
          role="status"
          className="shrink-0 border-b border-line bg-surface-2 px-4 py-2 text-[12.5px] text-ink-2"
        >
          Saving this agent before opening Your agents…
        </p>
      ) : null}

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
