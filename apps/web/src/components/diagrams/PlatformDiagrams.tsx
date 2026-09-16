/**
 * Hand-authored platform diagrams. No image files, no diagram library:
 * geometry computed from the same constants the platform runs on, so the
 * picture cannot drift away from the code.
 *
 * All four are drawn in a 720-unit coordinate system and rendered between 700
 * and 920 CSS pixels, so a 10-unit label lands at roughly 10-13px in every
 * column they appear in. Each sits in its own scroller, so a phone scrolls the
 * drawing rather than the page — and the prose that used to be set as a single
 * unwrappable line of SVG text is now a real caption that reflows at 400px.
 *
 * Glyphs follow `components/icons/AgentIcon.tsx`: 24x24 grid, 1.4 stroke,
 * square caps, no fill.
 */

import type { ReactNode } from "react";

import { DIGITISE_POLLS_FLAT, EXTRACT_POLLS } from "@/lib/throughput";

// --- The shared frame -----------------------------------------------------

/** Every diagram gets the same chrome: a titled panel, a scroller, a caption. */
function DiagramFrame({
  label,
  icon,
  meta,
  scrollLabel,
  caption,
  className,
  children,
}: {
  label: string;
  icon: string[];
  meta?: string;
  scrollLabel: string;
  caption?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={`min-w-0 ${className ?? ""}`}>
      <div className="gv-panel overflow-hidden">
        <div className="gv-toolbar">
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="gv-icon-plate gv-icon-plate-sm" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="square"
                strokeLinejoin="miter"
              >
                {icon.map((d) => (
                  <path key={d} d={d} />
                ))}
              </svg>
            </span>
            <span className="truncate text-[13px] font-semibold text-ink">{label}</span>
          </span>
          {meta ? <span className="gv-micro font-mono">{meta}</span> : null}
        </div>
        <div
          className="gv-scroll-x gv-grid-fine bg-surface"
          role="region"
          aria-label={scrollLabel}
          tabIndex={0}
        >
          {children}
        </div>
      </div>
      {caption ? (
        <figcaption className="gv-micro gv-measure-wide mt-3">{caption}</figcaption>
      ) : null}
    </figure>
  );
}

/** The one place the svg sizing rule lives. */
const SVG_FIT = { minWidth: 700, maxWidth: 920 } as const;
const SVG_CLASS = "mx-auto block h-auto w-full";

// --- Document Intelligence lifecycle -------------------------------------

/** The production back-off: 0.8 s first, x1.35 growth, 5.0 s cap. */
function backoffTimes(count: number): number[] {
  const times: number[] = [];
  let delay = 0.8;
  let elapsed = 0;
  for (let i = 0; i < count; i += 1) {
    elapsed += delay;
    times.push(elapsed);
    delay = Math.min(5.0, delay * 1.35);
  }
  return times;
}

function flatTimes(count: number, interval = 0.8): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * interval);
}

const BACKOFF_TIMES = backoffTimes(EXTRACT_POLLS);
const FLAT_TIMES = flatTimes(DIGITISE_POLLS_FLAT);
const T_MAX = 33;
/** The plotting rectangle. Only the frame moved; every tick is still toX(t). */
const X0 = 160;
const X1 = 700;
const SCALE = (X1 - X0) / T_MAX;
const toX = (seconds: number) => X0 + seconds * SCALE;

const TRACK_X = X0 - 16;
const TRACK_W = X1 + 8 - TRACK_X;
const LANE_A = 38;
const LANE_B = 104;
const LANE_H = 34;
const TICK_Y = 6;
const TICK_H = LANE_H - 12;
const AXIS_Y = 168;
const AXIS_SECONDS = [0, 5, 10, 15, 20, 25, 30];

