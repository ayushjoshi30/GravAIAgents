"use client";

/**
 * The right-hand panel when nothing on the canvas is selected: the workflow
 * itself rather than one node of it.
 *
 * Its sections mirror the questions someone has about a whole agent — what is
 * it called, what does it take as input, how does it run, which version is
 * live — in the order they ask them.
 *
 * ONE DELIBERATE OMISSION. A panel like this usually carries a row of
 * execution toggles: sequential/parallel, save intermediate state, enable
 * logging, retry on error. Three of those four are not settings this engine
 * has. It always runs in dependency order with independent nodes in parallel,
 * it always keeps every node's output in the trace, and it always writes the
 * run to the ledger and the audit chain — none of it is switchable, and a
 * switch that cannot switch anything is worse than no switch, because someone
 * will turn logging "off" and believe it. So the Execution section states what
 * the engine does instead of pretending to configure it, and the one thing that
 * genuinely is configurable — retries — says where it actually lives.
 */

import { useState } from "react";
import { Icon } from "@/components/icons/AgentIcon";
import { Button } from "@/components/ui/Button";
import { TextArea, TextField } from "@/components/ui/Field";
import type { WorkflowDefinition, WorkflowDetail } from "@/lib/studio";

/** A JSON-schema-ish type name, as the Input node declares them. */
const TYPES = ["string", "number", "boolean"] as const;

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
 * The workflow's inputs, which are the Input node's declared schema.
 *
 * Editing them here rather than in that node's own panel is the point: they are
 * the agent's public signature — what a caller must send once it is deployed —
 * and that is a property of the workflow, not of a box somebody happened to
 * place on the left of the canvas.
 */
function Variables({
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
        This workflow has no Input node, so it takes no arguments. Add one to give it a
        signature.
      </p>
    );
  }

  return (
    <div className="grid gap-1.5">
      {entries.length === 0 ? (
        <p className="text-[12px] text-ink-3">No inputs declared yet.</p>
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
            className="gv-input h-8 w-[84px] text-[12px]"
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
          let name = "input";
          for (let index = 2; name in schema; index += 1) name = `input_${index}`;
          onChange({ ...schema, [name]: "string" });
        }}
        className="mt-0.5 inline-flex items-center gap-1 text-[12px] font-medium text-navy hover:text-navy-ink"
      >
        <Icon name="bolt" size={11} /> Add an input
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
            <TextField
              label="Name"
              value={definition.name}
              onChange={(name) => onChange({ ...definition, name })}
              hint="Deployed agents are called by this name, so it has to be unique in the tenant."
            />
            <TextArea
              label="Description"
              value={definition.description}
              onChange={(description) => onChange({ ...definition, description })}
              rows={3}
            />
          </div>
        </Section>

        <Section title="Inputs">
          <Variables schema={schema} onChange={setSchema} disabled={!inputNode} />
        </Section>

        <Section title="Execution" defaultOpen={false}>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 text-[12px]">
            <dt className="text-ink-3">Order</dt>
            <dd className="text-right text-ink-2">dependency, not drawing</dd>
            <dt className="text-ink-3">Parallelism</dt>
            <dd className="text-right text-ink-2">independent nodes together</dd>
            <dt className="text-ink-3">Agent steps</dt>
            <dd className="text-right text-ink-2" data-numeric="">
              {modelNodes}
            </dd>
            <dt className="text-ink-3">Trace</dt>
            <dd className="text-right text-ink-2">every node, always</dd>
          </dl>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-3">
            None of this is switchable. The engine runs a graph in dependency order, runs whatever
            is ready at the same time, and writes every run to the ledger and the audit chain.
            Retries are per node, in that node&rsquo;s own panel.
          </p>
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
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
            A compiled version is frozen. Editing the canvas afterwards produces the next version
            rather than changing what is already answering calls.
          </p>
        </Section>
      </div>

      <div className="border-t border-line-2 p-3">
        {problems > 0 ? (
          <p className="mb-2 text-[11.5px] leading-relaxed text-bad">
            {problems} blocking {problems === 1 ? "problem" : "problems"} on the canvas. Compiling
            a workflow that cannot run would deploy a broken endpoint.
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
