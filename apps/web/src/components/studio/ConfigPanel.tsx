"use client";

/**
 * The selected node's settings.
 *
 * Rendered from the node's declared config fields, so a setting cannot appear
 * here that the executor does not read. The same declaration drives the form,
 * the validator and the MCP schema, which is what keeps the three from drifting.
 *
 * JSON-shaped settings are edited as text and parsed on the way out. Parsing on
 * every keystroke and reverting an unparsable value would make the field
 * impossible to type in; instead the text is kept as typed, the error is shown,
 * and the value is only committed when it parses.
 */

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons/AgentIcon";
import { Badge, Tag } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SelectField, TextArea, TextField, ToggleField } from "@/components/ui/Field";
import type { StudioConfigField, StudioNodeSpec, StudioProblem, WorkflowNode } from "@/lib/studio";

function JsonField({
  field,
  value,
  onChange,
}: {
  field: StudioConfigField;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? field.default ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  // Re-seed when the selection changes, but not while the user is typing into
  // this same field — that would fight the cursor.
  useEffect(() => {
    setText(JSON.stringify(value ?? field.default ?? {}, null, 2));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.name]);

  return (
    <div>
      <label className="gv-label mb-1.5 block text-ink">{field.label}</label>
      <textarea
        rows={Math.min(14, Math.max(4, text.split("\n").length + 1))}
        value={text}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            onChange(JSON.parse(next));
            setError(null);
          } catch (exc) {
            setError(exc instanceof Error ? exc.message : "Not valid JSON");
          }
        }}
        className="gv-field font-mono text-[11.5px] leading-relaxed"
        aria-invalid={error ? true : undefined}
      />
      {error ? (
        <p className="mt-1.5 text-[11.5px] text-fail">{error}</p>
      ) : field.help ? (
        <p className="gv-help mt-1.5">{field.help}</p>
      ) : null}
    </div>
  );
}

function ConfigControl({
  field,
  value,
  onChange,
}: {
  field: StudioConfigField;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  if (field.kind === "json") {
    return <JsonField field={field} value={value} onChange={onChange} />;
  }
  if (field.kind === "boolean") {
    return (
      <ToggleField
        label={field.label}
        checked={Boolean(value)}
        onChange={onChange}
        hint={field.help}
      />
    );
  }
  if (field.kind === "select") {
    return (
      <SelectField
        label={field.label}
        value={String(value ?? field.default ?? "")}
        onChange={onChange}
        options={field.choices.map((choice) => ({ value: choice, label: choice }))}
        hint={field.help}
      />
    );
  }
  if (field.kind === "textarea" || field.kind === "expression") {
    return (
      <TextArea
        label={field.label}
        value={String(value ?? "")}
        onChange={onChange}
        rows={field.kind === "expression" ? 2 : 5}
        required={field.required}
        hint={
          field.templated
            ? `${field.help} May reference {{workflow.facts}} and {{nodes.<id>}}.`.trim()
            : field.help
        }
      />
    );
  }
  return (
    <TextField
      label={field.label}
      value={String(value ?? "")}
      onChange={onChange}
      type={field.kind === "number" ? "number" : "text"}
      mono={field.kind === "number"}
      hint={field.help}
    />
  );
}

export function ConfigPanel({
  node,
  spec,
  problems,
  onChange,
  onRename,
  onDuplicate,
  onDelete,
  onClose,
}: {
  node: WorkflowNode;
  spec: StudioNodeSpec;
  problems: StudioProblem[];
  onChange: (name: string, value: unknown) => void;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const errors = problems.filter((p) => p.severity === "error");
  const warnings = problems.filter((p) => p.severity === "warning");

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold text-ink">{spec.label}</p>
          <p className="truncate font-mono text-[11px] text-ink-3">{node.id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="gv-scroll-y min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-2">{spec.summary}</p>

        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {spec.uses_llm ? <Badge tone="brand">uses the model</Badge> : <Tag>deterministic</Tag>}
          {spec.branching ? <Tag>branches</Tag> : null}
          {spec.outputs.slice(0, 4).map((port) => (
            <Tag key={port.name}>{port.name}</Tag>
          ))}
        </div>

        {spec.caveat ? (
          <p className="mb-4 flex items-start gap-2 rounded-lg border border-line bg-sunken p-3 text-[12px] leading-relaxed text-ink-2">
            <span className="mt-px shrink-0 text-ink-3">
              <Icon name="book" size={13} />
            </span>
            <span>{spec.caveat}</span>
          </p>
        ) : null}

        {errors.length > 0 ? (
          <ul className="mb-4 space-y-1 rounded-lg border border-fail-border bg-fail-soft p-3 text-[12px] text-fail">
            {errors.map((problem) => (
              <li key={problem.message}>{problem.message}</li>
            ))}
          </ul>
        ) : null}

        {warnings.length > 0 ? (
          <ul className="mb-4 space-y-1 rounded-lg border border-amber-border bg-amber-soft p-3 text-[12px] text-amber-strong">
            {warnings.map((problem) => (
              <li key={problem.message}>{problem.message}</li>
            ))}
          </ul>
        ) : null}

        <div className="space-y-4">
          <TextField label="Name" value={node.name} onChange={onRename} />
          {spec.config.map((field) => (
            <ConfigControl
              key={field.name}
              field={field}
              value={node.config[field.name]}
              onChange={(next) => onChange(field.name, next)}
            />
          ))}
        </div>

        {spec.outputs.length > 0 ? (
          <div className="mt-6">
            <p className="gv-eyebrow mb-2">Outputs, addressable downstream</p>
            <ul className="space-y-1">
              {spec.outputs.map((port) => (
                <li key={port.name} className="flex items-baseline gap-2">
                  <code className="font-mono text-[11px] text-brand">
                    {`{{nodes.${node.id}.${port.name}}}`}
                  </code>
                  <span className="text-[11px] text-ink-3">{port.type}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        <Button size="sm" variant="secondary" onClick={onDuplicate}>
          Duplicate
        </Button>
        <Button size="sm" variant="danger" onClick={onDelete} className="ml-auto">
          Delete
        </Button>
      </div>
    </aside>
  );
}