export function DocAiLifecycle({ className }: { className?: string }) {
  return (
    <DiagramFrame
      className={className}
      label="Document job lifecycle"
      meta="One ~30 second job"
      scrollLabel="Document job lifecycle timeline, scrollable"
      icon={["M5 3h9l5 5v13H5z", "M14 3v5h5", "M8 12.5h6", "M8 16.5h4"]}
      caption={
        <>
          The same job, the same ceiling, a different polling schedule. Applying the extract
          back-off to the digitise path is what takes a document from 40 calls to 13.
        </>
      }
    >
      <svg
        viewBox="0 0 720 220"
        role="img"
        aria-labelledby="docai-title docai-desc"
        className={SVG_CLASS}
        style={SVG_FIT}
      >
        <title id="docai-title">Document Intelligence job lifecycle</title>
        <desc id="docai-desc">
          A timeline of one thirty-second Document Intelligence job, drawn as two stacked
          tracks over a shared time axis. The upper track shows back-off polling: ten status
          polls, spaced 0.8 seconds apart at first and growing by a factor of 1.35 to a five
          second ceiling, for twelve calls in total with the submit and the results fetch. The
          lower track shows flat polling at 0.8 seconds: thirty-seven evenly spaced status
          polls, for thirty-nine calls plus one language-model read of the returned text, forty
          in total.
        </desc>

        {/* Five-second gridlines, drawn under the tracks. */}
        {AXIS_SECONDS.map((second) => (
          <line
            key={`grid-${second}`}
            x1={toX(second)}
            y1="30"
            x2={toX(second)}
            y2={AXIS_Y}
            stroke="var(--gv-line)"
            strokeWidth="1"
          />
        ))}

        {/* Lane 1 — back-off */}
        <text
          x="16"
          y="46"
          fill="var(--gv-ink)"
          style={{ fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 500 }}
        >
          back-off
        </text>
        <text
          x="16"
          y="59"
          fill="var(--gv-ink-3)"
          style={{ fontFamily: "var(--font-sans)", fontSize: "9px" }}
        >
          0.8 s · x1.35 · cap 5 s
        </text>
        <rect
          x="16"
          y="64"
          width="64"
          height="17"
          rx="8.5"
          fill="var(--gv-brand-50)"
          stroke="var(--gv-brand-200)"
        />
        <text
          x="48"
          y="76"
          textAnchor="middle"
          fill="var(--gv-brand)"
          style={{ fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: 600 }}
        >
          12 calls
        </text>
        <rect
          x={TRACK_X}
          y={LANE_A}
          width={TRACK_W}
          height={LANE_H}
          rx="10"
          fill="var(--gv-brand-50)"
          stroke="var(--gv-brand-100)"
        />
        {BACKOFF_TIMES.map((t, index) => (
          <rect
            key={`b-${index}`}
            x={toX(t) - 1}
            y={LANE_A + TICK_Y}
            width="2"
            height={TICK_H}
            fill="var(--gv-brand)"
          />
        ))}
        <rect
          x={X0 - 4.5}
          y={LANE_A + TICK_Y}
          width="9"
          height={TICK_H}
          rx="2"
          fill="var(--gv-brand)"
        />
        <rect
          x={toX(31.4) - 4.5}
          y={LANE_A + TICK_Y}
          width="9"
          height={TICK_H}
          rx="2"
          fill="var(--gv-brand)"
        />

        {/* Lane 2 — flat. Amber because this is the path that costs 3x, not
            because a second colour was wanted. */}
        <text
          x="16"
          y="112"
          fill="var(--gv-ink)"
          style={{ fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 500 }}
        >
          flat 0.8 s
        </text>
        <text
          x="16"
          y="125"
          fill="var(--gv-ink-3)"
          style={{ fontFamily: "var(--font-sans)", fontSize: "9px" }}
        >
          the previous digitise path
        </text>
        <rect
          x="16"
          y="130"
          width="64"
          height="17"
          rx="8.5"
          fill="var(--gv-amber-soft)"
          stroke="var(--gv-amber-border)"
        />
        <text
          x="48"
          y="142"
          textAnchor="middle"
          fill="var(--gv-amber)"
          style={{ fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: 600 }}
        >
          40 calls
        </text>
        <rect
          x={TRACK_X}
          y={LANE_B}
          width={TRACK_W}
          height={LANE_H}
          rx="10"
          fill="var(--gv-amber-soft)"
          stroke="var(--gv-amber-border)"
        />
        {FLAT_TIMES.map((t, index) => (
          <rect
            key={`f-${index}`}
            x={toX(t) - 1}
            y={LANE_B + TICK_Y}
            width="2"
            height={TICK_H}
            fill="var(--gv-amber)"
          />
        ))}
        <rect
          x={X0 - 4.5}
          y={LANE_B + TICK_Y}
          width="9"
          height={TICK_H}
          rx="2"
          fill="var(--gv-brand)"
        />
        <rect
          x={toX(29.6) - 4.5}
          y={LANE_B + TICK_Y}
          width="9"
          height={TICK_H}
          rx="2"
          fill="var(--gv-brand)"
        />
        <rect
          x={toX(31.2) - 4.5}
          y={LANE_B + TICK_Y}
          width="9"
          height={TICK_H}
          rx="2"
          fill="var(--gv-ink-3)"
        />

        {/* Time axis */}
        <line
          x1={X0}
          y1={AXIS_Y}
          x2={X1}
          y2={AXIS_Y}
          stroke="var(--gv-line-strong)"
          strokeWidth="1"
        />
        {AXIS_SECONDS.map((second) => (
          <g key={second}>
            <line
              x1={toX(second)}
              y1={AXIS_Y}
              x2={toX(second)}
              y2={AXIS_Y + 5}
              stroke="var(--gv-line-strong)"
            />
            <text
              x={toX(second)}
              y={AXIS_Y + 17}
              textAnchor="middle"
              fill="var(--gv-ink-3)"
              style={{ fontFamily: "var(--font-mono)", fontSize: "9.6px" }}
            >
              {second}s
            </text>
          </g>
        ))}

        {/* Legend */}
        <g>
          <rect x="144" y="200" width="9" height="9" rx="2" fill="var(--gv-brand)" />
          <text
            x="158"
            y="208"
            fill="var(--gv-ink-3)"
            style={{ fontFamily: "var(--font-sans)", fontSize: "9.6px" }}
          >
            submit / results
          </text>
          <rect x="256" y="199" width="2" height="11" fill="var(--gv-brand)" />
          <text
            x="264"
            y="208"
            fill="var(--gv-ink-3)"
            style={{ fontFamily: "var(--font-sans)", fontSize: "9.6px" }}
          >
            status poll
          </text>
          <rect x="338" y="200" width="9" height="9" rx="2" fill="var(--gv-ink-3)" />
          <text
            x="352"
            y="208"
            fill="var(--gv-ink-3)"
            style={{ fontFamily: "var(--font-sans)", fontSize: "9.6px" }}
          >
            extra language-model read (digitise only)
          </text>
        </g>
      </svg>
    </DiagramFrame>
  );
}

