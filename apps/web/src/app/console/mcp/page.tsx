"use client";

/**
 * MCP — what a model host is offered when it connects, and a place to run it.
 *
 * This page is the production `/console/mcp` with the execution work that grew
 * on it while it was briefly called Tools. Both halves are worth keeping: the
 * catalogue and the connect blocks are what someone wiring up a host needs, and
 * the run form is what someone checking a tool before they hand it to a host
 * needs. Dropping either in the name of matching one version of the page would
 * have been a trade that lost real capability.
 *
 * The catalogue is fetched, never hard-coded, because it is derived from the
 * same agent registry the REST API and the website read. A copy here would
 * drift the first time an agent moved, and the page would start describing a
 * server that no longer exists.
 */

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { ConsolePage } from "@/components/console/ConsoleShell";
import { Figure, Skeleton } from "@/components/console/primitives";
import { ConnectHost, ToolList, ToolSchema } from "@/components/console/ToolPanel";
import { ToolWorkspace } from "@/components/console/ToolWorkspace";
import { ApiFailureBanner } from "@/components/ui/States";
import { api, API_BASE, type AgentOut, type McpToolOut } from "@/lib/api";
import { AGENTS } from "@/lib/agents";
import { useToken } from "@/lib/session";
import { useResource } from "@/lib/useResource";

/**
 * Where a model host connects.
 *
 * The endpoint is derived from `API_BASE` — the same
 * `NEXT_PUBLIC_GRAVAI_API_BASE` every other request in this console is built
 * from — so that a console pointed at one deployment cannot hand out another
 * deployment's URL. Only the origin is borrowed: on staging the REST API sits
 * behind a path prefix that the proxy strips before uvicorn sees it, while the
 * MCP server is its own route at the root, so appending to the full base would
 * print an endpoint that answers 404.
 */
function mcpEndpointFor(base: string): string {
  try {
    return new URL("/mcp", base).toString();
  } catch {
    // A base with no origin to borrow — a console proxied onto the same host as
    // its API and configured with a bare path. The endpoint is then relative to
    // wherever this console is served from, which is the honest answer even
    // though it is one a reader has to complete themselves.
    return "/mcp";
  }
}

const MCP_ENDPOINT = mcpEndpointFor(API_BASE);

const NO_AGENTS: AgentOut[] = [];

export default function ConsoleMcpPage() {
  // `useSearchParams` opts the tree into client-side rendering, and a build
  // without this boundary fails rather than warns. The fallback is the same
  // skeleton the explorer shows while the catalogue loads, so the two are
  // indistinguishable to a reader.
  return (
    <Suspense fallback={<McpSkeleton />}>
      <McpExplorer />
    </Suspense>
  );
}

