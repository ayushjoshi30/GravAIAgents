"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AgentCard } from "@/components/console/AgentCard";
import { ConsolePage } from "@/components/console/ConsoleShell";
import {
  FlowThumbnail,
  type FlowThumbnailEdge,
  type FlowThumbnailNode,
} from "@/components/console/FlowThumbnail";
import { NewAgentDialog } from "@/components/console/NewAgentDialog";
import { Skeleton, toast } from "@/components/console/primitives";
import { Button, ButtonLink } from "@/components/ui/Button";
import { SegmentedControl, SelectField, TextField } from "@/components/ui/Field";
import { ApiFailureBanner, EmptyState, UnknownRatherThanEmpty } from "@/components/ui/States";
import {
  api,
  type ApiFailure,
  type WorkflowCard as WorkflowCardData,
  type WorkflowSort,
} from "@/lib/api";
import { formatCount } from "@/lib/format";
import { useSession } from "@/lib/session";

/**
 * Your agents — the workflows this person has built in the Studio.
 *
 * Not to be confused with two neighbours it is often mistaken for. `/agents` is
 * the public catalogue of the agents GravAI ships, which nobody here built.
 * `/build` is a public sketchpad that saves nothing. This page lists the things
 * that exist, in a tenant, under an owner, and every one of them can be opened,
 * renamed, copied and deleted. In code they are "workflows", which is the
 * repository's own word for them and the word the API speaks; "agents" is what
 * they are called in front of a reader, because that is what someone thinks
 * they are making.
 *
 * THE RULE THIS PAGE IS BUILT AROUND. Four situations look alike from a
 * distance and are completely different to the person in front of the screen:
 * nobody has supplied a token, so nothing was ever asked; the request was made
 * and failed; the request succeeded and this tenant genuinely has no agents;
 * and the request succeeded but the search matched none of the forty agents
 * that do exist. Each one has a different next action — set a token, retry,
 * build something, clear the search — so each one is rendered as itself. The
 * expensive mistake is the last pair: telling someone with forty agents that
 * they have never built anything.
 */

/**
 * How many cards one request asks for.
 *
 * The API caps `limit` at 200 and this is far below that on purpose: the point
 * of a page is that the first screenful arrives quickly, and every card carries
 * a thumbnail payload. Past this the list pages rather than growing, and the
 * count in the header keeps coming from the server's `total` rather than from
 * how many cards happen to have been fetched.
 */
const PAGE_SIZE = 24;

const SORTS: { value: WorkflowSort; label: string }[] = [
  { value: "last_edited", label: "Last edited" },
  { value: "name", label: "Name" },
  { value: "created", label: "Created" },
];

const SORT_VALUES = SORTS.map((option) => option.value);

const VIEWS = [
  { value: "grid", label: "Grid" },
  { value: "list", label: "List" },
];

type View = "grid" | "list";

const VIEW_VALUES: View[] = ["grid", "list"];

/**
 * How long the search box waits before asking the server.
 *
 * Search is a server round trip rather than a filter over the loaded page, so
 * every keystroke would otherwise be a request. A quarter of a second is about
 * the gap between two characters of ordinary typing, which means a word typed
 * at speed asks once rather than seven times.
 */
const SEARCH_DEBOUNCE_MS = 250;

/* ---------- Remembered preferences ----------------------------------------

   The sort and the view are remembered the way `lib/session.ts` remembers the
   token: a module-level listener set, `useSyncExternalStore`, and every read
   and write wrapped so that a browser with storage disabled degrades to the
   default rather than throwing on render.

   It is duplicated here rather than added to `session.ts` because that module
   is owned elsewhere and holds one thing — who you are and where the API is.
   A view toggle is not session state. The keys share the `gravai.console.`
   prefix so the two stay findable together in a storage inspector.

   They are stored per user, keyed by the token's subject. Two people who use
   the same browser should not inherit each other's sort order, and someone who
   pastes a different tenant's token is, as far as this page is concerned, a
   different person. */

const preferenceListeners = new Set<() => void>();

function readPreference(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* Private browsing or storage disabled. The choice still applies to this
         session; it just does not survive a reload. */
    }
  }
  preferenceListeners.forEach((listener) => listener());
}

