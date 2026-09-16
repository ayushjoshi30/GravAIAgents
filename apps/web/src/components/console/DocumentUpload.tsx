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
}: {
  document: DocumentUploadOut;
  copied: "ok" | "failed" | null;
  onCopy: () => void;
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
      </div>

      {copied === "failed" ? (
        <p className="mt-1.5 text-[11.5px] text-ink-3">
          This browser would not give the page clipboard access. Select the id above and copy it.
        </p>
      ) : null}

      {/* WHY THERE IS NO "USE IN THIS RUN" BUTTON. `POST /v1/agents/{id}/run`
          accepts `inputs` and `source`, and no agent declares a field that
          takes a document id — the runner rejects an input key it does not
          know. A button that posted one anyway would fail on press, and one
          that silently did nothing would be worse. The id is the handle, so
          the console makes the id trivial to take rather than pretending to a
          wiring the API has not grown yet. */}
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-3">
        The id is what identifies this document to anything that reads it. Nothing attaches it
        to a run on its own: a run takes overrides and a data source, and no agent declares a
        document field yet.
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

export function DocumentUpload({
  token,
  stored,
  onStored,
  className,
}: {
  token: string | null;
  /** Everything stored this session, so a document survives switching agents. */
  stored: DocumentUploadOut[];
  onStored: (document: DocumentUploadOut) => void;
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

  const [state, setState] = useState<UploadState>({ status: "idle" });
  const [applicationId, setApplicationId] = useState("");
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState<{ id: string; result: "ok" | "failed" } | null>(null);
  const [reach, setReach] = useState<Reachability>({ status: "checking" });
  const [probe, setProbe] = useState(0);

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
  }, [applicationId, onStored, state, token]);

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

  return (
    <div className={`rounded-lg border border-line bg-sunken p-4 ${className ?? ""}`}>
      <h4 className="text-[12.5px] font-semibold text-ink">Upload a document</h4>
      <p className="mt-1 mb-3 text-[12.5px] leading-relaxed text-ink-2">
        Send one file straight to the platform. It is virus-scanned before anything is kept, and
        a file that cannot be scanned is refused rather than stored — so a deployment with no
        scanner configured accepts no uploads at all. What comes back is a document id and a
        blob reference the platform resolves itself.
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
          everything else below is there to be read at leisure. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement(state)}
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
                <button
                  type="button"
                  onClick={() => void copyId(document.document_id)}
                  className="text-[11.5px] font-medium text-brand hover:text-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  {copied !== null && copied.id === document.document_id && copied.result === "ok"
                    ? "Copied"
                    : "Copy id"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