function McpExplorer() {
  const [token] = useToken();
  const router = useRouter();
  const pathname = usePathname() ?? "/console/mcp";
  const params = useSearchParams();
  const [query, setQuery] = useState("");

  const surface = useResource(`mcp-surface:${token ?? "none"}`, (signal) => api.mcpSurface(token, signal), null);

  // The tool names a host sees; the run endpoint is addressed by agent id. The
  // list carries that mapping, so it is fetched rather than assumed — and only
  // when it does not answer does the compiled catalogue stand in. Merging the
  // two would let a stale local entry silently outrank the live one, which in
  // the worst case points Run at a different agent than the one named.
  const agents = useResource(`agents:${token ?? "none"}`, (signal) => api.listAgents(token, signal), NO_AGENTS);
  const agentByTool = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    if (agents.mode === "live") {
      for (const agent of agents.data) map.set(agent.tool_name, { id: agent.id, name: agent.name });
    } else {
      for (const agent of AGENTS) map.set(agent.toolName, { id: agent.id, name: agent.name });
    }
    return map;
  }, [agents.data, agents.mode]);

  const tools: McpToolOut[] = surface.data?.tools ?? [];

  // Selection lives in the URL rather than in state: the command palette deep
  // links to `?tool=…`, and a reader who sends someone a link to a tool should
  // be sending them to that tool.
  const requested = params.get("tool");
  const requestedTool = requested ? tools.find((tool) => tool.name === requested) : undefined;
  const selected =
    requestedTool ??
    tools.find((tool) => tool.permitted && tool.family === "agent") ??
    tools[0];

  // A link that names a tool has to land on that tool or say why it did not.
  // The catalogue belongs to the deployment, not to this console, so a
  // `?tool=…` pasted into a ticket months ago can name something this API no
  // longer advertises. Falling back without a word would leave a reader
  // studying one tool's schema and arguments under a URL that names another,
  // which is exactly the quiet substitution this console exists to prevent.
  const requestedMissing = Boolean(requested && !requestedTool && tools.length > 0);

  const select = useCallback(
    (name: string) => {
      router.replace(`${pathname}?tool=${encodeURIComponent(name)}`, { scroll: false });
    },
    [pathname, router],
  );

  const loading = surface.mode === "loading";
  const failure = surface.failure;
  // A missing token is not a failed request. It is the one case where nothing
  // was ever asked of the API, and it reads differently from an API that was
  // asked and did not answer.
  const noToken = failure?.kind === "no-token";
  const systemCount = tools.filter((tool) => tool.family !== "agent").length;

  return (
    <ConsolePage
      title="MCP"
      description="What a model host is offered when it connects with your token, and how to connect one."
    >
      {surface.data ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
          <Figure
            label="Advertised to a host"
            value={String(surface.data.permitted_tools)}
            note="every scope held"
          />
          <Figure
            label="In the catalogue"
            value={String(surface.data.total_tools)}
            note="including the ones your token cannot call"
          />
          <Figure
            label="Scopes your token holds"
            value={String(surface.data.held_scopes.length)}
            note={surface.data.held_scopes.join(" · ") || "none"}
          />
        </div>
      ) : null}

      {noToken ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-line-2 bg-surface-3 px-3.5 py-2.5"
        >
          {/* Neutral, not amber: no token is a state of the world rather than
              something having gone wrong, and the colours in this product are
              reserved for outcomes. */}
          <p className="flex min-w-0 items-baseline gap-2 text-[12.5px] leading-relaxed text-ink-2">
            <span className="mt-1.5 block h-2 w-2 shrink-0 rounded-full bg-ink-4" aria-hidden="true" />
            <span className="min-w-0">
              <span className="font-medium text-ink">No API token.</span> The catalog is filtered by
              the scopes your token holds, so add one in Settings to see what a host would actually
              be offered.
            </span>
          </p>
          <Link href="/console/settings" className="shrink-0 text-[12.5px] font-medium text-navy underline underline-offset-2">
            Set a token
          </Link>
        </div>
      ) : null}

      {/* Held back while a retry is in flight: the sentence below states that
          nothing is listed, and saying that over a loading skeleton would be
          describing the previous attempt as though it were this one. */}
      {failure && !noToken && !loading ? (
        <div className="grid gap-2">
          {/* The shared banner carries the HTTP status and the correlation id
              when the failure has them, which is what lets someone find this
              exact request in the API's own logs. */}
          <ApiFailureBanner failure={failure} onRetry={surface.reload} what="the tool catalogue" />
          <p className="max-w-[720px] text-[12.5px] leading-relaxed text-ink-3">
            Nothing is listed below because the catalogue is the API&rsquo;s answer, not this
            console&rsquo;s guess. An invented tool list is the one thing this page must never
            show: it would send someone to wire up a host against tools that do not exist.
          </p>
        </div>
      ) : null}

      {loading ? <McpSkeleton /> : null}

      {!loading && requestedMissing ? (
        <p className="max-w-[720px] text-[12.5px] leading-relaxed text-ink-2">
          <span className="font-medium text-ink">
            No tool named <span className="font-mono">{requested}</span> is in this catalogue.
          </span>{" "}
          The API this console is pointed at does not advertise that name — and the list keeps
          the tools your token cannot call, so this is not a scope you are short of.
          {selected ? <> The catalogue below is unchanged, with {selected.name} selected.</> : null}
        </p>
      ) : null}

      {!loading && tools.length > 0 ? (
        <div className="flex flex-wrap items-start gap-4">
          <ToolList
            tools={tools}
            selected={selected?.name}
            onSelect={select}
            query={query}
            onQuery={setQuery}
            permittedCount={surface.data?.permitted_tools ?? 0}
          />

          <div className="min-w-0 flex-[1_1_420px]">
            {selected ? (
              <>
                <ToolWorkspace
                  // Keyed by name so that switching tools starts a clean form
                  // rather than carrying one tool's arguments into another's.
                  key={selected.name}
                  tool={selected}
                  agentId={agentByTool.get(selected.name)?.id ?? null}
                  agentName={agentByTool.get(selected.name)?.name}
                  token={token}
                  heldScopes={surface.data?.held_scopes ?? []}
                />
                <ToolSchema tool={selected} />
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {!loading && !failure && tools.length === 0 ? (
        <p className="max-w-[720px] text-[13px] leading-relaxed text-ink-3">
          The API answered with an empty catalogue. That is not a filter on your token — the
          count above is what it advertises to anyone — so there is genuinely no tool deployed
          here to describe.
        </p>
      ) : null}

      {!loading && systemCount > 0 ? (
        <p className="max-w-[720px] text-[12.5px] leading-relaxed text-ink-3">
          {systemCount} of these wrap one platform capability each — fetching an application,
          verifying the audit chain. They are advertised in the catalogue, but neither the stdio
          nor the HTTP server serves them yet: each reads the service layer, which the MCP process
          has no session for. They are listed so that you know what is coming and can see the
          shape a host will be offered; selecting one shows its schema and says plainly that there
          is nothing to run.
        </p>
      ) : null}

      <ConnectHost endpoint={MCP_ENDPOINT} />
    </ConsolePage>
  );
}

/** Block skeletons rather than a loading sentence: the page keeps its shape. */
function McpSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-wrap items-start gap-4">
      <div className="gv-panel min-w-0 flex-[1_1_240px] p-4 md:max-w-[290px]">
        <div className="grid gap-2.5">
          <Skeleton h={18} w="50%" />
          {[80, 65, 72, 58, 70, 62].map((width, index) => (
            <Skeleton key={`${width}-${index}`} w={`${width}%`} />
          ))}
        </div>
      </div>
      <div className="gv-panel min-w-0 flex-[1_1_420px] p-5">
        <div className="grid gap-2.5">
          <Skeleton h={22} w="40%" />
          <Skeleton w="85%" />
          <Skeleton w="70%" />
          <Skeleton h={80} />
        </div>
      </div>
    </div>
  );
}
