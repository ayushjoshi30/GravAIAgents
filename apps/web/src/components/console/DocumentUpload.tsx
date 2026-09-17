"use client";

/**
 * Hand a document to the platform.
 *
 * Until this existed the console could point a run at a GET endpoint of the
 * tenant's, and that was the only way to get a document in. A tenant that
 * already runs a document service should keep using it — that path needs no
 * key and no upload — so this sits beside the data source as the other way in,
 * not as its replacement or its fallback.
 *
 * WHAT THIS COMPONENT REFUSES TO SAY. Every state below is written so that the
 * word "stored" appears only after the API answered 201. A file that was sent
 * is not stored; a file that is being scanned is not stored; a file that got a
 * 503 is emphatically not stored, because a file that cannot be scanned is
 * never accepted. That rule is not this component's invention — the security
 * page already promises virus scanning on upload, so an upload path that let a
 * person believe an unscanned file was kept would make a published claim false.
 *
 * WHY THE SCAN IS NAMED WHILE IT RUNS. It is the slowest step and the one
 * nobody expects, so the gap between the last byte sent and the response is
 * exactly where a person starts wondering whether the console has hung. The
 * client call reports that transition for real (see `uploadDocument`), so this
 * can say "scanning" at the moment scanning actually begins rather than
 * guessing at it on a timer.
 *
 * WHAT BECOMES OF THE ID. It used to become nothing: the panel said so, because
 * a run took overrides and a data source and there was nowhere to put a
 * document id. `POST /v1/agents/{id}/run` now takes `document_ids`, so an
 * upload attaches itself to the next run and the attached list below says what
 * that run will carry. Two things are still true and are still said out loud.
 * The attachment lives in this page's memory rather than in a document library,
 * so a reload empties it while the document stays on the platform; and the
 * attaching is a claim about the request and nothing more — only the counts the
 * run reports back can say the document reached the run, and not even those say
 * what the agent made of it.
 */

import { useCallback, useEffect, useId, useRef, useState, type DragEvent } from "react";
import { Icon } from "@/components/icons/AgentIcon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import {
  UPLOAD_FAILURE_COPY,
  api,
  type DocumentUploadOut,
  type UploadFailureKind,
} from "@/lib/api";

type UploadState =
  | { status: "idle" }
  /** Picked, nothing sent. `ignored` counts files dropped beyond the first. */
  | { status: "selected"; file: File; ignored: number }
  /** Bytes going out. `sent` and `total` are real or they are null. */
  | { status: "uploading"; file: File; sent: number | null; total: number | null }
  /** Body fully sent; the server is reading, scanning and deciding. */
  | { status: "scanning"; file: File }
  | { status: "stored"; document: DocumentUploadOut }
  | {
      status: "failed";
      file: File;
      kind: UploadFailureKind;
      /** The sentence that says what became of the file. Always leads. */
      headline: string;
      /** The API's words, quoted, when it wrote any of its own. */
      detail: string | null;
      /**
       * What someone needs in hand to ask about this failure.
       *
       * A support conversation about an upload starts with the status and the
       * correlation id, and a console that showed neither would leave the
       * person describing the colour of the error box instead. Both are null
       * when the API never answered, which is itself the answer to "what did
       * it say".
       */
      httpStatus: number | null;
      correlationId: string | null;
    };

/**
 * Whether the API answered at all, checked before the control is offered.
 *
 * An upload control that looks ready and fails on use is worse than one that
 * says up front that the API is unreachable, because the person has by then
 * chosen a file and has no idea whether it went anywhere.
 */
type Reachability = { status: "checking" } | { status: "up" } | { status: "down" };

/**
 * How many documents the next run carries, said the way a person would.
 *
 * Module level so the attach and detach callbacks can use it without listing it
 * as a dependency they would then have to keep honest.
 */
