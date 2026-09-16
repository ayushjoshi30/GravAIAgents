"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { DecisionWorkspace, MIN_NOTE, type RecordedOutcome } from "@/components/console/DecisionWorkspace";
import { Chip, SevChip, Skeleton, ToastHost, toast, type Tone } from "@/components/console/primitives";
import { Button } from "@/components/ui/Button";
import { StatGrid, StatTile } from "@/components/ui/Stat";
import { DataModeBanner, UnknownRatherThanEmpty } from "@/components/ui/States";
import { api, type TaskOut } from "@/lib/api";
import { formatCount, formatDateIst, formatDateTimeIst } from "@/lib/format";
import {
  KIND_LABEL,
  bySla,
  relatedItems,
  slaOf,
  submitDecision,
  toReviewItem,
  type ItemAction,
  type ItemKind,
  type ReviewItem,
  type SlaState,
} from "@/lib/review-model";
import { useSession } from "@/lib/session";
import { useResource, type DataMode } from "@/lib/useResource";

/**
 * Review queue — the screen on which a person decides a credit application.
 *
 * The queue and the workspace sit on one route on purpose. The console this
 * replaced made a reader open a list, decide that something needed them, then
 * navigate to a second page and find the same item again. Here the list is the
 * page, the selected item is carried in `?item=` so a decision can be pasted
 * into a ticket, and the two are one screen on a desktop and two screens on a
 * phone.
 *
 * Everything on this page is a figure the API returned. Nothing is stood in
 * for. That rule matters more here than anywhere else in the product: a metric
 * tile reading "7" that nobody can trace is an invitation to approve lending
 * that does not exist, or to conclude that nothing is pending when in fact
 * nobody was ever asked. So the tiles below print a number only in the one
 * state that earns it — the request succeeded — and say which of the other
 * states they are in otherwise.
 *
 * `?item=` is read with `useSearchParams`, which opts this subtree out of
 * static rendering unless it sits under a Suspense boundary; hence the split
 * below. The fallback is the same skeleton the first load uses, so a reader is
 * never shown two different kinds of "not ready yet".
 */

/**
 * An unread queue is empty, not quiet.
 *
 * There used to be a written-out queue behind this screen — named applicants,
 * graded deviations, running SLA clocks — rendered under an amber "example
 * data" banner whenever `/v1/tasks` could not be reached. On the one screen in
 * this console where a person acts, invented work is the worst possible
 * placeholder, and a banner does not undo it: people screenshot screens, quote
 * figures off them, and read a full queue as "the system is working". So there
 * is no stand-in at all, and the copy below is careful to say which of "we
 * never asked", "we asked and never found out" and "we asked and there is
 * nothing" it is looking at.
 */
const NO_TASKS: TaskOut[] = [];

/** Production's filter, in production's order and with production's labels. */
const FILTERS: { id: ItemKind | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "decision", label: "Decisions" },
  { id: "deviation", label: "Deviations" },
  { id: "call", label: "Call reviews" },
  { id: "pendency", label: "Pendencies" },
];

/**
 * Outcome colour, and only outcome colour: in SLA is a thing that proceeded,
 * due soon is a risk, breached is a thing that stopped being acceptable. Teal
 * and navy are not available to this map because on this page they mean "a
 * model reasoned" and "code produced a fixed answer", which an SLA clock is
 * neither of.
 *
 * The chip prints the state as a word as well, so the colour is the second
 * signal rather than the only one.
 */
const SLA_TONE: Record<SlaState, Tone> = {
  ok: "green",
  soon: "amber",
  breached: "red",
  none: "slate",
};

export default function ReviewQueuePage() {
  return (
    <Suspense fallback={<ReviewSkeleton />}>
      <ReviewQueue />
    </Suspense>
  );
}

/**
 * Block skeletons, deliberately not a sentence.
 *
 * "Loading the review queue…" is a sentence a person has to read, understand
 * and then discard, every time, for a wait that is usually shorter than the
 * reading. Blocks in the shape of the thing arriving are understood without
 * being read at all.
 */