// --- Rate governor --------------------------------------------------------

/**
 * Four queues, unnamed on purpose.
 *
 * These used to carry invented company names and precise-looking shares —
 * "Lodestar, 62% of documents". On a public page that reads as a customer list
 * and a set of real figures, and the same invented names appeared elsewhere in
 * the product as example tenants, which made them look corroborated. Neither
 * was true.
 *
 * The diagram is teaching one thing: a noisy tenant does not starve a quiet
 * one. Lettered queues and round shares make that point better, because nobody
 * is tempted to read them as a disclosure.
 */
const QUEUE_TENANTS = [
  { name: "Tenant A", depth: 14, share: "most of the queue" },
  { name: "Tenant B", depth: 4, share: "a moderate share" },
  { name: "Tenant C", depth: 3, share: "a small share" },
  { name: "Tenant D", depth: 2, share: "the quietest" },
];

const GOV_STAGES = [
  { x: 16, label: "Tenant queues" },
  { x: 236, label: "Rotation" },
  { x: 362, label: "Token bucket" },
  { x: 550, label: "Endpoint" },
];

const GOV_MID_Y = 105;

export function GovernorDiagram({ className }: { className?: string }) {
  return (
    <DiagramFrame
      className={className}
      label="Fair-share rate governor"
      meta="10 / min · +1 per 6 s"
      scrollLabel="Rate governor diagram, scrollable"
      icon={["M4 4.5h16l-6.2 7.4v6.8L10.2 17v-5.1z"]}
      caption={
        <>
          Extract and digitise draw on the same bucket. Adding workers does not move the
          ceiling — only the queue discipline decides whose work drains first, and the bucket
          refills continuously so nothing herds at the top of the minute.
        </>
      }
    >
      <svg
        viewBox="0 0 720 186"
        role="img"
        aria-labelledby="gov-title gov-desc"
        className={SVG_CLASS}
        style={SVG_FIT}
      >
        <title id="gov-title">Fair-share rate governor</title>
        <desc id="gov-desc">
          Four tenant queues of differing depth feed a weighted round-robin rotation, which
          releases one waiter per available token from a bucket of ten tokens refilled
          continuously at one sixth of a token per second. Released calls go to the Document
          Intelligence endpoint. The largest tenant holds sixty-two percent of the document
          volume but cannot take more than its turn.
        </desc>

        <defs>
          <marker
            id="gov-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M1 1.6 L9 5 L1 8.4 z" fill="var(--gv-ink-3)" />
          </marker>
          <marker
            id="gov-arrow-brand"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M1 1.6 L9 5 L1 8.4 z" fill="var(--gv-brand-300)" />
          </marker>
          <filter id="gov-lift" x="-14%" y="-16%" width="128%" height="140%">
            <feDropShadow
              dx="0"
              dy="1.5"
              stdDeviation="2"
              floodColor="#14284e"
              floodOpacity="0.1"
            />
          </filter>
        </defs>

        {GOV_STAGES.map((stage) => (
          <text
            key={stage.label}
            x={stage.x}
            y="20"
            fill="var(--gv-ink-3)"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9.2px",
              letterSpacing: "0.08em",
            }}
          >
            {stage.label.toUpperCase()}
          </text>
        ))}

        {QUEUE_TENANTS.map((tenant, row) => {
          const y = 34 + row * 38;
          return (
            <g key={tenant.name}>
              <text
                x="16"
                y={y + 12}
                fill="var(--gv-ink)"
                style={{ fontFamily: "var(--font-mono)", fontSize: "10.5px" }}
              >
                {tenant.name}
              </text>
              <text
                x="16"
                y={y + 24}
                fill="var(--gv-ink-3)"
                style={{ fontFamily: "var(--font-sans)", fontSize: "9.2px" }}
              >
                {tenant.share}
              </text>
              {Array.from({ length: tenant.depth }, (_, i) => (
                <rect
                  key={i}
                  x={104 + i * 7}
                  y={y + 3}
                  width="5"
                  height="13"
                  rx="1"
                  fill={row === 0 ? "var(--gv-amber)" : "var(--gv-brand)"}
                  opacity={0.9}
                />
              ))}
              <line
                x1={206}
                y1={y + 9.5}
                x2={236}
                y2={y + 9.5}
                stroke="var(--gv-ink-3)"
                strokeWidth="1"
                markerEnd="url(#gov-arrow)"
              />
            </g>
          );
        })}

        {/* Round-robin rotor */}
        <circle
          cx="278"
          cy={GOV_MID_Y}
          r="42"
          fill="var(--gv-surface)"
          stroke="var(--gv-brand-200)"
          strokeWidth="1"
          filter="url(#gov-lift)"
        />
        {/* The rotation indicator arcs over the label rather than around it,
            so it never runs through the words. */}
        <path
          d="M254.7 81.7 A33 33 0 0 1 301.3 81.7"
          fill="none"
          stroke="var(--gv-brand-300)"
          strokeWidth="1.4"
          markerEnd="url(#gov-arrow-brand)"
        />
        <text
          x="278"
          y={GOV_MID_Y + 1}
          textAnchor="middle"
          fill="var(--gv-ink)"
          style={{ fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: 500 }}
        >
          weighted
        </text>
        <text
          x="278"
          y={GOV_MID_Y + 13}
          textAnchor="middle"
          fill="var(--gv-ink)"
          style={{ fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: 500 }}
        >
          round-robin
        </text>

        <line
          x1="324"
          y1={GOV_MID_Y}
          x2="356"
          y2={GOV_MID_Y}
          stroke="var(--gv-ink-3)"
          strokeWidth="1"
          markerEnd="url(#gov-arrow)"
        />

        {/* Token bucket */}
        <rect
          x="362"
          y="44"
          width="146"
          height="122"
          rx="10"
          fill="var(--gv-layer-sunken)"
          stroke="var(--gv-line)"
        />
        {Array.from({ length: 10 }, (_, i) => (
          <rect
            key={i}
            x={372 + (i % 5) * 26}
            y={i < 5 ? 56 : 86}
            width="22"
            height="24"
            rx="4"
            fill={i < 4 ? "var(--gv-brand)" : "var(--gv-surface)"}
            stroke={i < 4 ? "var(--gv-brand)" : "var(--gv-brand-200)"}
            strokeWidth="1"
          />
        ))}
        <text
          x="372"
          y="128"
          fill="var(--gv-ink)"
          style={{ fontFamily: "var(--font-mono)", fontSize: "9.6px", fontWeight: 500 }}
        >
          10 / min · +1 per 6 s
        </text>
        <text
          x="372"
          y="141"
          fill="var(--gv-ink-3)"
          style={{ fontFamily: "var(--font-sans)", fontSize: "8.8px" }}
        >
          continuous refill —
        </text>
        <text
          x="372"
          y="152"
          fill="var(--gv-ink-3)"
          style={{ fontFamily: "var(--font-sans)", fontSize: "8.8px" }}
        >
          no top-of-minute herd
        </text>

        <line
          x1="512"
          y1={GOV_MID_Y}
          x2="544"
          y2={GOV_MID_Y}
          stroke="var(--gv-ink-3)"
          strokeWidth="1"
          markerEnd="url(#gov-arrow)"
        />

        {/* Provider endpoint */}
        <rect
          x="550"
          y="69"
          width="156"
          height="72"
          rx="9"
          fill="var(--gv-surface)"
          stroke="var(--gv-brand-200)"
          filter="url(#gov-lift)"
        />
        <rect
          x="562"
          y="79"
          width="22"
          height="22"
          rx="6"
          fill="var(--gv-brand-50)"
          stroke="var(--gv-brand-100)"
        />
        <g
          transform="translate(564 81) scale(0.75)"
          fill="none"
          stroke="var(--gv-brand)"
          strokeWidth="1.4"
          strokeLinecap="square"
          strokeLinejoin="miter"
        >
          <path d="M5 3h9l5 5v13H5z" />
          <path d="M14 3v5h5" />
          <path d="M8 12.5h6" />
          <path d="M8 16.5h4" />
        </g>
        <text
          x="562"
          y="117"
          fill="var(--gv-ink)"
          style={{ fontFamily: "var(--font-sans)", fontSize: "10.5px", fontWeight: 600 }}
        >
          Document intelligence
        </text>
        <text
          x="562"
          y="131"
          fill="var(--gv-ink-3)"
          style={{ fontFamily: "var(--font-mono)", fontSize: "9.4px" }}
        >
          /doc-ai/v1/job/*
        </text>
      </svg>
    </DiagramFrame>
  );
}

// --- MCP handshake --------------------------------------------------------

const MCP_LANES = [
  { label: "Model host", x: 78 },
  { label: "IdP (OIDC)", x: 266 },
  { label: "GravAI MCP", x: 454 },
  { label: "Service layer", x: 642 },
];

/** The lane that is us. Solid brand, so the boundary is obvious. */
const MCP_OWN_LANE = 2;