function carrying(count: number): string {
  if (count === 0) return "Nothing is attached to the next run now.";
  return `${count} document${count === 1 ? "" : "s"} now attached to the next run.`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The panel's status line: one sentence for the step the upload is on.
 *
 * This deliberately carries no percentage. A live region that re-announces on
 * every progress event talks over itself and drowns the one thing worth
 * hearing, which is that the step changed — the number is rendered beside it,
 * hidden from the announcement.
 */
function phaseSentence(state: UploadState): string {
  switch (state.status) {
    case "idle":
      return "";
    case "selected":
      return `${state.file.name} selected, ${formatBytes(state.file.size)}. Nothing has been sent yet.`;
    case "uploading":
      return `Sending ${state.file.name}.`;
    case "scanning":
      return `Scanning ${state.file.name}. This is the slowest step, and nothing is stored until it finishes.`;
    case "stored":
      return `Stored. Document id ${state.document.document_id}, scanned by ${state.document.scanned_by}.`;
    case "failed":
      return state.headline;
  }
}

/**
 * What the live region carries.
 *
 * The phase sentence, then the API's quoted words when there are any, in the
 * order they appear on screen and once each. They used to be announced twice —
 * the phase sentence concatenated them, and the paragraph that quotes them sat
 * inside the live region as well — so a scan finding was read out, then read
 * out again.
 */
function announcement(state: UploadState): string {
  const sentence = phaseSentence(state);
  if (state.status === "failed" && state.detail) {
    return `${sentence} The API said: ${state.detail}`;
  }
  return sentence;
}

/** A bar whose width is a real fraction of a real total, or nothing at all. */
function SentBar({ sent, total }: { sent: number; total: number }) {
  const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;
  return (
    <div className="mt-2 flex items-center gap-2">
      <div
        role="progressbar"
        aria-label="Bytes sent"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={sent}
        aria-valuetext={`${percent}% sent`}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-150"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="font-mono text-[11px] text-ink-3" data-numeric="" aria-hidden="true">
        {percent}%
      </span>
    </div>
  );
}

/**
 * The honest indicator for a step with no measurable progress.
 *
 * Omitting `aria-valuenow` is how ARIA spells indeterminate, which is the true
 * statement here: the scanner reports nothing until it is done, so any number
 * on screen would be invented. `motion-safe:` keeps the pulse away from anyone
 * who asked for less motion, leaving a static bar that still marks the step.
 */
function WorkingBar({ label }: { label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuetext={label}
      className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3"
    >
      <div className="h-full rounded-full bg-brand opacity-70 motion-safe:animate-pulse" />
    </div>
  );
}

function StoredDocument({
  document,
  copied,
  onCopy,
  attached,
  onAttach,
}: {
  document: DocumentUploadOut;
  copied: "ok" | "failed" | null;
  onCopy: () => void;
  /** Whether this id is in the set the next run will carry. */
  attached: boolean;
  onAttach: () => void;
}) {
  const facts = [
    document.mime_type,
    formatBytes(document.bytes),
    // Only a real page count is printed. `null` means the platform did not
    // count pages for this type, which is not the same as zero pages.
    document.pages === null ? null : `${document.pages} page${document.pages === 1 ? "" : "s"}`,
  ].filter(Boolean);

  return (
    <div className="mt-3 rounded-lg border border-pass-border bg-pass-soft p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="pass" dot>
          stored
        </Badge>
        <Badge tone="neutral" icon={<Icon name="shield" size={12} />}>
          scanned by {document.scanned_by}
        </Badge>
        {/* The badge states where the id is, not what any run has done with
            it. "Attached" is a fact about the next request this page will
            send; whether the document was read is a question only the run's
            own report answers, and it is answered beside the result. */}
        {attached ? <Badge tone="brand">attached to the next run</Badge> : null}
      </div>

      <p className="mt-2 text-[12.5px] leading-relaxed break-all text-ink-2">
        <strong className="font-medium text-ink">{document.filename}</strong> · {facts.join(" · ")}
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <code className="gv-scroll-x max-w-full overflow-x-auto rounded border border-line bg-surface px-1.5 py-1 font-mono text-[11.5px] break-all text-ink">
          {document.document_id}
        </code>
        <Button size="sm" variant="secondary" onClick={onCopy}>
          {copied === "ok" ? "Copied" : "Copy id"}
        </Button>
        {/* Offered only when the id is not already attached, which happens
            after someone removes it from the list below. A second "attach"
            beside a document that is already attached would invite a press
            that does nothing and reads as a failure. */}
        {attached ? null : (
          <Button size="sm" variant="secondary" onClick={onAttach}>
            Attach to the next run
          </Button>
        )}
      </div>

      {copied === "failed" ? (
        <p className="mt-1.5 text-[11.5px] text-ink-3">
          This browser would not give the page clipboard access. Select the id above and copy it.
        </p>
      ) : null}

      {/* WHY THERE IS A BUTTON NOW, WHERE THERE USED NOT TO BE. This paragraph
          used to end by saying that nothing attached the id to a run, which was
          true: a run took `inputs` and `source` and the runner rejected any
          input key it did not know, so a button here could only have failed on
          press. `POST /v1/agents/{id}/run` has since grown `document_ids`, the
          platform resolves each id against the caller's own tenant, and what it
          finds reaches the runner as part of the same `source` the data-source
          connector builds. The copy button stays regardless, because the id is
          still the handle for anything this console cannot reach. */}
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-3">
        The id is what identifies this document to anything that reads it, and the run call now
        carries it: the platform resolves the id against your own tenant and gives the run the
        document, so nothing here has to be copied out by hand. Two limits are worth knowing.
        The attachment is held by this page and not by the platform, so leaving or reloading
        loses it while the document itself stays stored; and attaching is a fact about the
        request only — the count the run reports back is what says the document reached the
        run, and even that stops short of saying what the agent made of it.
      </p>

      <p className="mt-2 font-mono text-[11px] break-all text-ink-3">
        {document.uri}
        <span className="ml-1.5 font-sans text-ink-3">
          — a blob reference the platform resolves itself. It is never handed to a provider, and
          it is not a URL this browser can open.
        </span>
      </p>
    </div>
  );
}

/**
 * What the next run will actually carry, before anyone starts one.
 *
 * This is a real list rather than a count, because a count cannot be argued
 * with: someone who uploaded three files and sees "2 attached" has no way to
 * find out which two. Each entry names its document and carries its own remove
 * control, and the empty case is written out in full — leaving the section off
 * when nothing is attached would make "did my last upload survive switching
 * agents" a question this panel refuses to answer.
 *
 * Nothing here claims a document has been read. Everything on this list is a
 * statement about the request the Run button is going to send.
 */
function AttachedDocuments({
  attached,
  reattachable,
  onDetach,
}: {
  attached: DocumentUploadOut[];
  /**
   * How many documents are listed below and could be put back on.
   *
   * The empty state points at that list, and only when there is one. On a first
   * visit there is nothing stored at all, and sending someone to look for a
   * list that is not on the page is how a panel loses their trust over
   * something small.
   */
  reattachable: number;
  onDetach: (document: DocumentUploadOut) => void;
}) {
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="gv-eyebrow">Attached to the next run</p>
        <span className="font-mono text-[11px] text-ink-3" data-numeric="">
          {attached.length}
        </span>
      </div>

      {attached.length === 0 ? (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
          Nothing is attached, so a run started now carries no uploaded file at all. An upload
          attaches itself here
          {reattachable > 0
            ? ", and anything stored earlier this session can be put back on from the list below"
            : ""}
          .
        </p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {attached.map((document) => (
            <li key={document.document_id} className="flex flex-wrap items-center gap-2">
              <span className="text-[11.5px] text-ink-2">{document.filename}</span>
              <code className="font-mono text-[11px] break-all text-ink-3">
                {document.document_id}
              </code>
              {/* The visible word is "Remove", which is all the column has room
                  for and all a sighted reader needs beside the filename it sits
                  next to. The accessible name names the document, because a
                  list of buttons all called "Remove" is unusable to anyone
                  tabbing through it out of context. */}
              <button
                type="button"
                onClick={() => onDetach(document)}
                aria-label={`Remove ${document.filename} from the next run`}
                className="text-[11.5px] font-medium text-brand hover:text-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
        This list is held in the page, not by the platform. A reload empties it, and this console
        cannot ask for documents stored on an earlier visit — they still exist, but nothing here
        can name them again unless their ids were written down.
      </p>
    </div>
  );
}

export function DocumentUpload({
  token,
  stored,
  onStored,
  attached,
  onAttach,
  onDetach,
  className,
}: {
  token: string | null;
  /** Everything stored this session, so a document survives switching agents. */
  stored: DocumentUploadOut[];
  onStored: (document: DocumentUploadOut) => void;
  /**
   * The ids the next run will carry, in the order they were attached.
   *
   * Owned by the page rather than by this panel for the same reason `stored`
   * is: the panel is mounted inside whichever agent card happens to be open,
   * and closing that card must not silently empty a run's document set.
   */
  attached: DocumentUploadOut[];
  onAttach: (document: DocumentUploadOut) => void;
  onDetach: (documentId: string) => void;
  className?: string;
}) {
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Nested elements fire dragleave on every crossing; counting survives that. */
  const dragDepth = useRef(0);
  /**
   * Which upload the panel is currently showing.
   *
   * Cancelling, clearing or picking a second file while a request is still in
   * flight moves this on, and the in-flight request checks it before touching
   * the panel — otherwise a cancelled upload's reply lands on top of the file
   * someone has just chosen, and tells them their new file was cancelled.
   */
  const attemptRef = useRef(0);

  /**
   * The attached set as it is right now, for callbacks that outlive a render.
   *
   * `send` is awaited across a whole upload, so the `attached` it closed over
   * can be several removals out of date by the time the 201 lands. The list on
   * screen re-renders from the prop and is never wrong; this exists so that the
   * sentence the live region speaks — which is the only version of the list a
   * screen-reader user is given at that moment — counts what is actually
   * attached rather than what was attached a minute ago.
   */
  const attachedRef = useRef(attached);
  useEffect(() => {
    attachedRef.current = attached;
  }, [attached]);

  const [state, setState] = useState<UploadState>({ status: "idle" });
  const [applicationId, setApplicationId] = useState("");
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState<{ id: string; result: "ok" | "failed" } | null>(null);
  const [reach, setReach] = useState<Reachability>({ status: "checking" });
  const [probe, setProbe] = useState(0);
  /**
   * The last change to the attached set, in words, for the live region.
   *
   * The `seq` is not decoration. A live region announces nodes as they are
   * inserted, so attaching a document, removing it and attaching it again
   * would produce the same sentence in the same node and be announced once —
   * the second attach passing in silence. Keying the node on `seq` replaces it
   * each time, which is an insertion whatever the words say.
   */
  const [notice, setNotice] = useState<{ text: string; seq: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setReach({ status: "checking" });
    void api.health(controller.signal).then((outcome) => {
      if (!live) return;
      // Only a refused connection means "cannot reach the API". A 500 is the
      // API answering badly, which is a different problem and not one that
      // should hide the control.
      setReach(!outcome.ok && outcome.kind === "unreachable" ? { status: "down" } : { status: "up" });
    });
    return () => {
      live = false;
      controller.abort();
    };
  }, [probe]);

  const blockedReason =
    reach.status === "down"
      ? "The GravAI API is not reachable from this browser, so a file picked here could not be sent anywhere."
      : !token
        ? "Uploading needs an API token carrying the documents:write scope. Add one in Settings."
        : null;
  const blocked = blockedReason !== null || reach.status === "checking";

  /**
   * A request is in flight.
   *
   * Picking a second file while the first is still going would leave two
   * uploads racing for one panel, so the control closes for the duration
   * rather than trying to referee them afterwards.
   */
  const busy = state.status === "uploading" || state.status === "scanning";
  const accepting = !blocked && !busy;

  const attach = useCallback(
    (document: DocumentUploadOut) => {
      const already = attachedRef.current.some(
        (existing) => existing.document_id === document.document_id,
      );
      if (already) return;
      onAttach(document);
      const text = `${document.filename} attached. ${carrying(attachedRef.current.length + 1)}`;
      setNotice((previous) => ({ text, seq: (previous?.seq ?? 0) + 1 }));
    },
    [onAttach],
  );

  const detach = useCallback(
    (document: DocumentUploadOut) => {
      onDetach(document.document_id);
      const text = `${document.filename} removed. ${carrying(
        Math.max(0, attachedRef.current.length - 1),
      )}`;
      setNotice((previous) => ({ text, seq: (previous?.seq ?? 0) + 1 }));
    },
    [onDetach],
  );

  const choose = useCallback((files: FileList | null, ignoredExtra = 0) => {
    const file = files?.[0];
    if (!file) return;
    setState({ status: "selected", file, ignored: ignoredExtra });
  }, []);

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    // Without this the browser takes over and navigates away to the file.
    event.preventDefault();
  }, []);

  const onDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (!accepting) return;
      dragDepth.current += 1;
      setDragging(true);
    },
    // `accepting`, not `blocked`: it also falls to false while a request is in
    // flight. Listing only `blocked` froze this callback on the value
    // `accepting` happened to have when `blocked` last changed, so a panel that
    // was going to refuse the drop still lit up to invite it.
    [accepting],
  );

  const onDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (!accepting) return;
      const files = event.dataTransfer?.files ?? null;
      // The endpoint takes one part named "file". Taking the first and saying
      // so is honest; silently dropping the rest is not.
      choose(files, files ? Math.max(0, files.length - 1) : 0);
    },
    [accepting, choose],
  );

  const send = useCallback(async () => {
    if (state.status !== "selected") return;
    const file = state.file;

    // Checked here only to save a round trip on a fact the browser already
    // knows. The server is still the authority and answers 400 for an empty
    // part; this says plainly that it was the console that stopped it.
    if (file.size === 0) {
      setState({
        status: "failed",
        file,
        kind: "empty-part",
        headline: "That file is empty, so this console did not send it. Nothing was stored.",
        detail: null,
        // No request was made, so there is no status and no correlation id to
        // quote. Printing an empty pair would suggest the API was involved.
        httpStatus: null,
        correlationId: null,
      });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    setState({ status: "uploading", file, sent: null, total: null });

    const outcome = await api.uploadDocument(token, file, {
      applicationId,
      signal: controller.signal,
      onProgress: (progress) => {
        if (attemptRef.current !== attempt) return;
        setState((previous) => {
          // A settled state must never be reopened by a late event.
          if (previous.status !== "uploading" && previous.status !== "scanning") return previous;
          if (progress.phase === "scanning") return { status: "scanning", file };
          return { status: "uploading", file, sent: progress.sent, total: progress.total };
        });
      },
    });

    abortRef.current = null;

    if (outcome.ok) {
      // Recorded even when the panel has moved on. Cancelling races the server:
      // if the 201 had already been decided, the document exists, and throwing
      // its id away here would strand a stored file that nothing can name again
      // — this console cannot list documents back.
      onStored(outcome.data);
      // Attached for the same reason, and announced whether or not this panel
      // is still showing the upload that produced it. A document that quietly
      // joined the next run without saying so would be the one thing this panel
      // must never do; the attached list and the announcement both name it, so
      // a person who has moved on can see it and take it back off.
      attach(outcome.data);
      if (attemptRef.current === attempt) setState({ status: "stored", document: outcome.data });
      return;
    }

    // A failure nobody is waiting for any more is not worth showing over
    // whatever the person has done since.
    if (attemptRef.current !== attempt) return;

    const canned = UPLOAD_FAILURE_COPY[outcome.kind];
    const fromApi = outcome.messageSource === "api";

    setState({
      status: "failed",
      file,
      kind: outcome.kind,
      // A sentence the client wrote is always the more specific one for its
      // kind — it knows things the canned line cannot, such as whether the
      // body had finished going out before the connection died — so it leads.
      // The API's words never lead, because they answer a different question
      // than the one being asked here.
      headline: fromApi ? canned : outcome.message,
      // Quoted only when the API actually wrote a sentence, and only when it
      // adds something: a 413 that names the limit, a 422 that names the
      // finding. Attributing this console's own words to the API under "The
      // API said:" would be inventing a statement by the server.
      detail: fromApi && outcome.message && outcome.message !== canned ? outcome.message : null,
      httpStatus: outcome.status ?? null,
      correlationId: outcome.correlationId ?? null,
    });
  }, [applicationId, attach, onStored, state, token]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    attemptRef.current += 1;
    setState({ status: "idle" });
    // Without this, picking the same file twice in a row fires no change event.
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const copyId = useCallback(async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied({ id, result: "ok" });
    } catch {
      setCopied({ id, result: "failed" });
    }
  }, []);

  const earlier = stored.filter(
    (document) =>
      state.status !== "stored" || document.document_id !== state.document.document_id,
  );

  const attachedIds = new Set(attached.map((document) => document.document_id));

  return (
    <div className={`rounded-lg border border-line bg-sunken p-4 ${className ?? ""}`}>
      <h4 className="text-[12.5px] font-semibold text-ink">Upload a document</h4>
      <p className="mt-1 mb-3 text-[12.5px] leading-relaxed text-ink-2">
        Send one file straight to the platform. It is virus-scanned before anything is kept, and
        a file that cannot be scanned is refused rather than stored — so a deployment with no
        scanner configured accepts no uploads at all. What comes back is a document id and a
        blob reference the platform resolves itself, and the id is attached to the next run
        started from this page.
      </p>

      {/* One region that is mounted from the first render and stays mounted,
          rather than a `role="status"` on the paragraph that happens to be
          showing. The probe resolves after mount: a live region created in the
          same breath as its own text announces nothing, so the old arrangement
          announced the "checking…" line never and its answer never either —
          the one state worth hearing, that the API cannot be reached at all,
          was silent. */}
      <div role="status" aria-live="polite">
        {reach.status === "checking" ? (
          <p className="mb-3 text-[12px] text-ink-3">Checking that the API is reachable…</p>
        ) : null}

        {blockedReason ? (
          <p className="mb-3 flex items-start gap-2.5 rounded-lg border border-amber-border bg-amber-soft p-3 text-[12.5px] leading-relaxed text-amber-strong">
            <span className="mt-px shrink-0" aria-hidden="true">
              <Icon name="warning" size={14} />
            </span>
            <span>
              {blockedReason}
              {reach.status === "down" ? (
                <button
                  type="button"
                  onClick={() => setProbe((value) => value + 1)}
                  className="ml-1.5 font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  Check again
                </button>
              ) : null}
            </span>
          </p>
        ) : null}
      </div>

      {/* `relative` anchors the visually-hidden input, which `sr-only`
          positions absolutely. With no positioned ancestor it resolves against
          whatever is positioned further up the page, and tabbing to it can
          scroll the window somewhere else entirely — a keyboard user losing
          their place on the way to the control they were reaching for. */}
      <div
        onDragOver={onDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`relative rounded-lg border border-dashed p-4 transition-colors ${
          dragging ? "border-brand bg-brand-50" : "border-line-strong bg-surface"
        } ${accepting ? "" : "opacity-60"}`}
      >
        {/* A real input with a real label, so the control is reachable by tab,
            opens on Enter or Space, and is announced as a file input. A div
            with a click handler would leave drag-and-drop as the only way in,
            which is no way in at all for anyone not using a mouse. */}
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          className="peer sr-only"
          disabled={!accepting}
          aria-describedby={hintId}
          onChange={(event) => choose(event.target.files)}
        />
        {/* No `accept` filter: the deployment decides which media types it
            takes, and a guess here would silently hide files the API would
            have accepted. An unsupported type comes back as a 415 that says
            so, before anything is stored. */}
        <label
          htmlFor={inputId}
          className="gv-btn gv-btn-secondary inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 border px-3 text-[12.5px] font-medium peer-disabled:cursor-not-allowed peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand"
        >
          <Icon name="file" size={14} />
          Choose a file
        </label>

        <p id={hintId} className="gv-help mt-2">
          Or drag one file onto this panel. One file per upload; the deployment decides which
          types and what size it accepts, and says so before anything is stored.
        </p>
      </div>

      <TextField
        label="Application id"
        value={applicationId}
        onChange={setApplicationId}
        placeholder="optional"
        mono
        className="mt-3"
        hint="Optional. Links the stored document to an application."
      />

      {/* THE LIVE REGION IS A TEXT NODE, NOT THE PANEL. It is mounted from the
          first render so that the first change of phase is announced rather
          than swallowed by a region that appeared at the same moment as its
          own content.

          It is kept separate from the visible panel because a live region
          announces every node inserted into it, not the sentence you meant.
          Wrapping the panel meant that reaching "stored" read out the whole
          stored-document block — filename, id, blob uri, the copy button, the
          paragraph explaining what a blob uri is — over the top of the one
          fact worth hearing. One sentence per phase is what is announced;
          everything else below is there to be read at leisure.

          The attachment sentence is a SIBLING NODE rather than part of the
          phase sentence. Only nodes that actually change are announced from a
          region that is not atomic, so keeping them apart means removing a
          document from the run does not re-read the upload's outcome, and an
          upload's outcome does not re-read an attachment made five minutes
          ago. */}
      <div role="status" aria-live="polite" className="sr-only">
        <p>{announcement(state)}</p>
        {notice ? <p key={notice.seq}>{notice.text}</p> : null}
      </div>

      {state.status !== "idle" ? (
        <div className="mt-3 rounded-lg border border-line bg-surface p-3">
          <p
            className={`text-[12.5px] leading-relaxed ${
              // Cancelling is something the person did on purpose, so it
              // reads as a plain statement rather than in the failure red.
              state.status === "failed" && state.kind !== "cancelled"
                ? "text-fail"
                : "text-ink-2"
            }`}
          >
            {phaseSentence(state)}
          </p>

          {/* The bars are no longer hidden from assistive technology now that
              they are outside the live region: a progressbar that is not
              announced at every event is a thing someone can go and read when
              they want to know how far along it is. The percentage beside it
              stays hidden, because `aria-valuetext` already says it. */}
          {state.status === "uploading" ? (
            state.sent !== null && state.total !== null ? (
              <SentBar sent={state.sent} total={state.total} />
            ) : (
              <WorkingBar label="Sending" />
            )
          ) : null}

          {state.status === "scanning" ? <WorkingBar label="Scanning" /> : null}

          {state.status === "selected" && state.ignored > 0 ? (
            <p className="mt-1.5 text-[11.5px] text-ink-3">
              {state.ignored} other file{state.ignored === 1 ? "" : "s"} in that drop {
                state.ignored === 1 ? "was" : "were"
              } ignored — this endpoint takes one at a time.
            </p>
          ) : null}

          {state.status === "failed" && state.detail ? (
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
              The API said: {state.detail}
            </p>
          ) : null}

          {/* The two things a person is asked for when they report a failed
              upload. Without them the conversation starts with "it said
              something went wrong", and the request cannot be found in the
              logs at all. */}
          {state.status === "failed" &&
          (state.httpStatus !== null || state.correlationId !== null) ? (
            <p className="mt-2 font-mono text-[11px] break-all text-ink-3">
              {state.httpStatus !== null ? `HTTP ${state.httpStatus}` : null}
              {state.httpStatus !== null && state.correlationId !== null ? " · " : null}
              {state.correlationId !== null ? `correlation ${state.correlationId}` : null}
            </p>
          ) : null}

          {state.status === "stored" ? (
            <StoredDocument
              document={state.document}
              copied={copied !== null && copied.id === state.document.document_id ? copied.result : null}
              onCopy={() => void copyId(state.document.document_id)}
              attached={attachedIds.has(state.document.document_id)}
              onAttach={() => attach(state.document)}
            />
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() => void send()}
          disabled={blocked || state.status !== "selected"}
        >
          Upload and scan
        </Button>

        {state.status === "uploading" ? (
          // Cancelling is only offered while bytes are still going out, where
          // an incomplete body cannot have produced a 201. Once the scan has
          // started the server owns the outcome, and a cancel button there
          // would leave someone unsure whether the file was kept.
          <Button size="sm" variant="ghost" onClick={reset}>
            Cancel
          </Button>
        ) : null}

        {!busy && state.status !== "idle" ? (
          <Button size="sm" variant="ghost" onClick={reset}>
            {state.status === "stored" ? "Upload another" : "Clear"}
          </Button>
        ) : null}
      </div>

      {/* Rendered whether or not anything is attached. The empty case is the
          one that has to be stated: someone who uploaded a file, opened a
          second agent and came back needs to be told plainly that the run
          carries nothing, rather than left to read an absent section either
          way. */}
      <AttachedDocuments attached={attached} reattachable={earlier.length} onDetach={detach} />

      {earlier.length > 0 ? (
        <div className="mt-4 border-t border-line pt-3">
          <p className="gv-eyebrow">Stored earlier this session</p>
          <ul className="mt-1.5 space-y-1.5">
            {earlier.map((document) => (
              <li key={document.document_id} className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-[11.5px] break-all text-ink-2">
                  {document.document_id}
                </code>
                <span className="text-[11.5px] text-ink-3">{document.filename}</span>
                {/* Named after its document for the same reason the attach and
                    remove controls are. A column of buttons that all announce
                    themselves as "Copy id" tells someone tabbing through this
                    list nothing about which id they are about to take, and this
                    list is exactly where that matters — the ids are the only
                    thing distinguishing the rows. */}
                <button
                  type="button"
                  onClick={() => void copyId(document.document_id)}
                  aria-label={`Copy the id of ${document.filename}`}
                  className="text-[11.5px] font-medium text-brand hover:text-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  {copied !== null && copied.id === document.document_id && copied.result === "ok"
                    ? "Copied"
                    : "Copy id"}
                </button>
                {/* Attaching is offered here so that a document from earlier in
                    the session can go into a run without being re-uploaded.
                    When it is already attached this says so in words rather
                    than hiding the row: the attached list above is the place
                    to take it back off, and two remove controls for one
                    document would be two chances to press the wrong one. */}
                {attachedIds.has(document.document_id) ? (
                  <span className="text-[11.5px] text-ink-3">attached</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => attach(document)}
                    aria-label={`Attach ${document.filename} to the next run`}
                    className="text-[11.5px] font-medium text-brand hover:text-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                  >
                    Attach
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