function ReviewSkeleton() {
  return (
    <div className="gv-rise space-y-6" role="status" aria-label="Loading the review queue">
      <div className="grid gap-3">
        <Skeleton h={30} w="35%" />
        <Skeleton h={18} w="60%" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton h={96} />
        <Skeleton h={96} />
        <Skeleton h={96} />
        <Skeleton h={96} />
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div className="grid flex-1 basis-[300px] gap-3 min-[720px]:max-w-[380px]">
          <Skeleton h={26} />
          <Skeleton h={72} />
          <Skeleton h={72} />
          <Skeleton h={72} />
        </div>
        <div className="grid min-w-0 flex-[2_1_520px] gap-4">
          <Skeleton h={14} w="30%" />
          <Skeleton h={40} w="65%" />
          <Skeleton h={130} />
          <Skeleton h={160} />
        </div>
      </div>
    </div>
  );
}

/**
 * The em dash a tile prints where a number would be.
 *
 * A bare "—" is either skipped by a screen reader or announced as punctuation,
 * so the one state this page most needs a reader to notice is the one state it
 * would fail to announce. The visible glyph keeps the tiles aligned; the
 * hidden words say what it means.
 */
function NotCounted() {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not counted</span>
    </>
  );
}

function ReviewQueue() {
  const session = useSession();
  const token = session.token;
  const router = useRouter();
  const params = useSearchParams();

  const tasks = useResource(
    `tasks:${token ?? "none"}`,
    (signal) => api.listTasks(token, signal),
    NO_TASKS,
  );

  const items = useMemo<ReviewItem[]>(() => tasks.data.map(toReviewItem).sort(bySla), [tasks.data]);

  const [filter, setFilter] = useState<ItemKind | "all">("all");
  const [resolved, setResolved] = useState<Record<string, RecordedOutcome>>({});
  // On a phone the list and the workspace are two screens. Arriving with an
  // item in the URL — from a notification, or a link in a ticket — should land
  // on that item, not on a list the reader then has to search.
  const [onList, setOnList] = useState(() => params.get("item") === null);

  /**
   * The state the screen renders against is the last one that settled, not the
   * live value.
   *
   * `useResource` drops back to "loading" on every reload, and recording a
   * decision against the API triggers one. Reading the raw value would throw
   * the queue away and put skeletons back on screen each time somebody approves
   * something. Skeletons belong to the first load, when there is genuinely
   * nothing on screen to keep.
   */
  const [settled, setSettled] = useState<Exclude<DataMode, "loading"> | null>(null);
  useEffect(() => {
    if (tasks.mode !== "loading") setSettled(tasks.mode);
  }, [tasks.mode]);

  /**
   * The three states this page refuses to let blur into one another.
   *
   * `answered` is the only one that may be summarised as a number. `noToken`
   * means nobody asked, and the fix is a token rather than a retry. Anything
   * else settled is a request that failed, and the banner carries the API's own
   * status and correlation id so the failure can be found in its logs.
   *
   * `DataMode`'s failure value is still spelled "example" in `useResource`;
   * there is no example queue left for it to name, and this screen reads it
   * only as "the request did not succeed".
   */
  const answered = settled === "live";
  const noToken = tasks.failure?.kind === "no-token";

  // Every SLA on screen is read against the wall clock, because every item on
  // screen came from the API. Nothing here is dated against a fixed instant.
  const now = Date.now();

  const open = items.filter((item) => !resolved[item.id]);
  const shown = open.filter((item) => filter === "all" || item.kind === filter);

  /**
   * A named item is looked for in `items` rather than in `open`, so that an
   * item this session has just decided stays on screen with its confirmation
   * instead of vanishing the instant it is actioned.
   *
   * When `?item=` names something the queue does not contain, nothing is put in
   * its place. Substituting the next item would leave a person who followed a
   * link out of a ticket looking at a different application's workspace under a
   * URL that names the one they were sent to — with Approve and Reject live
   * beneath it. On this screen that is the one mistake that cannot be taken
   * back, so the page says it could not find the item and makes the reader
   * choose the next one themselves.
   */
  const requestedId = params.get("item");
  const requested = requestedId === null ? null : (items.find((item) => item.id === requestedId) ?? null);
  const requestMissed = requestedId !== null && requested === null;
  const selected = requested ?? (requestMissed ? null : (shown[0] ?? open[0] ?? null));

  const decisions = open.filter((item) => item.kind === "decision").length;
  const deviations = open.filter((item) => item.kind === "deviation").length;
  const breached = open.filter((item) => slaOf(item.dueAt, now).state === "breached").length;
  // `items` is sorted by SLA and filtering preserves order, so the first open
  // item is the one with the least time left on it.
  const mostUrgent = open[0] ?? null;

  const select = (id: string) => {
    setOnList(false);
    router.replace(`/console/review?item=${encodeURIComponent(id)}`, { scroll: false });
  };

  /** Drops a `?item=` that named nothing, so the queue can select normally again. */
  const clearSelection = () => {
    setOnList(true);
    router.replace("/console/review", { scroll: false });
  };

  /**
   * Records a decision.
   *
   * There is no branch here for "the API is unreachable, so pretend". An item
   * can only be on screen because the API returned it, so a decision on it
   * always goes back to the API; if that write fails the reader is told it
   * failed, and the item stays open.
   *
   * The note is checked here as well as in the workspace. The workspace owns
   * the textarea and the disabled buttons, but this function owns the request,
   * and "every action requires a note" is the promise the page makes at the top
   * of itself — it should not rest on a control in another file staying
   * disabled. A note that never reaches the chain is an event an auditor cannot
   * read, which is the one failure this queue exists to prevent.
   */
  const handleRecord = async (
    item: ReviewItem,
    action: ItemAction,
    note: string,
  ): Promise<boolean> => {
    if (!action.endpoint) return false;
    if (note.trim().length < MIN_NOTE) {
      toast(`A note of at least ${MIN_NOTE} characters is required. It is what the auditor reads.`, {
        tone: "error",
      });
      return false;
    }
    const at = formatDateTimeIst(new Date());
    const next = open.find((other) => other.id !== item.id);

    const outcome = await submitDecision(token, item, action.endpoint, note);
    if (!outcome.ok) {
      toast(`Could not record the decision: ${outcome.message}`, { tone: "error" });
      return false;
    }

    setResolved((current) => ({ ...current, [item.id]: { past: action.past, at } }));
    toast(
      `${action.past} · ${item.entityId ?? item.id}. ${next ? "Next item selected." : "Nothing else is waiting."}`,
    );
    if (next) select(next.id);
    // The item stays hidden locally either way, but the queue is re-read so the
    // tiles above match the server rather than this tab's memory of it.
    tasks.reload();
    return true;
  };

  if (settled === null) return <ReviewSkeleton />;

  /**
   * The sentence the attention screen led with, kept because it is the one
   * thing that page did better than production: it tells a reader how much is
   * waiting and what to open first, before they have read a single row.
   *
   * It is also the sentence most able to mislead, so each of the three states
   * gets its own wording. "Nothing is waiting on a person" is a claim about the
   * world, and this page may only make it when the API actually said so.
   */
  const briefing = !answered
    ? noToken
      ? "This console has no API token, so it has not asked what is waiting. Nothing below is a statement that the queue is empty."
      : "The review queue could not be read, so this console does not know what is waiting on a person."
    : open.length === 0
      ? "Nothing is waiting on a person."
      : `${open.length === 1 ? "One item needs" : `${open.length} items need`} a person. ${urgency(mostUrgent, now)}`;

  const stateNote = noToken ? "not counted · no token" : "not counted · request failed";

  return (
    <div className="gv-rise space-y-6">
      <header className="min-w-0">
        <h1 className="gv-page-title">Review queue</h1>
        <p className="mt-2 max-w-3xl text-[clamp(15px,1.6vw,17px)] leading-relaxed text-ink">
          {briefing}
        </p>
        <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-ink-2">
          Pending decisions, deviations and flagged calls, ordered by SLA. Every action requires a
          note, and every note enters the audit chain with your identity against it.
        </p>
      </header>

      {/* The honesty banner, minus its loading branch: skeletons cover the first
          load, and during a refresh the banner keeps saying what the data on
          screen actually is rather than flickering through "Loading…". */}
      <DataModeBanner
        mode={settled}
        failure={tasks.failure}
        onRetry={tasks.reload}
        what="the review queue"
      />

      <StatGrid columns={4}>
        <StatTile
          label="Open items"
          value={answered ? formatCount(open.length) : <NotCounted />}
          note="Waiting on a person, across every queue this token can see."
          source={answered ? undefined : stateNote}
        />
        <StatTile
          label="Credit decisions"
          value={answered ? formatCount(decisions) : <NotCounted />}
          note="Escalated by design, never by exception"
          source={answered ? undefined : stateNote}
        />
        <StatTile
          label="Deviations"
          value={answered ? formatCount(deviations) : <NotCounted />}
          note="Routed by the approval matrix"
          source={answered ? undefined : stateNote}
        />
        <StatTile
          label="SLA breached"
          // Red only once the figure is real and non-zero. A tile that is red
          // while it holds a dash would be signalling a breach nobody has
          // counted, which is the failure this page exists to avoid.
          accent={answered && breached > 0 ? "fail" : "ink"}
          value={answered ? formatCount(breached) : <NotCounted />}
          note="Past the time this tenant was promised."
          source={answered ? undefined : stateNote}
        />
      </StatGrid>

      <div className="flex flex-wrap items-start gap-6">
        <aside
          aria-label="Review queue"
          className={`gv-panel min-w-0 flex-1 basis-[300px] min-[720px]:sticky min-[720px]:top-20 min-[720px]:block min-[720px]:max-w-[380px] ${
            onList ? "" : "max-[719px]:hidden"
          }`}
        >
          <div className="border-b border-line-2 px-4 py-3.5">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="m-0 font-display text-2xl font-semibold">Open items</h2>
              <span className="font-mono text-xs text-ink-3">sorted by SLA</span>
            </div>
            {/* A group rather than a tablist: these are five toggles over one
                list, not five panels, and a reader tabbing through them should
                reach each one rather than arrow between them. */}
            <div role="group" aria-label="Filter the queue by type" className="mt-2.5 flex flex-wrap gap-1.5">
              {FILTERS.map((option) => {
                const on = filter === option.id;
                const count =
                  option.id === "all"
                    ? open.length
                    : open.filter((item) => item.kind === option.id).length;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setFilter(option.id)}
                    aria-pressed={on}
                    className={`gv-chip h-[26px] border ${
                      on
                        ? "border-navy bg-navy-tint text-navy-ink"
                        : "border-line bg-white text-ink-2 hover:border-ink-4"
                    }`}
                  >
                    {option.label}
                    {/* A count is a figure like any other on this page, so it
                        appears only when the API answered. A row of zeroes over
                        an unread queue reads as "nothing is pending". */}
                    {answered ? <span className="font-mono">{count}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>

          {shown.length === 0 ? (
            <UnknownRatherThanEmpty>
              {!answered
                ? noToken
                  ? "No token is set, so nothing was requested. This is an unknown queue rather than an empty one — set a token in Settings and it will say which it is."
                  : "The request above did not succeed, so no item is listed. This is an unknown queue rather than an empty one, and the note above carries the reason and a way to try again."
                : open.length === 0
                  ? items.length === 0
                    ? "The API returned no open items. Credit decisions, deviations and flagged calls arrive here because an agent escalated them on purpose, so an empty queue means nothing was escalated — not that nothing ran."
                    : "Everything the API returned has been actioned in this session. New escalations appear here as the agents raise them."
                  : `No open ${(FILTERS.find((option) => option.id === filter)?.label ?? "items").toLowerCase()} are in the queue. Clearing the filter shows the rest of it.`}
            </UnknownRatherThanEmpty>
          ) : (
            <ul>
              {shown.map((item) => {
                const sla = slaOf(item.dueAt, now);
                const on = selected?.id === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => select(item.id)}
                      aria-current={on ? "true" : undefined}
                      className={`block w-full border-0 border-t border-l-[3px] border-line-2 px-4 py-3 pl-[13px] text-left text-ink ${
                        on ? "border-l-navy bg-navy-tint" : "border-l-transparent bg-white hover:bg-surface-2"
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Chip tone={item.kind === "decision" ? "navy" : "slate"}>
                          {KIND_LABEL[item.kind]}
                        </Chip>
                        {/* The level chip belongs to deviations, which are the
                            items the approval matrix grades. It is rendered
                            from whatever the API graded rather than from the
                            kind, so a graded item of another type keeps its
                            level instead of having it silently dropped. */}
                        {item.severity ? <SevChip severity={item.severity} /> : null}
                        <Chip tone={SLA_TONE[sla.state]}>{sla.label}</Chip>
                      </div>
                      <div className="mt-1.5 text-sm font-semibold">{item.title}</div>
                      <div className="mt-0.5 text-xs text-ink-3">
                        <span className="font-mono">{item.queue ?? "unassigned"}</span>
                        {" · raised "}
                        {formatDateIst(item.raisedAt)}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {requestMissed ? (
          <div className={`min-w-0 flex-[2_1_520px] ${onList ? "max-[719px]:hidden" : ""}`}>
            {/* `role="status"` rather than `alert`: a reader arriving on this
                link should hear it when they reach it, not be interrupted. */}
            <div role="status" className="gv-panel px-6 py-8">
              {/* One heading for all three states. "Not in this queue" would be
                  a claim about the queue, and two of the three states are
                  exactly the ones in which this page knows nothing about it. */}
              <h2 className="m-0 font-display text-2xl font-semibold">
                That item could not be opened
              </h2>
              <p className="mt-2 mb-0 max-w-prose text-[13.5px] leading-relaxed text-ink-2">
                This link asks for{" "}
                <span className="font-mono break-all">{requestedId?.slice(0, 64)}</span>.{" "}
                {answered
                  ? "The API answered, and no open item with that id is in what it returned — it may already have been decided, or it may belong to a tenant this token cannot see. No other item has been opened in its place, because the next item in the queue is not the item you were sent to."
                  : noToken
                    ? "No token is set, so the queue was never requested and this id could not be looked up. It is unknown rather than absent."
                    : "The queue could not be read, so this id could not be looked up. It is unknown rather than absent, and the note above carries the reason and a way to try again."}
              </p>
              <Button className="mt-4" onClick={clearSelection}>
                Show the open items
              </Button>
            </div>
          </div>
        ) : selected ? (
          <div className={`min-w-0 flex-[2_1_520px] ${onList ? "max-[719px]:hidden" : ""}`}>
            <DecisionWorkspace
              key={selected.id}
              item={selected}
              related={relatedItems(open, selected)}
              session={session}
              now={now}
              recorded={resolved[selected.id]}
              onRecord={handleRecord}
              onSelect={select}
              onBack={() => setOnList(true)}
              openCount={open.length}
            />
          </div>
        ) : null}
      </div>

      {/* Clear of the phone bottom bar, which is 64px tall. */}
      <ToastHost bottom={80} />
    </div>
  );
}

/**
 * Which item to open first, in words.
 *
 * Each SLA state gets its own sentence rather than one template with the chip
 * label dropped into it: "sla breached · 5h" is a chip, and a chip pasted into
 * prose reads as a machine talking. The hours come from `slaOf`, so this
 * sentence and the chip on the row can never disagree.
 */
function urgency(item: ReviewItem | null, now: number): string {
  if (!item) return "";
  const sla = slaOf(item.dueAt, now);
  const title = `“${item.title}”`;
  if (sla.state === "breached" && sla.hours !== null) {
    return `Most urgent is ${title}, already ${-sla.hours}h past its service level.`;
  }
  if (sla.hours !== null) {
    return `Most urgent is ${title}, due ${sla.hours === 0 ? "within the hour" : `in ${sla.hours}h`}.`;
  }
  return `${title} is at the top of the queue, and carries no service level.`;
}
