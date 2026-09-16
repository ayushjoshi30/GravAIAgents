"use client";

/**
 * DEPLOY mode: turn a draft into a version, and a version into an endpoint.
 *
 * A compiled version is immutable. That is the whole reason compiling is a
 * separate act from saving: editing a deployed workflow in place would change
 * the behaviour of every integration already calling it, without anyone
 * choosing that. Editing after deployment produces the next version instead,
 * and the deployed one keeps answering until someone promotes the new one.
 */

import { useState } from "react";
import { Icon } from "@/components/icons/AgentIcon";
import { Badge, Tag } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { API_BASE } from "@/lib/api";
import { formatInr } from "@/lib/format";
import type { RunSummary, WorkflowDetail, WorkflowVersion } from "@/lib/studio";

function CopyLine({ label, body }: { label: string; body: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <p className="gv-eyebrow">{label}</p>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(body).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              },
              () => undefined,
            );
          }}
          className="text-[11.5px] font-medium text-brand hover:text-brand-600"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="gv-scroll-x overflow-x-auto rounded-lg border border-line bg-sunken p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
        {body}
      </pre>
    </div>
  );
}

function VersionRow({
  version,
  onDeploy,
  deploying,
}: {
  version: WorkflowVersion;
  onDeploy: () => void;
  deploying: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 last:border-b-0">
      <code className="font-mono text-[12.5px] font-semibold text-ink">v{version.version}</code>
      {version.status === "deployed" ? (
        <Badge tone="pass" dot>
          deployed
        </Badge>
      ) : version.status === "retired" ? (
        <Tag>retired</Tag>
      ) : (
        <Badge tone="neutral">compiled</Badge>
      )}
      <span className="font-mono text-[11px] text-ink-3">{version.created_at.slice(0, 16)}</span>
      {version.status !== "deployed" ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={onDeploy}
          disabled={deploying}
          className="ml-auto"
        >
          {deploying ? "Deploying…" : "Deploy"}
        </Button>
      ) : null}
    </li>
  );
}

