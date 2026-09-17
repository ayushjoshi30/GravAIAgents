"use client";

import { useEffect, useId, useRef, useState } from "react";

import { useDialogBehaviour } from "@/components/console/primitives";
import { Button } from "@/components/ui/Button";
import { api, FAILURE_COPY, type ApiFailure, type WorkflowCreated } from "@/lib/api";
import { useToken } from "@/lib/session";
import { STUDIO_TEMPLATES } from "@/lib/studioTemplates";

/**
 * "New agent": pick a shape to start from, name it, and create it server-side.
 *
 * WHY A STARTER AT ALL. The argument is made at length at the top of
 * `lib/studioTemplates.ts` and is worth repeating in one line here: an empty
 * canvas asks someone who has just arrived to know both what the platform can
 * do and how they want to arrange it, and most people know neither on their
 * first visit. Deleting what you do not want is a much easier judgement than
 * inventing what you do.
 *
 * WHY THE TEMPLATE IS SENT AS A NAME, NOT AS A GRAPH. The starters exist twice:
 * here, for the picker, and in the API, which builds the definition and checks
 * every node type in it against the engine's own registry before the workflow
 * is saved. Posting the graph from the browser would skip that check and let a
 * starter naming a node type this build does not have become a workflow that
 * looks fine on the canvas and cannot be validated, run or compiled. So the
 * browser sends the id and the server decides what it means — and if the server
 * does not know that id, it says so with the list of the ones it does know,
 * which is printed here verbatim rather than softened into "something went
 * wrong".
 */

/**
 * What creating answers is `WorkflowCreated` from `lib/api.ts`, not a shape
 * declared here.
 *
 * Note that it is NOT `WorkflowDetail` from `lib/studio.ts`: that interface
 * describes the studio's older response, with `versions` and no `node_count`.
 * The create endpoint answers with the new workflow and its graph, and the page
 * reads an id and a name out of it in order to route to the builder.
 */

const BLANK = "__blank__";
const DEFAULT_NAME = "Untitled agent";

/**
 * The starter the picker opens on.
 *
 * Retail lending end to end is the shape most people who reach this dialog are
 * about to build, and it is the one starter that exercises the whole platform
 * in one graph: documents and statements read in parallel, a scored risk with
 * its explanation attached to the scoring step itself, and a branch that sends
 * everything outside the green band to a person. Defaulting to it rather than
 * to the blank canvas is the whole of the argument above, applied.
 */
const RECOMMENDED = "credit";

interface Starter {
  id: string;
  label: string;
  blurb: string;
}

/**
 * Blank canvas first, then the four real starters in the order the library
 * declares them. `STUDIO_TEMPLATES` is the single source: these are built from
 * registry node types and held by `tests/test_studio_templates.py`, so a
 * starter written here instead would be one nothing checks.
 */
const STARTERS: Starter[] = [
  {
    id: BLANK,
    label: "Blank canvas",
    blurb: "An input and an output, and nothing between them yet.",
  },
  ...STUDIO_TEMPLATES.map((template) => ({
    id: template.id,
    label: template.label,
    blurb: template.blurb,
  })),
];

function failureLine(failure: ApiFailure): string {
  const said = failure.message?.trim() || FAILURE_COPY[failure.kind];
  const status = failure.status ? ` (HTTP ${failure.status})` : "";
  const correlation = failure.correlationId ? ` · correlation ${failure.correlationId}` : "";
  return `${said}${status}${correlation}`;
}

export interface NewAgentDialogProps {
  open: boolean;
  onClose: () => void;
  /** The workflow the server created. The page decides where to go next. */
  onCreated: (workflow: WorkflowCreated) => void;
}