const MCP_STEPS: { from: number; to: number; label: string; back?: boolean }[] = [
  { from: 0, to: 2, label: "GET /.well-known/oauth-protected-resource" },
  { from: 2, to: 0, label: "resource metadata · audience = GravAI MCP", back: true },
  { from: 0, to: 1, label: "OAuth 2.1 authorisation code + PKCE" },
  { from: 1, to: 0, label: "access token (tenant_id, sub, scopes)", back: true },
  { from: 0, to: 2, label: "initialize · tools/list" },
  { from: 2, to: 0, label: "role-scoped tool set", back: true },
  { from: 0, to: 2, label: "tools/call underwrite_application" },
  { from: 2, to: 3, label: "validate · authorise · audit · invoke" },
  { from: 3, to: 2, label: "{ run_id, status }", back: true },
  { from: 2, to: 0, label: "progress notifications, then result", back: true },
];

const MCP_STEP_TOP = 76;
const MCP_STEP_GAP = 25;

export function McpHandshake({ className }: { className?: string }) {
  return (
    <DiagramFrame
      className={className}
      label="MCP connection handshake"
      meta="10 messages"
      scrollLabel="MCP handshake sequence diagram, scrollable"
      icon={["M9 3v5.5", "M15 3v5.5", "M6 8.5h12v3.2a6 6 0 0 1-12 0z", "M12 17.7V21"]}
      caption={
        <>
          The client token is audience-bound and never forwarded to a downstream system — the
          confused-deputy mitigation, not an optimisation.
        </>
      }
    >
      <svg
        viewBox="0 0 720 328"
        role="img"
        aria-labelledby="mcp-title mcp-desc"
        className={SVG_CLASS}
        style={SVG_FIT}
      >
        <title id="mcp-title">MCP connection handshake</title>
        <desc id="mcp-desc">
          A numbered sequence diagram with four participants: the model host, the identity
          provider, the GravAI MCP server and the service layer. The host discovers protected
          resource metadata, obtains an audience-bound access token carrying tenant id, subject
          and scopes, initialises the session and lists tools, receives a role-scoped tool set,
          then calls an agent tool. The MCP server validates, authorises and audits before
          invoking the service layer, and never forwards the client token downstream. Replies
          are drawn as dashed lines back to the caller.
        </desc>

        <defs>
          <marker
            id="mcp-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M1 1.6 L9 5 L1 8.4 z" fill="var(--gv-brand)" />
          </marker>
          <marker
            id="mcp-arrow-back"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M1 1.6 L9 5 L1 8.4 z" fill="var(--gv-ink-3)" />
          </marker>
        </defs>

        {MCP_LANES.map((lane, index) => {
          const own = index === MCP_OWN_LANE;
          return (
            <g key={lane.label}>
              <rect
                x={lane.x - 70}
                y="16"
                width="140"
                height="32"
                rx="8"
                fill={own ? "var(--gv-brand)" : "var(--gv-surface)"}
                stroke={own ? "var(--gv-brand)" : "var(--gv-brand-200)"}
              />
              <text
                x={lane.x}
                y="36"
                textAnchor="middle"
                fill={own ? "#ffffff" : "var(--gv-ink)"}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "10.5px",
                  fontWeight: own ? 600 : 400,
                }}
              >
                {lane.label}
              </text>
              <line
                x1={lane.x}
                y1="48"
                x2={lane.x}
                y2="318"
                stroke={own ? "var(--gv-brand-200)" : "var(--gv-line)"}
                strokeDasharray="3 4"
              />
            </g>
          );
        })}

        {MCP_STEPS.map((step, index) => {
          const fromX = MCP_LANES[step.from].x;
          const targetX = MCP_LANES[step.to].x;
          const y = MCP_STEP_TOP + index * MCP_STEP_GAP;
          const midX = (fromX + targetX) / 2;
          const direction = targetX > fromX ? 1 : -1;
          const chipWidth = step.label.length * 4.85 + 20;

          return (
            <g key={step.label}>
              <line
                x1={fromX + 8 * direction}
                y1={y}
                x2={targetX}
                y2={y}
                stroke={step.back ? "var(--gv-ink-3)" : "var(--gv-brand)"}
                strokeWidth={step.back ? 1.1 : 1.3}
                strokeDasharray={step.back ? "4 3" : undefined}
                markerEnd={step.back ? "url(#mcp-arrow-back)" : "url(#mcp-arrow)"}
              />
              <rect
                x={midX - chipWidth / 2}
                y={y - 19}
                width={chipWidth}
                height="16"
                rx="8"
                fill="var(--gv-surface)"
                stroke="var(--gv-line-faint)"
              />
              <text
                x={midX}
                y={y - 7.5}
                textAnchor="middle"
                fill="var(--gv-ink-2)"
                style={{ fontFamily: "var(--font-sans)", fontSize: "9.8px" }}
              >
                {step.label}
              </text>
              <circle
                cx={fromX}
                cy={y}
                r="7.5"
                fill="var(--gv-surface)"
                stroke="var(--gv-brand-200)"
              />
              <text
                x={fromX}
                y={y + 3}
                textAnchor="middle"
                fill="var(--gv-brand)"
                style={{ fontFamily: "var(--font-mono)", fontSize: "8.6px", fontWeight: 500 }}
              >
                {index + 1}
              </text>
            </g>
          );
        })}
      </svg>
    </DiagramFrame>
  );
}