function subscribeToPreferences(listener: () => void): () => void {
  preferenceListeners.add(listener);
  if (typeof window !== "undefined") window.addEventListener("storage", listener);
  return () => {
    preferenceListeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", listener);
  };
}

/**
 * One remembered choice, validated on the way out.
 *
 * `allowed` is not decoration: what comes back from localStorage is whatever
 * was last written there, including a sort key from a build where the options
 * were different. Trusting it would send an unknown `sort` to the API and get a
 * 422 for a value nobody can see or change.
 */
function usePreference<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (value: T) => void] {
  const stored = useSyncExternalStore(
    subscribeToPreferences,
    () => readPreference(key),
    // The server has no localStorage, so it renders the default and React
    // re-renders with the stored value after hydration. Returning null rather
    // than reading anything is what keeps the two passes agreeing.
    () => null,
  );
  const value = allowed.includes(stored as T) ? (stored as T) : fallback;
  const set = useCallback((next: T) => writePreference(key, next), [key]);
  return [value, set];
}

/* ---------- The empty state's illustration -------------------------------- */

/**
 * Three nodes and the edge running through them, drawn by the same component
 * that draws a real card's thumbnail.
 *
 * Reusing `FlowThumbnail` rather than drawing a bespoke picture is the point:
 * what someone sees before they have built anything is a faded version of what
 * their first card will look like, in the node hues the canvas uses. A separate
 * illustration would be a promise made in a different visual language from the
 * one the product answers in.
 *
 * The types are real entries in the generated node catalogue, so they resolve
 * to real hues. It is decoration, so it is hidden from assistive technology and
 * the sentence beneath it carries the whole meaning.
 *
 * Three nodes, and the one edge that runs through them drawn as the two hops it
 * actually is: a straight line of three plates reads as a flow, whereas two
 * connected nodes and a third floating beside them reads as a mistake.
 * Coordinates are in canvas units — the same space `blankWorkflow` seeds — and
 * `FlowThumbnail` scales whatever box they describe to fit its frame.
 */
const EMPTY_SKETCH_NODES: FlowThumbnailNode[] = [
  { id: "input", type: "input", x: 60, y: 120 },
  { id: "llm", type: "llm", x: 300, y: 120 },
  { id: "output", type: "output", x: 540, y: 120 },
];

const EMPTY_SKETCH_EDGES: FlowThumbnailEdge[] = [
  { source: "input", target: "llm" },
  { source: "llm", target: "output" },
];

/* ---------- Loading ------------------------------------------------------- */

/**
 * Cards in outline, not a spinner.
 *
 * A spinner says "wait"; a block the shape of what is coming says "cards are
 * coming, this many, in this arrangement", and the layout does not jump when
 * they land. `.gv-skeleton`'s shimmer is already switched off — not slowed —
 * under `prefers-reduced-motion` by the theme.
 */
function SkeletonCards({ view }: { view: View }) {
  const count = view === "grid" ? 6 : 4;
  return (
    <>
      {/* The outlines are decoration and are hidden, which would leave a screen
          reader with an empty page and no idea one was waiting. The sentence
          says what the shapes say. */}
      <p role="status" className="sr-only">
        Loading your agents…
      </p>
      <SkeletonList view={view} count={count} />
    </>
  );
}

