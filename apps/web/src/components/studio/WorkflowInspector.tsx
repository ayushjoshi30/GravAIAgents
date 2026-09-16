"use client";

/**
 * The right-hand panel when nothing on the canvas is selected: the workflow
 * itself rather than one node of it.
 *
 * Its sections mirror the questions someone has about a whole agent — what is
 * it called, what does it accept, how does it run, which version is live — in
 * the order they ask them.
 *
 * TEXT BUDGET. An earlier version of this panel explained itself at length:
 * a paragraph under most fields and a short essay under two of the sections.
 * All of it was true and most of it was unwanted, because a panel you use
 * twenty times a day should be scannable, and prose you have already read is
 * just something to look past. The explanations are still here, behind a `?`
 * next to the thing they explain. Read once, then never in the way again.
 *
 * ONE DELIBERATE OMISSION. A panel like this usually carries execution toggles:
 * sequential/parallel, save intermediate state, enable logging, retry on error.
 * Three of those four are not settings this engine has — it always runs in
 * dependency order with independent nodes in parallel, always keeps every
 * node's output in the trace, and always writes the run to the ledger and the
 * audit chain. A switch that cannot switch anything is worse than no switch,
 * because someone will turn logging "off" and believe it.
 */

import { useId, useState } from "react";
import { Icon } from "@/components/icons/AgentIcon";
import { Button } from "@/components/ui/Button";
import { TextArea, TextField } from "@/components/ui/Field";
import type { WorkflowDefinition, WorkflowDetail } from "@/lib/studio";

/**
 * The types an input can declare, including the one that declares nothing.
 *
 * "any" is first and is the default for a new row, because it is the honest
 * default: the engine's `input` node emits a single `payload: object` port
 * described as "whatever the caller sent", and nothing downstream reads a
 * declared type. Narrowing is a choice a tenant makes when they want their
 * endpoint to reject malformed calls early, not a box to tick on the way to a
 * working workflow.
 */
const TYPES = ["any", "string", "number", "boolean", "object", "array"] as const;

/** A short explanation, behind a `?`. Collapsed by default, and never in the way. */
function Explain({ children, label }: { children: React.ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={id}
        // The accessible name says what will be explained. "?" alone tells a
        // screen-reader user nothing about which of the six of these they are on.
        aria-label={open ? `Hide the note about ${label}` : `What is ${label}?`}
        className="inline-flex size-[15px] shrink-0 items-center justify-center rounded-full border border-line text-[10px] leading-none font-semibold text-ink-3 hover:border-ink-4 hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy"
      >
        ?
      </button>
      {open ? (
        <p id={id} className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
          {children}
        </p>
      ) : null}
    </>
  );
}

function Section({
  title,
  children,
  defaultOpen = true,
  action,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-line-2">
      <div className="flex items-center gap-1.5 px-4 pt-3.5 pb-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 text-left"
        >
          <Icon
            name="chevron"
            size={11}
            className={`text-ink-3 transition-transform ${open ? "" : "-rotate-90"}`}
          />
          <span className="text-[12.5px] font-semibold text-ink">{title}</span>
        </button>
        {action}
      </div>
      {open ? <div className="px-4 pb-3.5">{children}</div> : null}
    </section>
  );
}

/**
 * What a caller may send, which is not the same as what a caller must send.
 *
 * WHY THIS IS OPTIONAL, AND WHY THAT IS NOT A SHORTCUT. In the engine, the
 * `input` node's `schema` config is declared optional and its only output port
 * is `payload: object` — "whatever the caller sent". Every agent node
 * downstream takes exactly one input, `state: object`, also optional, described
 * as "reads the shared workflow state". Nothing is typed node-to-node: a step
 * reads the state earlier steps wrote.
 *
 * That is the right model for this product, because the input to an agent is
 * usually another agent's output, or a payload some API posted in whatever
 * shape that API uses. An earlier version of this panel presented name/type
 * pairs as though they had to be filled in before anything would work, which
 * was a constraint the interface had invented.
 *
 * So: declaring nothing is a complete and correct answer, and the panel says so
 * rather than showing an empty list that reads like an unfinished form.
 */