// --- Temporal run timeline -----------------------------------------------

interface RunSegment {
  label: string;
  start: number;
  width: number;
  tone: string;
  /** Drawn hatched as well as amber, so the wait is not a hue on its own. */
  wait?: boolean;
}

const RUN_SEGMENTS: RunSegment[] = [
  { label: "classify_documents", start: 0, width: 52, tone: "var(--gv-brand)" },
  { label: "docai.extract x 18 (governed)", start: 54, width: 268, tone: "var(--gv-brand)" },
  { label: "analyse_bank_statement", start: 324, width: 96, tone: "var(--gv-brand)" },
  { label: "bre.evaluate", start: 422, width: 34, tone: "var(--gv-ink-3)" },
  { label: "underwrite_application", start: 458, width: 128, tone: "var(--gv-brand)" },
  {
    label: "await human approval (signal)",
    start: 588,
    width: 226,
    tone: "var(--gv-amber)",
    wait: true,
  },
];

/** The authored layout, rescaled into the 720-unit frame. Ratios unchanged. */
const RUN_X0 = 22;
const RUN_W = 676;
const RUN_SPAN = 814;
const runX = (value: number) => RUN_X0 + (value * RUN_W) / RUN_SPAN;
const runW = (value: number) => (value * RUN_W) / RUN_SPAN;