function SkeletonList({ view, count }: { view: View; count: number }) {
  return (
    <ul
      aria-hidden="true"
      className={
        view === "grid"
          ? "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
          : "grid grid-cols-1 gap-2.5"
      }
    >
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="gv-card min-w-0 p-4">
          {view === "grid" ? <Skeleton h={96} /> : null}
          <div className={view === "grid" ? "mt-3.5 grid gap-2" : "grid gap-2"}>
            <Skeleton h={15} w="62%" />
            <Skeleton h={12} w="88%" />
            <Skeleton h={12} w="40%" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ---------- The page ------------------------------------------------------ */

interface ListState {
  items: WorkflowCardData[];
  /**
   * The server's count of everything matching, which is not `items.length` —
   * or null when the server did not tell us.
   *
   * The count travels in the `X-Total-Count` header, and a cross-origin browser
   * cannot read a header the API has not put in `Access-Control-Expose-Headers`.
   * Today it has not, so null is the case this page will actually meet, and it
   * is a third answer rather than a missing one: not "sixty", not "none", but
   * "this browser was not told". Every sentence below that could print a total
   * has a null branch for exactly that reason.
   */
  total: number | null;
  /** How many rows the server has handed over, which paging counts from. */
  loaded: number;
  /**
   * Whether there is reason to believe another page exists.
   *
   * With a total it is arithmetic. Without one it is the only honest signal
   * left: a page that came back full is a page the limit may have cut short.
   * That makes "Load more" an offer to look rather than a claim that there is
   * something there — and the last press, which comes back with nothing, is
   * what ends it.
   */
  more: boolean;
  /** True only for the very first list this page ever showed. Drives the intro. */
  intro: boolean;
}

/**
 * Whether to offer another page, given what the server said.
 *
 * Kept in one function because the two branches have to stay in step: the
 * arithmetic one is right whenever there is a total, and the "the page came
 * back full" one is what is left when there is not.
 */
function hasMore(total: number | null, loaded: number, pageLength: number, asked: number): boolean {
  if (total !== null) return loaded < total;
  return pageLength >= asked;
}

/**
 * The search term as the page repeats it back.
 *
 * A search box takes as much text as someone cares to paste, and the two places
 * this page quotes it are a centred heading and the page description — neither
 * of which breaks a long unspaced run, so a pasted identifier would push the
 * layout wider than a 360px screen and give the whole page a horizontal scroll.
 * Cutting the echo is a change to how the query is DISPLAYED and to nothing
 * else: the untouched string is what was sent, and the count beside it is the
 * count for the whole of it.
 */
const ECHO_MAX = 32;

function echo(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > ECHO_MAX ? `${trimmed.slice(0, ECHO_MAX)}…` : trimmed;
}

/**
 * The narrowest shape this page reads out of a card's callbacks.
 *
 * `AgentCard` hands back the whole workflow the server confirmed. This page
 * only ever needs to know which row it was and what it is now called, and
 * asking for less is what keeps the two files from having to agree on the
 * payload's every field: a handler that accepts `{ id, name }` is satisfied by
 * any card shape that has them.
 */
interface ConfirmedRow {
  id: string;
  name: string;
}

/* Moving a count the server already moved.
 *
 * One agent was created, so there is one more agent: that is not a number this
 * page invented, it is the server's own number plus an action the server has
 * already confirmed. An unknown total, though, stays unknown — a count nobody
 * gave us does not become known by adding one to it, and `null + 1` is the kind
 * of arithmetic that puts "NaN agents" in a heading. */
function plusOne(total: number | null): number | null {
  return total === null ? null : total + 1;
}

function minusOne(total: number | null): number | null {
  return total === null ? null : Math.max(0, total - 1);
}

export default function ConsoleWorkflowsPage() {
  const session = useSession();
  const token = session.token;

  // Preferences are scoped to the token's subject. A token with no readable
  // subject claim — an opaque key rather than a JWT — still gets a stable
  // bucket of its own rather than sharing one with everybody else's.
  const scope = session.claims?.subject ?? "default";
  const [sort, setSort] = usePreference<WorkflowSort>(
    `gravai.console.workflows.sort:${scope}`,
    SORT_VALUES,
    "last_edited",
  );
  const [view, setView] = usePreference<View>(
    `gravai.console.workflows.view:${scope}`,
    VIEW_VALUES,
    "grid",
  );

  // `query` is what is in the box; `search` is what has been asked for. They
  // differ for a quarter of a second, and the difference is what stops the
  // "nothing matched" state from flashing up mid-word.
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const [state, setState] = useState<ListState | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [paging, setPaging] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Whether any list has ever landed. Read once, when a list arrives, to decide
  // whether this is the first one — which is the only time the cards animate.
  const hasLoaded = useRef(false);

  /**
   * Serial number of the most recent request that is allowed to change the list.
   *
   * Every path that replaces or extends the rows takes a ticket and checks it
   * before it writes: the first-page effect, the re-read after a mutation, and
   * the next page. Without this the three can land out of order and the loser
   * is always honesty — a re-read started before the search changed carries
   * rows for the old query and would drop them under the new query's heading
   * and the new query's count, which is the page stating something the server
   * never said. The same check stops a failure from a request nobody is waiting
   * on any more from raising a banner over a list that loaded perfectly well.
   */
  const listTicket = useRef(0);

  /**
   * Fetch the first page for the current query and sort.
   *
   * `nonce` is the retry handle. Changing the search or the sort discards the
   * loaded rows rather than keeping them under a new heading, because rows that
   * matched the previous query are not an approximation of the new answer —
   * they are the old answer, wearing the new query's label.
   */
  useEffect(() => {
    if (!token) {
      setState(null);
      setFailure(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    // Takes the ticket as well as aborting, so that a re-read or a "load more"
    // already in flight for the PREVIOUS query cannot land on this one.
    const ticket = (listTicket.current += 1);

    setState(null);
    setFailure(null);

    api
      .listWorkflows(token, { q: search, sort, limit: PAGE_SIZE, offset: 0 }, controller.signal)
      .then((result) => {
        if (cancelled || ticket !== listTicket.current) return;
        if (result.ok) {
          const first = !hasLoaded.current;
          hasLoaded.current = true;
          setState({
            items: result.data.items,
            total: result.data.total,
            loaded: result.data.items.length,
            more: hasMore(result.data.total, result.data.items.length, result.data.items.length, PAGE_SIZE),
            intro: first,
          });
          setFailure(null);
        } else {
          setFailure(result);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [token, search, sort, nonce]);

  /**
   * Re-read the rows already on screen, without emptying the page first.
   *
   * Used after a rename, a copy, a delete or a restore. The local edit that
   * precedes it is the part a person sees immediately; this is the part that
   * makes the card honest again, because a rename also moves `updated_at` and
   * can move the row's place in the order, and neither of those is something
   * this page is entitled to work out for itself.
   */
  const refresh = useCallback(async () => {
    if (!token) return;
    // Every row currently on screen, in one request, so that paging past the
    // first page does not collapse back to twenty-four rows the moment someone
    // renames something. Capped at the limit the endpoint enforces; asking for
    // more is a 422 rather than a longer list.
    const reread = Math.min(Math.max(PAGE_SIZE, state?.loaded ?? 0), 200);

    // Two mutations in quick succession start two re-reads, and they can come
    // back in either order. Only the newest is allowed to land: an older
    // answer overwriting a newer one would put a row back that has just gone.
    const ticket = (listTicket.current += 1);

    const result = await api.listWorkflows(token, {
      q: search,
      sort,
      limit: reread,
      offset: 0,
    });
    if (ticket !== listTicket.current) return;
    if (!result.ok) {
      setFailure(result);
      return;
    }
    setFailure(null);
    setState({
      items: result.data.items,
      total: result.data.total,
      loaded: result.data.items.length,
      more: hasMore(result.data.total, result.data.items.length, result.data.items.length, reread),
      intro: false,
    });
  }, [token, search, sort, state?.loaded]);

  const loadMore = useCallback(async () => {
    if (!token || !state || paging) return;
    setPaging(true);
    // Reads the ticket without taking one. A page of rows is only ever appended
    // to the list it was asked for, so anything that replaces that list — a new
    // search, a re-read after a rename — invalidates this page rather than the
    // other way round.
    const ticket = listTicket.current;
    const result = await api.listWorkflows(token, {
      q: search,
      sort,
      limit: PAGE_SIZE,
      offset: state.loaded,
    });
    // Cleared before the ticket is checked: an abandoned page still has to let
    // go of the button, or "Load more" stays disabled for a list it was never
    // loading in the first place.
    setPaging(false);
    if (ticket !== listTicket.current) return;
    if (!result.ok) {
      setFailure(result);
      return;
    }
    setFailure(null);
    setState((previous) =>
      previous
        ? {
            items: [...previous.items, ...result.data.items],
            total: result.data.total,
            loaded: previous.loaded + result.data.items.length,
            more: hasMore(
              result.data.total,
              previous.loaded + result.data.items.length,
              result.data.items.length,
              PAGE_SIZE,
            ),
            intro: false,
          }
        : previous,
    );
  }, [token, state, paging, search, sort]);

  /* ---------- What the cards report back --------------------------------- */

  /*
    The three callbacks below are past tense on purpose: the card makes the
    request and tells this page what the server already did. The optimistic
    edit, its rollback and the undo window after a delete all live in the card,
    beside the control that started them, which is where a failure has to be
    reported — a card that reverts its own name silently while the page says
    something cheerful elsewhere is exactly the failure the honesty rule is
    about. `onDeleted` in particular fires only once the undo window has closed
    without being used, so a row leaves this list when its deletion is final and
    not a moment earlier.

    What is left for this page is the list and the count. Each callback applies
    the change locally so the list reacts at once, then re-reads. The counts
    moved here are derived from a server action that has already succeeded,
    which is a different thing from a count invented locally: one agent was
    created, so there is one more agent. If the re-read fails, the banner says
    so, and the number left on screen is the last one the server actually gave.
  */

  const handleRenamed = useCallback(
    (workflow: ConfirmedRow) => {
      setState((previous) =>
        previous
          ? {
              ...previous,
              // The name comes from the server's response rather than from the
              // text field: the API trims what it is given, so the two differ
              // for anyone who typed a trailing space.
              items: previous.items.map((item) =>
                item.id === workflow.id ? { ...item, name: workflow.name } : item,
              ),
              intro: false,
            }
          : previous,
      );
      // A rename also moves `updated_at`, and can move the row's place under
      // either of the two orderings that depend on it. Neither is something
      // this page may work out for itself, so it asks.
      void refresh();
    },
    [refresh],
  );

  const handleDuplicated = useCallback(
    (created: ConfirmedRow) => {
      setState((previous) =>
        previous ? { ...previous, total: plusOne(previous.total), intro: false } : previous,
      );
      toast(`Copied to “${created.name}”.`, { tone: "ok" });
      void refresh();
    },
    [refresh],
  );

  const handleDeleted = useCallback(
    (workflow: ConfirmedRow) => {
      setState((previous) =>
        previous
          ? {
              ...previous,
              items: previous.items.filter((item) => item.id !== workflow.id),
              total: minusOne(previous.total),
              loaded: Math.max(0, previous.loaded - 1),
              intro: false,
            }
          : previous,
      );
      void refresh();
    },
    [refresh],
  );

  const handleCreated = useCallback(
    (created: ConfirmedRow) => {
      setDialogOpen(false);
      setState((previous) =>
        previous ? { ...previous, total: plusOne(previous.total), intro: false } : previous,
      );
      toast(`“${created.name}” created.`, { tone: "ok" });
      void refresh();
    },
    [refresh],
  );

  /* ---------- What the header says --------------------------------------- */

  const searching = search.trim().length > 0;

  /**
   * The count, and only ever the server's count.
   *
   * While the first request is in flight, or after it failed, there is no
   * honest number to print, so none is printed. When a search is running the
   * total is the size of the matching set, and the sentence says so rather than
   * letting a filtered figure read as the whole collection.
   */
  const description = useMemo(() => {
    if (!token) return "The agents you have built in the Studio.";
    if (!state) return "The agents you have built in the Studio.";

    // No total came back — the count is in a header this browser is not allowed
    // to read. What IS known is how many rows arrived, so that is what gets
    // said, in words that cannot be mistaken for a total: "24 loaded" is a fact
    // about this page, and the second sentence says plainly that the size of
    // the collection is not a fact this page has.
    if (state.total === null) {
      const noun = state.items.length === 1 ? "agent" : "agents";
      const loaded = `${formatCount(state.items.length)} ${noun} loaded`;
      return searching
        ? `${loaded} for “${echo(search)}”. The API did not report how many match in all.`
        : `${loaded}. The API did not report how many you have in all.`;
    }

    const noun = state.total === 1 ? "agent" : "agents";
    if (searching) {
      return `${formatCount(state.total)} ${noun} ${state.total === 1 ? "matches" : "match"} “${echo(search)}”.`;
    }
    return `${formatCount(state.total)} ${noun} built in the Studio.`;
  }, [token, state, searching, search]);

  const items = state?.items ?? null;

  /**
   * Loading is derived rather than tracked.
   *
   * A `busy` flag set inside the effect is false for the first paint, because
   * effects run after it — so the page would show its "nothing here" branch for
   * one frame before the skeletons appeared. Having a token, no rows and no
   * failure is exactly the set of facts that means "the answer is on its way",
   * and it is true from the very first render.
   */
  const loading = Boolean(token) && !state && !failure;

  /**
   * True only in the one case where the collection itself is empty.
   *
   * A total that is known and greater than zero rules this out even when no
   * rows are on screen, which is the window right after the first agent is
   * created: the total moved the moment the server confirmed the creation, the
   * rows arrive one round trip later, and for that moment the page would
   * otherwise print "6 agents built in the Studio" over "Nothing built yet".
   * Two statements about the same tenant that cannot both be true is precisely
   * what the honesty rule is there to prevent, and the weaker one goes.
   */
  const trulyEmpty =
    state !== null && state.items.length === 0 && !state.total && !searching;

  // Nothing to search, sort or lay out when there is nothing. The toolbar would
  // be three controls over an empty page, and the first thing to do is not to
  // filter.
  const showToolbar = Boolean(token) && !trulyEmpty;

  return (
    <ConsolePage
      title="Your agents"
      description={description}
      actions={
        <Button variant="primary" onClick={() => setDialogOpen(true)} disabled={!token}>
          New agent
        </Button>
      }
    >
      {showToolbar ? (
        <div className="gv-card grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,200px)_auto]">
          <TextField
            label="Search"
            type="search"
            value={query}
            onChange={setQuery}
            placeholder="Name or description"
            hint="Searched by the API across every agent you have, not only the ones on screen."
          />
          <SelectField
            label="Sort by"
            value={sort}
            onChange={(next) => setSort(next as WorkflowSort)}
            options={SORTS}
          />
          <div className="flex items-end">
            <SegmentedControl
              label="Card layout"
              value={view}
              options={VIEWS}
              onChange={(next) => setView(next as View)}
            />
          </div>
        </div>
      ) : null}

      {/* A failure while rows are already on screen is reported above them
          rather than in place of them: the rows are still the last true answer
          the server gave, and throwing them away would cost information to
          report the loss of information. */}
      {failure && items ? (
        <ApiFailureBanner
          failure={failure}
          onRetry={() => setNonce((n) => n + 1)}
          what="your agents"
        />
      ) : null}

      {/* STATE 1 — nobody asked. Not an error and not an empty collection: this
          console has no login, so the token pasted into Settings is the whole
          of signing in, and the fix is a link rather than a retry. */}
      {!token ? (
        <EmptyState title="No API token set">
          <p>
            This console reads your agents straight from the GravAI API with the bearer token you
            supply. Until there is one, nothing has been asked for — so this page is not saying you
            have no agents, only that it has not looked.
          </p>
          <p className="mt-2">
            <ButtonLink href="/console/settings" variant="primary" size="sm">
              Open Settings
            </ButtonLink>
          </p>
        </EmptyState>
      ) : loading ? (
        /* STATE 2 — loading. */
        <SkeletonCards view={view} />
      ) : failure && !items ? (
        /* STATE 3 — the request failed. The banner carries the HTTP status and
           the correlation id, which are what let someone find this exact
           request in the API's own logs. */
        <div className="grid gap-3">
          <ApiFailureBanner
            failure={failure}
            onRetry={() => setNonce((n) => n + 1)}
            what="your agents"
          />
          <UnknownRatherThanEmpty>
            How many agents you have is unknown, not zero. Nothing has been deleted and nothing is
            missing — this page simply did not get an answer.
          </UnknownRatherThanEmpty>
        </div>
      ) : items && items.length === 0 && searching ? (
        /* STATE 4 — the search matched nothing. Distinct from having none,
           because the person may well have forty, and the action that helps is
           clearing the query rather than building something. */
        <EmptyState title={`No agent matches “${echo(search)}”`}>
          <p>
            The API searched every agent on your account, not only the ones loaded here. Try a
            shorter word, or clear the search to see all of them.
          </p>
          <p className="mt-2">
            <Button
              size="sm"
              onClick={() => {
                setQuery("");
                setSearch("");
              }}
            >
              Clear search
            </Button>
          </p>
        </EmptyState>
      ) : trulyEmpty ? (
        /* STATE 5 — genuinely none. The one state where "you have built
           nothing" is a true sentence, and the only one that offers to start
           something. Nothing loaded AND nothing claimed to exist: a known total
           above zero sends this to the list below instead, where an empty grid
           with "Showing 0 of 6" is at least not a lie about the tenant. */
        <div className="gv-card-flat px-6 py-12 text-center">
          <div className="mx-auto max-w-[320px] opacity-40" aria-hidden="true">
            <FlowThumbnail nodes={EMPTY_SKETCH_NODES} edges={EMPTY_SKETCH_EDGES} density="card" />
          </div>
          <p className="mt-5 text-[15px] font-semibold text-ink">
            Nothing built yet. Start with a blank canvas or borrow a template.
          </p>
          <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-3">
            An agent is a few steps wired together in the{" "}
            <Link href="/console/studio" className="gv-link">
              Studio
            </Link>{" "}
            — read a document, judge it, decide. Either button opens the same short form, where the
            starter is chosen and the agent is named.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={() => setDialogOpen(true)}>
              Blank canvas
            </Button>
            <Button onClick={() => setDialogOpen(true)}>From template</Button>
          </div>
        </div>
      ) : items ? (
        /* STATE 6 — agents. */
        <div className="grid gap-4">
          <ul
            className={
              view === "grid"
                ? "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
                : "grid grid-cols-1 gap-2.5"
            }
          >
            {items.map((item, index) => (
              <li
                key={item.id}
                /* `empty:hidden` is load-bearing rather than tidiness. A card
                   whose delete is staged renders nothing while its undo window
                   is open, so that it leaves the grid the instant the menu item
                   is pressed — but a grid cell with nothing in it is still a
                   grid cell, and the row would close up around a hole. The
                   wrapper goes when its card does, and comes back if the undo
                   is used. */
                className={`min-w-0 empty:hidden ${state?.intro ? "gv-rise" : ""}`}
                /* The stagger runs on the first list this page ever shows and
                   never again, because a filter change is a new answer rather
                   than an arrival — cards that re-animate on every keystroke
                   turn a search box into a slot machine. The delay is capped at
                   the seventh card so the last one on a full page is not still
                   waiting half a second in; with the 200ms of `.gv-rise` the
                   whole entrance finishes under 300ms.

                   `backwards` fill matters: without it a delayed card would
                   paint at full opacity, blink out, and rise. Under
                   `prefers-reduced-motion` the theme sets `.gv-rise` to
                   `animation: none`, which stops the movement outright rather
                   than slowing it down, and the inline delay then applies to
                   nothing. */
                style={
                  state?.intro
                    ? {
                        animationDelay: `${Math.min(index, 6) * 16}ms`,
                        animationFillMode: "backwards",
                      }
                    : undefined
                }
              >
                <AgentCard
                  workflow={item}
                  view={view}
                  onRenamed={handleRenamed}
                  onDuplicated={handleDuplicated}
                  onDeleted={handleDeleted}
                />
              </li>
            ))}
          </ul>

          {/* The footer states both numbers because they answer different
              questions: how much is on screen, and how much there is. Neither
              is inferred from the other. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[12.5px] text-ink-3">
              {state && state.total !== null ? (
                <>
                  Showing {formatCount(items.length)} of {formatCount(state.total)}.
                </>
              ) : (
                /* No total to count towards. "Showing 24" is still true and
                   still useful; "of 24" would be the page quietly promoting the
                   rows it happens to hold into the size of the collection. */
                <>Showing {formatCount(items.length)}. The API did not report a total.</>
              )}
            </p>
            {state?.more ? (
              <Button onClick={loadMore} disabled={paging}>
                {paging ? "Loading…" : "Load more"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* The create flow lives in its own file. This page agrees with it on
          three props and nothing else: whether it is open, how it closes, and
          what it hands back when something was made. `onCreated` takes the
          narrowest shape this page actually reads — an id and a name — so that
          the dialog stays free to pass the whole created workflow. */}
      <NewAgentDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={handleCreated}
      />
    </ConsolePage>
  );
}
