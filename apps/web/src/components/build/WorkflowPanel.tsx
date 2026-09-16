"use client";

/**
 * The workflow panel.
 *
 * The reference design puts switches in this slot — save intermediate states,
 * enable logging, error retry, and a sequential/parallel mode. None of them are
 * built here, and not for want of time: this page has no engine behind it, so
 * every one of those switches would be a control that cannot do what it says.
 * A visitor who turned "enable logging" off would learn something false about
 * the product, which in a lending-compliance tool is not a small thing.
 *
 * The slot is not wasted. It holds what those switches were gesturing at: how a
 * GravAI agent actually runs. Each line is a statement of the engine's real
 * behaviour, transcribed from the module that implements it, and every one of
 * them is a thing the visitor cannot change here because it is not a setting —
 * it is how the thing works.
 */

import { ButtonLink } from "@/components/ui/Button";
import { VARIABLE_TYPES, type SketchVariable, type VariableType } from "@/components/build/sketch";

/**
 * From `gravai_workflow/engine.py`. Four sentences, four real guarantees. If
 * the engine's behaviour changes, these are wrong and must change with it.
 */
const HOW_IT_RUNS = [
  {
    title: "Dependency order, not drawing order",
    body: "A step runs when what it depends on has settled — not when its turn comes round the diagram.",
  },
  {
    title: "Independent steps run together",
    body: "Two branches of a fan-out have no reason to be serial, so they are not. A join waits for both.",
  },
  {
    title: "An unchosen branch is skipped",
    body: "When a branch is not taken, everything downstream of it is marked skipped. Skipped is not failed.",
  },
  {
    title: "Every step is recorded",
    body: "The trace is assembled as the run proceeds, so it exists whether the run succeeded or not. A failed run is exactly when it matters.",
  },
];

