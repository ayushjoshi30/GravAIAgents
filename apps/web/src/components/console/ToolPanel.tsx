"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/icons/AgentIcon";
import type { McpToolOut } from "@/lib/api";

/**
 * The catalogue half of Tools: what a model host is offered when it connects,
 * and how to connect one. `ToolWorkspace` is the other half — it runs the tool
 * that gets selected here.
 *
 * The handoff shipped two near-identical execution panels (`ToolPanel` and
 * `ToolWorkspace`, the second a revision of the first) plus this list, which
 * lived in the first file. Porting both would have put two copies of the same
 * generated form in the tree, to drift apart the first time one was fixed. So
 * the split here is by job rather than by the package's filenames: this module
 * describes the surface, the other one calls it.
 */

/** Tools arrive sorted permitted-first; within a family that order is worth keeping. */
function matches(tool: McpToolOut, query: string): boolean {
  if (!query) return true;
  const haystack = `${tool.name} ${tool.description} ${tool.tags.join(" ")}`.toLowerCase();
  return haystack.includes(query);
}

/**
 * Left column. Tools the token cannot call stay in the list with the lock shown
 * and the scope named in the tooltip: hiding them would leave a reader working
 * out why a host sees fewer tools than the documentation promises, and showing
 * them as available would be a lie.
 */
export function ToolList({
  tools,
  selected,
  onSelect,
  query,
  onQuery,
  permittedCount,
}: {
  tools: McpToolOut[];
  selected?: string;
  onSelect: (name: string) => void;
  query: string;
  onQuery: (query: string) => void;
  /** From the API's own count, not recomputed here. */
  permittedCount: number;
}) {
  const needle = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const visible = tools.filter((tool) => matches(tool, needle));
    return [
      { key: "agent", label: "Agent tools", tools: visible.filter((tool) => tool.family === "agent") },
      { key: "system", label: "System tools", tools: visible.filter((tool) => tool.family !== "agent") },
    ].filter((group) => group.tools.length > 0);
  }, [tools, needle]);

  return (
    <aside
      aria-label="Tool catalogue"
      // The height cap and the inner scroll are desktop-only on purpose: on a
      // phone the column is the full width of the page, and a scroll area inside
      // a scrolling page is the thing that eats a flick and goes nowhere.
      className="gv-panel min-w-0 flex-[1_1_240px] md:sticky md:top-20 md:max-h-[calc(100vh-120px)] md:max-w-[290px] md:overflow-auto"
    >
      <div className="border-b border-line-2 px-4 py-3.5">
        <p className="gv-eyebrow m-0">Catalogue</p>
        <p className="mt-0.5 mb-0 text-xs text-ink-3">
          {permittedCount} of {tools.length} callable with your token
        </p>
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search tools"
          aria-label="Search tools"
          className="gv-input mt-2.5 h-[34px] text-[13px]"
        />
      </div>

      {tools.length === 0 ? (
        <p className="m-0 px-4 py-6 text-[13px] leading-relaxed text-ink-3">
          No catalogue yet. It is fetched with your token, so it arrives once the API answers.
        </p>
      ) : null}

      {tools.length > 0 && groups.length === 0 ? (
        <p className="m-0 px-4 py-6 text-[13px] text-ink-3">Nothing matches “{query.trim()}”.</p>
      ) : null}

      {groups.map((group) => (
        <div key={group.key}>
          <div className="gv-eyebrow flex justify-between px-4 pt-2.5 pb-1">
            <span>{group.label}</span>
            <span>{group.tools.length}</span>
          </div>
          {group.tools.map((tool) => {
            const on = selected === tool.name;
            return (
              <button
                key={tool.name}
                type="button"
                onClick={() => onSelect(tool.name)}
                aria-current={on ? "true" : undefined}
                title={tool.permitted ? tool.description : `Requires ${tool.scopes.join(", ")}`}
                className={`flex w-full cursor-pointer items-center gap-2 border-0 border-l-[3px] py-2 pr-4 pl-[13px] text-left font-mono text-xs ${
                  on ? "border-l-navy bg-navy-tint" : "border-l-transparent bg-white hover:bg-surface-2"
                } ${tool.permitted ? "text-ink" : "text-ink-4"}`}
              >
                <span className="flex-1 truncate">{tool.name}</span>
                {tool.destructive ? (
                  <span className="rounded-sm bg-surface-3 px-1 text-[10px] text-ink-2">acts</span>
                ) : null}
                {tool.permitted ? null : (
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                    className="shrink-0"
                  >
                    <rect x="2" y="5.5" width="8" height="5.5" rx="1" />
                    <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
                  </svg>
                )}
                {tool.permitted ? null : <span className="sr-only">scope missing</span>}
              </button>
            );
          })}
        </div>
      ))}
    </aside>
  );
}