export function NewAgentDialog({ open, onClose, onCreated }: NewAgentDialogProps) {
  const [token] = useToken();
  const dialog = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const nameId = useId();
  const descriptionId = useId();
  const errorId = useId();

  const [starter, setStarter] = useState(RECOMMENDED);
  const [name, setName] = useState(labelFor(RECOMMENDED));
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  /* True once the name is something the person chose. After that, changing the
     starter leaves it alone: silently overwriting a name someone typed is the
     kind of small betrayal that makes people stop trusting a form. */
  const [nameIsMine, setNameIsMine] = useState(false);

  // Esc, the tab ring and handing focus back to whatever opened this. Shared
  // with every other overlay in the console rather than re-implemented, because
  // a half-trapped dialog drops a keyboard user behind an opaque scrim.
  useDialogBehaviour(dialog, { open, onClose });

  /* Every opening starts clean. A dialog that reopened holding the name and the
     error from the attempt before would be showing state from a decision the
     person already walked away from. */
  useEffect(() => {
    if (!open) return;
    setStarter(RECOMMENDED);
    setName(labelFor(RECOMMENDED));
    setDescription("");
    setNameIsMine(false);
    setNameError(null);
    setFailure(null);
    setBusy(false);
  }, [open]);

  if (!open) return null;

  const chooseStarter = (id: string) => {
    setStarter(id);
    setFailure(null);
    if (!nameIsMine) setName(labelFor(id));
  };

  const create = async () => {
    const trimmed = name.trim();
    // Said out loud, next to the field, rather than a Create button that does
    // nothing when pressed.
    if (!trimmed) {
      setNameError("Give the agent a name. It is how a deployed agent is addressed.");
      nameInput.current?.focus();
      return;
    }

    setNameError(null);
    setFailure(null);
    setBusy(true);

    const result = await api.createWorkflow(token, {
      name: trimmed,
      description: description.trim(),
      // Omitted entirely for the blank canvas: `null` and "no starter" mean the
      // same thing to the endpoint, but a body that carries the field reads as
      // a choice and this is the absence of one.
      ...(starter === BLANK ? {} : { template: starter }),
    });
    setBusy(false);

    if (!result.ok) {
      setFailure(failureLine(result));
      return;
    }
    onCreated(result.data);
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/35" onClick={onClose} />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="gv-overlay gv-rise fixed left-1/2 top-1/2 z-40 max-h-[calc(100vh-32px)] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-6"
      >
        <h2 id={headingId} className="font-display text-2xl leading-tight font-semibold">
          New agent
        </h2>
        <p className="mt-1 text-[13px] text-ink-3">
          Start from a shape that already works, or from nothing. Either way you can change
          every step of it afterwards.
        </p>

        <fieldset className="mt-4 border-0 p-0">
          <legend className="gv-eyebrow mb-2">Start from</legend>
          <div className="grid gap-2">
            {STARTERS.map((option) => {
              const selected = option.id === starter;
              return (
                <label
                  key={option.id}
                  className={`flex cursor-pointer gap-3 rounded-md border p-3 transition-colors ${
                    selected
                      ? "border-navy bg-navy-tint"
                      : "border-line-2 bg-surface hover:border-line-strong"
                  }`}
                >
                  <input
                    type="radio"
                    name="agent-starter"
                    value={option.id}
                    checked={selected}
                    onChange={() => chooseStarter(option.id)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-navy"
                  />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium text-ink">
                      {option.label}
                      {option.id === RECOMMENDED ? (
                        <span className="gv-chip gv-chip-navy text-[11px]">Most complete</span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-2">
                      {option.blurb}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-4 grid gap-3">
          <div>
            <label htmlFor={nameId} className="gv-label mb-1.5 block text-ink">
              Name
            </label>
            <input
              id={nameId}
              ref={nameInput}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNameIsMine(true);
                if (nameError) setNameError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void create();
                }
              }}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? `${nameId}-error` : `${nameId}-help`}
              className="gv-input"
            />
            {nameError ? (
              <p id={`${nameId}-error`} role="alert" className="mt-1.5 text-[12px] text-red-ink">
                {nameError}
              </p>
            ) : (
              <p id={`${nameId}-help`} className="gv-help mt-1.5">
                Names are unique within your tenant — a deployed agent is called by this name.
              </p>
            )}
          </div>

          <div>
            <label htmlFor={descriptionId} className="gv-label mb-1.5 block text-ink">
              Description{" "}
              <span className="text-[11.5px] font-normal text-ink-3">optional</span>
            </label>
            <textarea
              id={descriptionId}
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What this agent decides, and who it hands the decision to."
              className="gv-textarea"
            />
          </div>
        </div>

        {/* The API's own sentence, with the status and the correlation id beside
            it. "A workflow with this name already exists" tells someone what to
            do next; "Could not create agent" tells them only to try again. */}
        {failure ? (
          <p
            id={errorId}
            role="alert"
            className="mt-3 rounded-md border border-red bg-red-tint px-3 py-2 text-[12.5px] leading-snug text-red-ink"
          >
            Could not create this agent — {failure}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void create()}
            disabled={busy}
            /* Tied to the failure above so that someone who presses Create,
               hears nothing happen and tabs back to the button is told why,
               rather than having to go hunting up the dialog for it. */
            aria-describedby={failure ? errorId : undefined}
          >
            {busy ? "Creating…" : "Create agent"}
          </Button>
        </div>
      </div>
    </>
  );
}

/** The name a starter prefills. The blank canvas has no name of its own. */
function labelFor(starterId: string): string {
  if (starterId === BLANK) return DEFAULT_NAME;
  return STUDIO_TEMPLATES.find((template) => template.id === starterId)?.label ?? DEFAULT_NAME;
}

export default NewAgentDialog;