export function DeployPanel({
  workflow,
  inputSchema,
  problems,
  onCompile,
  onDeploy,
  busy,
  runs,
  message,
}: {
  workflow: WorkflowDetail | null;
  /** The Input node's declared fields, so the example call is one that works. */
  inputSchema: Record<string, unknown>;
  problems: number;
  onCompile: (version: string, description: string) => void;
  onDeploy: (versionId: string) => void;
  busy: string;
  runs: RunSummary[];
  message: string;
}) {
  const versions = workflow?.versions ?? [];
  const next = `${versions.length + 1}.0`;
  const [version, setVersion] = useState(next);
  const [description, setDescription] = useState("");

  const deployed = versions.find((entry) => entry.status === "deployed");

  // Built from the declared schema rather than a fixed example. A deployed
  // agent refuses fields it does not declare, so a hardcoded sample here would
  // hand someone a command that returns 422 the first time they run it.
  const exampleInputs = Object.fromEntries(
    Object.entries(inputSchema).map(([name, kind]) => {
      const type = String(kind);
      return [name, type === "number" ? 0 : type === "boolean" ? false : ""];
    }),
  );
  const endpoint = workflow
    ? `${API_BASE}/v1/studio/deployed/${encodeURIComponent(workflow.name)}/run`
    : "";

  if (!workflow) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="max-w-sm text-[12.5px] leading-relaxed text-ink-3">
          Save the workflow before compiling it into a version.
        </p>
      </div>
    );
  }

  return (
    <div className="gv-scroll-y h-full overflow-y-auto">
      <section className="border-b border-line px-4 py-4">
        <h3 className="text-[13px] font-semibold text-ink">Compile a version</h3>
        <p className="mt-1 mb-3 text-[12.5px] leading-relaxed text-ink-2">
          A compiled version is frozen. Editing the canvas afterwards produces the next version
          rather than changing what is already answering calls.
        </p>

        {problems > 0 ? (
          <p className="mb-3 flex items-start gap-2 rounded-lg border border-fail-border bg-fail-soft p-3 text-[12.5px] text-fail">
            <span className="mt-px shrink-0">
              <Icon name="warning" size={13} />
            </span>
            <span>
              {problems} blocking {problems === 1 ? "problem" : "problems"} on the canvas. Fix them
              in BUILD first — compiling a workflow that cannot run would deploy a broken endpoint.
            </span>
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Version" value={version} onChange={setVersion} mono />
          <TextField
            label="What changed"
            value={description}
            onChange={setDescription}
            placeholder="Added the fraud check branch"
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() => onCompile(version, description)}
            disabled={busy === "compile" || problems > 0}
          >
            {busy === "compile" ? "Compiling…" : "Compile agent"}
          </Button>
          {message ? <span className="text-[12px] text-ink-2">{message}</span> : null}
        </div>
      </section>

      <section className="border-b border-line">
        <div className="flex items-baseline gap-2 px-4 py-3">
          <h3 className="text-[13px] font-semibold text-ink">Versions</h3>
          <span className="font-mono text-[11.5px] text-ink-3" data-numeric="">
            {versions.length}
          </span>
        </div>
        {versions.length === 0 ? (
          <p className="px-4 pb-3 text-[12.5px] text-ink-3">Nothing compiled yet.</p>
        ) : (
          <ul>
            {versions.map((entry) => (
              <VersionRow
                key={entry.id}
                version={entry}
                deploying={busy === `deploy:${entry.id}`}
                onDeploy={() => onDeploy(entry.id)}
              />
            ))}
          </ul>
        )}
      </section>

      {deployed ? (
        <section className="border-b border-line px-4 py-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="text-[13px] font-semibold text-ink">{workflow.name}</h3>
            <code className="font-mono text-[12px] text-ink-2">v{deployed.version}</code>
            <Badge tone="pass" dot>
              deployed
            </Badge>
          </div>

          <div className="space-y-3">
            <CopyLine label="Endpoint" body={`POST ${endpoint}`} />
            <CopyLine
              label="Call it"
              body={`curl -X POST ${endpoint} \\\n  -H "Authorization: Bearer <token>" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ inputs: exampleInputs })}'`}
            />
          </div>

          <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
            The whole workflow answers as one agent. The token needs the{" "}
            <code className="font-mono">agents:run</code> scope, and the run is written to the
            ledger and the audit chain like any other.
          </p>
        </section>
      ) : null}

      <section>
        <div className="flex items-baseline gap-2 px-4 py-3">
          <h3 className="text-[13px] font-semibold text-ink">Recent runs</h3>
          <span className="font-mono text-[11.5px] text-ink-3" data-numeric="">
            {runs.length}
          </span>
        </div>
        {runs.length === 0 ? (
          <p className="px-4 pb-4 text-[12.5px] text-ink-3">No runs recorded yet.</p>
        ) : (
          <ul className="pb-4">
            {runs.slice(0, 20).map((run) => {
              // The list carries ids, not labels. A version is named only when
              // it is one of this workflow's own; anything else is honestly
              // shown as a draft run rather than given a made-up number.
              const version = versions.find((entry) => entry.id === run.version_id);
              return (
                <li
                  key={run.id}
                  className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 last:border-b-0"
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      run.status === "completed"
                        ? "bg-pass"
                        : run.status === "failed"
                          ? "bg-fail"
                          : "bg-amber"
                    }`}
                    title={run.status}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                    {run.status.replace("_", " ")}
                  </span>
                  <Tag>{version ? `v${version.version}` : "draft"}</Tag>
                  <span className="font-mono text-[11px] text-ink-3" data-numeric="">
                    {(run.duration_ms / 1000).toFixed(1)}s
                  </span>
                  <span className="font-mono text-[11px] text-ink-3" data-numeric="">
                    {formatInr(run.cost_inr)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