function PanelSection({
  title,
  children,
  description,
}: {
  title: string;
  children: React.ReactNode;
  description?: string;
}) {
  return (
    <section className="border-t border-line px-3.5 py-3.5">
      <h3 className="gv-label text-ink">{title}</h3>
      {description ? <p className="gv-help mt-1">{description}</p> : null}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

export interface WorkflowPanelProps {
  name: string;
  description: string;
  variables: SketchVariable[];
  stepCount: number;
  connectionCount: number;
  onRename: (name: string) => void;
  onDescribe: (description: string) => void;
  onVariableChange: (id: string, patch: Partial<Omit<SketchVariable, "id">>) => void;
  onVariableAdd: () => void;
  onVariableRemove: (id: string) => void;
  onCopyJson: () => void;
  copyState: "idle" | "copied" | "failed";
}

export function WorkflowPanel(props: WorkflowPanelProps) {
  const {
    name,
    description,
    variables,
    stepCount,
    connectionCount,
    onRename,
    onDescribe,
    onVariableChange,
    onVariableAdd,
    onVariableRemove,
    onCopyJson,
    copyState,
  } = props;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="px-3.5 pt-3.5 pb-1">
        <label htmlFor="gv-wf-name" className="gv-label block text-ink">
          Name
        </label>
        <input
          id="gv-wf-name"
          value={name}
          onChange={(event) => onRename(event.target.value)}
          className="gv-field mt-1.5 h-8 text-[13px]"
        />

        <label htmlFor="gv-wf-description" className="gv-label mt-3 block text-ink">
          Description
        </label>
        <textarea
          id="gv-wf-description"
          value={description}
          rows={3}
          onChange={(event) => onDescribe(event.target.value)}
          className="gv-field mt-1.5 text-[12.5px]"
        />

        <p className="gv-help mt-2 tabular-nums">
          {stepCount} {stepCount === 1 ? "step" : "steps"} · {connectionCount}{" "}
          {connectionCount === 1 ? "connection" : "connections"}
        </p>
      </div>

      <PanelSection
        title="How a GravAI agent runs"
        description="Not settings — this is the engine's behaviour, and it is the same for every workflow."
      >
        <ul className="space-y-2.5">
          {HOW_IT_RUNS.map((item) => (
            <li key={item.title} className="border-l-2 border-navy-line pl-2.5">
              <p className="text-[12px] font-semibold text-ink">{item.title}</p>
              <p className="mt-0.5 text-[11.5px] leading-[1.45] text-ink-2">{item.body}</p>
            </li>
          ))}
        </ul>
      </PanelSection>

      <PanelSection
        title="Input variables"
        description="What the agent is handed when it is called. These become the first facts in its state."
      >
        {variables.length === 0 ? (
          <p className="text-[11.5px] text-ink-2">
            No input variables yet. An agent with none reads only what its own steps fetch.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {variables.map((variable, index) => (
              <li key={variable.id} className="flex items-center gap-1.5">
                <label className="sr-only" htmlFor={`gv-var-name-${variable.id}`}>
                  Name of input variable {index + 1}
                </label>
                <input
                  id={`gv-var-name-${variable.id}`}
                  value={variable.name}
                  placeholder="field_name"
                  onChange={(event) => onVariableChange(variable.id, { name: event.target.value })}
                  className="gv-field h-7 min-w-0 flex-1 font-mono text-[11.5px]"
                />
                <label className="sr-only" htmlFor={`gv-var-type-${variable.id}`}>
                  Type of input variable {index + 1}
                </label>
                <select
                  id={`gv-var-type-${variable.id}`}
                  value={variable.type}
                  onChange={(event) =>
                    onVariableChange(variable.id, { type: event.target.value as VariableType })
                  }
                  className="gv-field h-7 w-[84px] flex-none px-1.5 text-[11.5px]"
                >
                  {VARIABLE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => onVariableRemove(variable.id)}
                  aria-label={`Remove input variable ${variable.name || index + 1}`}
                  title={`Remove input variable ${variable.name || index + 1}`}
                  className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-[4px] border border-line text-ink-3 hover:border-fail hover:text-fail focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M5 12h14" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={onVariableAdd}
          className="mt-2 inline-flex items-center gap-1.5 rounded-[4px] border border-line bg-surface px-2 py-1 text-[11.5px] font-medium text-ink-2 hover:border-navy hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          Add a variable
        </button>

        {/* The registry's own default for an Input node is `{"loan_id": "string"}`;
            the types offered here are the engine's port types and nothing more. */}
        <p className="gv-help mt-2">
          Types are the engine's own: string, number, boolean, object, array, any.
        </p>
      </PanelSection>

      <PanelSection title="Version">
        <p className="text-[11.5px] leading-[1.5] text-ink-2">
          <span className="gv-id text-ink">none</span> — a sketch is not a version. The studio
          compiles a version when a workflow is saved there, and only a compiled version can be
          deployed.
        </p>
      </PanelSection>

      <div className="mt-auto border-t border-line bg-surface-2 px-3.5 py-3.5">
        <ButtonLink href="/console/studio" variant="primary" size="md" className="w-full">
          Build this for real in the console
        </ButtonLink>
        <button
          type="button"
          onClick={onCopyJson}
          className="gv-btn gv-btn-secondary mt-2 h-9 w-full border px-3.5 text-[13.5px] font-medium"
        >
          {copyState === "copied"
            ? "Copied to clipboard"
            : copyState === "failed"
              ? "Could not copy — see the note below"
              : "Copy this sketch as JSON"}
        </button>
        <p className="gv-help mt-2.5 leading-relaxed">
          {copyState === "failed"
            ? "This browser refused clipboard access. Nothing was sent anywhere; the sketch is still on the canvas."
            : "Nothing on this page is saved, run or validated. Copying gives you the shape of the workflow — steps, order and branches — to rebuild in the studio, where it can actually be configured and run."}
        </p>
      </div>
    </div>
  );
}