/**
 * The raw schema, one click away.
 *
 * The generated form is the readable view, but the JSON is what a host is
 * actually handed, and anyone debugging a host's call needs to compare the two
 * character by character. Keeping it collapsed keeps the form the main event.
 */
export function ToolSchema({ tool }: { tool: McpToolOut }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[12.5px] font-medium text-navy"
      >
        {open ? "Hide" : "Show"} the schema a host is handed
        <Icon
          name="chevron"
          size={12}
          className={open ? "-rotate-180 transition-transform" : "transition-transform"}
        />
      </button>
      {open ? (
        <pre className="gv-scroll-x mt-2 max-h-72 overflow-auto rounded-md border border-line-2 bg-surface-3 p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
          {JSON.stringify(tool.input_schema, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

/** A copyable block. The copy button is the point: these are pasted, never retyped. */
export function ConnectBlock({ label, body }: { label: string; body: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-2">
        <p className="gv-eyebrow m-0">{label}</p>
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
          aria-label={`Copy ${label}`}
          className="text-[11.5px] font-medium text-navy"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="gv-scroll-x overflow-x-auto rounded-md border border-line-2 bg-surface-3 p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
        {body}
      </pre>
    </div>
  );
}

/**
 * How to point a host at this deployment.
 *
 * The snippets name a product, and so do the labels above them, because these
 * are commands and configuration keys that only work verbatim: a reader with
 * Claude Desktop open is looking for the words "Claude Desktop" and for the
 * name of the file they have to edit, not for a generically worded block they
 * then have to translate.
 */
export function ConnectHost({ endpoint }: { endpoint: string }) {
  const desktopConfig = JSON.stringify(
    {
      mcpServers: {
        gravai: {
          command: "npx",
          args: ["-y", "mcp-remote", endpoint, "--header", "Authorization: Bearer <token>"],
        },
      },
    },
    null,
    2,
  );

  return (
    // The section takes its accessible name from the heading a sighted reader
    // sees, rather than from a second copy of it in an attribute that could
    // drift away from the visible one.
    <section aria-labelledby="connect-a-host" className="gv-panel p-5">
      <h2 id="connect-a-host" className="m-0 text-[15px] font-semibold">
        Connect a host
      </h2>
      <p className="mt-1 mb-4 max-w-[720px] text-[13px] leading-relaxed text-ink-2">
        The endpoint speaks Streamable HTTP and needs a bearer token on every request. Opening it
        in a browser will always return <code className="font-mono">401</code> — it is not a web
        page, and a browser cannot send the header. That is also why the workspace on this page
        calls the REST run endpoint instead of this one: it is the same runner behind both.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <ConnectBlock label="Endpoint" body={endpoint} />
        <ConnectBlock
          label="Claude Code"
          body={`claude mcp add --transport http gravai ${endpoint} \\\n  --header "Authorization: Bearer <token>" --scope user`}
        />
      </div>

      <div className="mt-4">
        <ConnectBlock label="Claude Desktop — claude_desktop_config.json" body={desktopConfig} />
      </div>
    </section>
  );
}