function Inputs({
  schema,
  onChange,
  disabled,
}: {
  schema: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled: boolean;
}) {
  const entries = Object.entries(schema);

  if (disabled) {
    return (
      <p className="text-[12px] leading-relaxed text-ink-3">
        No Input node on the canvas, so this workflow takes no arguments. Add one to give it a
        signature.
      </p>
    );
  }

  return (
    <div className="grid gap-1.5">
      {entries.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-ink-3">
          Accepts whatever the caller sends.{" "}
          <Explain label="accepting any input">
            Steps read the shared state that earlier steps wrote, so nothing here has to be
            declared. Name a field only when you want the deployed endpoint to reject calls that
            leave it out.
          </Explain>
        </p>
      ) : null}

      {entries.map(([name, type]) => (
        <div key={name} className="flex items-center gap-1.5">
          <input
            value={name}
            aria-label={`Name of input ${name}`}
            onChange={(event) => {
              const next: Record<string, string> = {};
              // Rebuilt in order rather than deleted and re-added, so renaming a
              // field does not send it to the bottom of the list mid-keystroke.
              for (const [key, value] of entries) {
                next[key === name ? event.target.value : key] = value;
              }
              onChange(next);
            }}
            className="gv-input h-8 min-w-0 flex-1 font-mono text-[12px]"
          />
          <select
            value={type}
            aria-label={`Type of input ${name}`}
            onChange={(event) => onChange({ ...schema, [name]: event.target.value })}
            className="gv-input h-8 w-[76px] text-[12px]"
          >
            {TYPES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label={`Remove input ${name}`}
            onClick={() => {
              const next = { ...schema };
              delete next[name];
              onChange(next);
            }}
            className="rounded-[4px] p-1 text-ink-3 hover:bg-surface-2 hover:text-bad"
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => {
          let name = "field";
          for (let index = 2; name in schema; index += 1) name = `field_${index}`;
          // New rows are "any": naming a field should not silently also assert
          // it is a string.
          onChange({ ...schema, [name]: "any" });
        }}
        className="mt-0.5 inline-flex w-fit items-center gap-1 text-[12px] font-medium text-navy hover:text-navy-ink"
      >
        <Icon name="bolt" size={11} /> Require a field
      </button>
    </div>
  );
}

export function WorkflowInspector({
  definition,
  workflow,
  onChange,
  onCompileAndDeploy,
  busy,
  problems,
  onClose,
}: {
  definition: WorkflowDefinition;
  workflow: WorkflowDetail | null;
  onChange: (next: WorkflowDefinition) => void;
  onCompileAndDeploy: () => void;
  busy: string;
  /** Blocking problems on the canvas. A broken graph must not become an endpoint. */
  problems: number;
  onClose: () => void;
}) {
  const inputNode = definition.nodes.find((node) => node.type === "input");
  const rawSchema = inputNode?.config?.schema;
  const schema: Record<string, string> =
    rawSchema && typeof rawSchema === "object" && !Array.isArray(rawSchema)
      ? Object.fromEntries(
          Object.entries(rawSchema as Record<string, unknown>).map(([key, value]) => [
            key,
            String(value),
          ]),
        )
      : {};

  const deployed = workflow?.versions?.find((entry) => entry.status === "deployed");
  const nextVersion = `${(workflow?.versions?.length ?? 0) + 1}.0`;

  const setSchema = (next: Record<string, string>) => {
    if (!inputNode) return;
    onChange({
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.id === inputNode.id ? { ...node, config: { ...node.config, schema: next } } : node,
      ),
    });
  };

  const modelNodes = definition.nodes.filter((node) => node.type.startsWith("agent.")).length;

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-l border-line bg-white">
      <div className="flex items-center gap-2 border-b border-line-2 px-4 py-3">
        <span className="flex-1 text-[13.5px] font-semibold text-ink">Workflow</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the workflow panel"
          className="rounded-[4px] p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="gv-scroll-y min-h-0 flex-1 overflow-y-auto">
        <Section title="Identity">
          <div className="grid gap-3">
            {/* The label and its `?` on one row, above the input.
                
                `TextField` takes a plain string label, so pairing it with the
                affordance means writing the label here and letting the field
                render unlabelled — hence the `aria-label` on the input, which
                carries the accessible name the visible text no longer supplies
                through a `for`/`id` pair. The `?` sat below the input before,
                where it read as a stray glyph attached to nothing. */}
            <div>
              <div className="mb-1 flex items-center gap-1.5">
                <span className="gv-label">Name</span>
                <Explain label="the workflow name">
                  Deployed agents are called by this name, so it has to be unique in the tenant.
                </Explain>
              </div>
              <input
                value={definition.name}
                aria-label="Workflow name"
                onChange={(event) => onChange({ ...definition, name: event.target.value })}
                className="gv-input h-9 w-full text-[13px]"
              />
            </div>
            <TextArea
              label="Description"
              value={definition.description}
              onChange={(description) => onChange({ ...definition, description })}
              rows={3}
            />
          </div>
        </Section>

        <Section title="Accepts">
          <Inputs schema={schema} onChange={setSchema} disabled={!inputNode} />
        </Section>

        <Section title="Execution" defaultOpen={false}>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 text-[12px]">
            <dt className="text-ink-3">Order</dt>
            <dd className="text-right text-ink-2">by dependency</dd>
            <dt className="text-ink-3">Parallelism</dt>
            <dd className="text-right text-ink-2">independent steps together</dd>
            <dt className="text-ink-3">Agent steps</dt>
            <dd className="text-right text-ink-2" data-numeric="">
              {modelNodes}
            </dd>
            <dt className="text-ink-3">Trace</dt>
            <dd className="text-right text-ink-2">every step, always</dd>
          </dl>
          <div className="mt-2">
            <Explain label="execution">
              None of this is switchable. Retries are per step, in that step&rsquo;s own panel.
            </Explain>
          </div>
        </Section>

        <Section title="Version">
          <div className="flex items-center gap-2">
            <span className="gv-id text-ink">
              {deployed ? `v${deployed.version}` : `v${nextVersion} (next)`}
            </span>
            {deployed ? (
              <span className="gv-chip gv-chip-green">deployed</span>
            ) : (
              <span className="gv-chip gv-chip-slate">not deployed</span>
            )}
            <span className="ml-auto">
              <Explain label="versions">
                A compiled version is frozen. Editing the canvas afterwards produces the next
                version rather than changing what is already answering calls.
              </Explain>
            </span>
          </div>
        </Section>
      </div>

      <div className="border-t border-line-2 p-3">
        {problems > 0 ? (
          <p className="mb-2 text-[11.5px] leading-relaxed text-bad">
            {problems} blocking {problems === 1 ? "problem" : "problems"} below the canvas.
          </p>
        ) : null}
        <Button
          variant="primary"
          className="w-full"
          onClick={onCompileAndDeploy}
          disabled={problems > 0 || Boolean(busy)}
          title={
            problems > 0 ? "Fix the problems listed under the canvas first" : "Compile and deploy"
          }
        >
          {busy === "compile" ? "Compiling…" : busy.startsWith("deploy") ? "Deploying…" : "Deploy"}
        </Button>
      </div>
    </aside>
  );
}