export function RunTimelineDiagram({ className }: { className?: string }) {
  return (
    <DiagramFrame
      className={className}
      label="A durable agent run"
      meta="elapsed 6m 12s"
      scrollLabel="Durable agent run timeline, scrollable"
      icon={["M2.5 3.5v17", "M5 6.5h10", "M5 12h13", "M5 17.5h7"]}
      caption={
        <>
          The approval wait is a Temporal signal with SLA timers at 24 and 72 hours. A process
          restart during that wait changes nothing.
        </>
      }
    >
      <svg
        viewBox="0 0 720 158"
        role="img"
        aria-labelledby="run-title run-desc"
        className={SVG_CLASS}
        style={SVG_FIT}
      >
        <title id="run-title">A durable agent run</title>
        <desc id="run-desc">
          A horizontal timeline of one credit appraisal run. Document classification runs
          first, then eighteen governed Document Intelligence extractions occupy most of the
          elapsed time, then bank statement analysis, the rules engine call drawn in grey as an
          external system, and the credit appraisal step. The run then waits on a human
          approval signal, drawn as a hatched amber bar, which is where the workflow is durable
          rather than merely asynchronous.
        </desc>

        <defs>
          {/* Hatched, so the waiting segment is not distinguished by hue alone. */}
          <pattern
            id="run-wait"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" fill="var(--gv-amber)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#ffffff" strokeWidth="1.8" opacity="0.5" />
          </pattern>
        </defs>

        <text
          x={RUN_X0}
          y="22"
          fill="var(--gv-ink-3)"
          style={{ fontFamily: "var(--font-mono)", fontSize: "9.6px", letterSpacing: "0.06em" }}
        >
          RUN run_90042 · credit_appraisal · GRV-18301
        </text>
        <text
          x={RUN_X0 + RUN_W}
          y="22"
          textAnchor="end"
          fill="var(--gv-ink-3)"
          style={{ fontFamily: "var(--font-mono)", fontSize: "9.6px" }}
        >
          elapsed 6m 12s
        </text>

        <rect
          x={RUN_X0}
          y="34"
          width={RUN_W}
          height="30"
          rx="8"
          fill="var(--gv-layer-sunken)"
          stroke="var(--gv-line)"
        />

        {RUN_SEGMENTS.map((segment, index) => {
          const x = runX(segment.start);
          const row = index % 3;
          return (
            <g key={segment.label}>
              <rect
                x={x}
                y="37"
                width={runW(segment.width)}
                height="24"
                rx="4"
                fill={segment.wait ? "url(#run-wait)" : segment.tone}
                opacity={segment.wait ? 1 : 0.92}
              />
              <line
                x1={x}
                y1="66"
                x2={x}
                y2={74 + row * 20}
                stroke="var(--gv-line-strong)"
              />
              <text
                x={x + 4}
                y={88 + row * 20}
                fill="var(--gv-ink-2)"
                style={{ fontFamily: "var(--font-mono)", fontSize: "9.6px" }}
              >
                {segment.label}
              </text>
            </g>
          );
        })}

        {/* Legend: every tone also carries its word. */}
        <g>
          <rect x={RUN_X0} y="142" width="9" height="9" rx="2" fill="var(--gv-brand)" />
          <text
            x={RUN_X0 + 14}
            y="150"
            fill="var(--gv-ink-3)"
            style={{ fontFamily: "var(--font-sans)", fontSize: "9.4px" }}
          >
            platform step
          </text>
          <rect x="112" y="142" width="9" height="9" rx="2" fill="var(--gv-ink-3)" />
          <text
            x="126"
            y="150"
            fill="var(--gv-ink-3)"
            style={{ fontFamily: "var(--font-sans)", fontSize: "9.4px" }}
          >
            external system
          </text>
          <rect x="212" y="142" width="9" height="9" rx="2" fill="url(#run-wait)" />
          <text
            x="226"
            y="150"
            fill="var(--gv-ink-3)"
            style={{ fontFamily: "var(--font-sans)", fontSize: "9.4px" }}
          >
            waiting on a person
          </text>
        </g>
      </svg>
    </DiagramFrame>
  );
}
