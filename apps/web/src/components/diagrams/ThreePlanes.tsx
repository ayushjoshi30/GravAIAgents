/**
 * The three-plane architecture, hand-authored as SVG using brand tokens.
 *
 * Interface plane is thin by design: MCP and REST validate, authorise, audit
 * and call the service layer. No business logic lives there.
 *
 * Drawn in a 720-unit coordinate system and rendered between 700 and 920 CSS
 * pixels, so a 10-unit label lands at roughly 10-13px rather than the 8px an
 * 880-unit drawing produced in a 740px column. It is wider than a phone by
 * design, so the frame carries its own horizontal scroller.
 *
 * Glyphs follow the same drawing rules as `components/icons/AgentIcon.tsx`:
 * a 24x24 grid, 1.4 stroke, square caps, no fill. They are drawn inline here
 * rather than added to that file, which belongs to another surface.
 */

const GLYPHS: Record<string, string[]> = {
  // Interface plane
  mcp: ["M9 3v5.5", "M15 3v5.5", "M6 8.5h12v3.2a6 6 0 0 1-12 0z", "M12 17.7V21"],
  rest: ["M9 5 5.5 12 9 19", "M15 5l3.5 7-3.5 7", "M13.4 7.5 10.6 16.5"],
  console: [
    "M3 4.5h18v15H3z",
    "M3 9h18",
    "M5.8 6.8h1.2",
    "M8.4 6.8h1.2",
    "M7 13h7",
    "M7 16.2h4.5",
  ],
  // Platform plane
  workflow: ["M20.5 12a8.5 8.5 0 1 1-2.9-6.4", "M21 3.2v4.6h-4.6", "M12 7.4V12l3.4 2"],
  governor: ["M4 4.5h16l-6.2 7.4v6.8L10.2 17v-5.1z"],
  postgres: [
    "M4.5 6.5c0-1.9 3.4-3 7.5-3s7.5 1.1 7.5 3-3.4 3-7.5 3-7.5-1.1-7.5-3z",
    "M4.5 6.5v11c0 1.9 3.4 3 7.5 3s7.5-1.1 7.5-3v-11",
    "M19.5 12c0 1.9-3.4 3-7.5 3s-7.5-1.1-7.5-3",
  ],
  ledger: [
    "M5.5 3h13v18l-2.6-1.6-2.2 1.3-2.2-1.3-2.2 1.3L5.5 21z",
    "M9 8h6",
    "M9 11.5h6",
    "M9 15h3.5",
  ],
  audit: [
    "M10.4 13.6a3.8 3.8 0 0 1 0-5.4l2-2a3.8 3.8 0 0 1 5.4 5.4l-1.2 1.2",
    "M13.6 10.4a3.8 3.8 0 0 1 0 5.4l-2 2a3.8 3.8 0 0 1-5.4-5.4l1.2-1.2",
  ],
  // Agent plane
  agents: ["M3.5 3.5h7v7h-7z", "M13.5 3.5h7v7h-7z", "M3.5 13.5h7v7h-7z", "M13.5 13.5h7v7h-7z"],
  adapters: ["M12 3 21 8l-9 5-9-5z", "M3 12.2 12 17.2l9-5", "M3 16.4 12 21.4l9-5"],
  connectors: [
    "M14.2 4.8a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0Z",
    "M7.2 19.2a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0Z",
    "M21.2 19.2a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0Z",
    "M12 7v4",
    "M12 11 6.2 16.8",
    "M12 11l5.8 5.8",
  ],
};

interface PlaneNode {
  title: string;
  /** One or two lines. Two so a long list never runs past the node edge. */
  sub: string[];
  glyph: keyof typeof GLYPHS;
}

interface Plane {
  id: string;
  label: string;
  /** What the plane holds, stated as a count so the fourteen is unmissable. */
  count: string;
  countWidth: number;
  note: string;
  accent: string;
  fill: string;
  stroke: string;
  nodeStroke: string;
  /** Top edge of the band in viewBox units. */
  y: number;
  nodeHeight: number;
  /** Three wide nodes, or five dense ones. */
  wide: boolean;
  nodes: PlaneNode[];
}

const PLANES: Plane[] = [
  {
    id: "interface",
    label: "Interface plane",
    count: "3 surfaces",
    countWidth: 76,
    note: "Three ways in, one service layer",
    accent: "var(--gv-brand-400)",
    fill: "var(--gv-layer-tint)",
    stroke: "var(--gv-line-tint)",
    nodeStroke: "var(--gv-line)",
    y: 12,
    nodeHeight: 74,
    wide: true,
    nodes: [
      {
        title: "apps/mcp",
        sub: ["Remote MCP · Streamable HTTP", "OAuth 2.1"],
        glyph: "mcp",
      },
      { title: "apps/api", sub: ["REST /v1 · OpenAPI · webhooks"], glyph: "rest" },
      { title: "apps/web", sub: ["Marketing · docs · console"], glyph: "console" },
    ],
  },
  {
    id: "platform",
    label: "Platform plane",
    count: "5 services",
    countWidth: 76,
    note: "Durable, governed, tenant-isolated",
    accent: "var(--gv-brand)",
    fill: "var(--gv-layer-tint-deep)",
    stroke: "var(--gv-brand-200)",
    nodeStroke: "var(--gv-brand-200)",
    y: 180,
    nodeHeight: 82,
    wide: false,
    nodes: [
      { title: "Temporal", sub: ["Durable runs"], glyph: "workflow" },
      { title: "Rate governor", sub: ["10 req/min"], glyph: "governor" },
      { title: "PostgreSQL", sub: ["RLS per tenant"], glyph: "postgres" },
      { title: "Cost ledger", sub: ["₹ per call"], glyph: "ledger" },
      { title: "Audit chain", sub: ["Hash-chained"], glyph: "audit" },
    ],
  },
  {
    id: "agent",
    label: "Agent plane",
    count: "14 agents",
    countWidth: 70,
    note: "Prompts, capabilities and systems of record",
    accent: "var(--gv-brand-700)",
    fill: "var(--gv-layer-sunken)",
    stroke: "var(--gv-line)",
    nodeStroke: "var(--gv-line)",
    y: 356,
    nodeHeight: 74,
    wide: true,
    nodes: [
      {
        title: "14 agents",
        sub: ["Prompt · tools · schema · guardrails"],
        glyph: "agents",
      },
      {
        title: "AI adapters",
        sub: ["Language model · documents", "Speech · translation"],
        glyph: "adapters",
      },
      {
        title: "Connectors",
        sub: ["Graviton · BRE · DigiLocker", "Account Aggregator · CPaaS"],
        glyph: "connectors",
      },
    ],
  },
];

/** What each downward call carries. One entry per gap between planes. */
const LINK_LABELS = ["validate · authorise · audit", "durable, resumable, governed"];

const BAND_X = 10;
const BAND_W = 700;
const RAIL_L = 24;
const RAIL_R = 696;
const COUNT_X = 200;
const WIDE_X = [24, 253, 482];
const WIDE_W = 214;
const DENSE_X = [24, 161, 298, 435, 572];
const DENSE_W = 124;
const CENTRE_X = 360;
const SIDE_X = [128, 592];

const bandHeight = (plane: Plane) => 56 + plane.nodeHeight;
const bandBottom = (plane: Plane) => plane.y + bandHeight(plane);

function Glyph({ name, x, y, tone }: { name: string; x: number; y: number; tone: string }) {
  return (
    <g
      transform={`translate(${x} ${y}) scale(0.75)`}
      fill="none"
      stroke={tone}
      strokeWidth="1.4"
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      {(GLYPHS[name] ?? []).map((d) => (
        <path key={d} d={d} />
      ))}
    </g>
  );
}

export function ThreePlanes({ className }: { className?: string }) {
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
                <path d="M12 3 21 8l-9 5-9-5z" />
                <path d="M3 12.2 12 17.2l9-5" />
                <path d="M3 16.4 12 21.4l9-5" />
              </svg>
            </span>
            <span className="truncate text-[13px] font-semibold text-ink">Three planes</span>
          </span>
          <span className="gv-micro">Arrows read downward — each plane calls the one below</span>
        </div>

        <div
          className="gv-scroll-x gv-grid-fine bg-surface"
          role="region"
          aria-label="Three-plane architecture diagram, scrollable"
          tabIndex={0}
        >
          <svg
            viewBox="0 0 720 498"
            role="img"
            aria-labelledby="three-planes-title three-planes-desc"
            className="mx-auto block h-auto w-full"
            style={{ minWidth: 700, maxWidth: 920 }}
          >
            <title id="three-planes-title">GravAI three-plane architecture</title>
            <desc id="three-planes-desc">
              Three stacked planes, drawn one above the other and joined by downward arrows.
              The interface plane on top holds three surfaces: the MCP server on Streamable
              HTTP with OAuth 2.1, the REST v1 API with OpenAPI and webhooks, and the web
              application carrying marketing, docs and the console. It calls down into the
              platform plane — validate, authorise, audit — which holds five services:
              Temporal durable runs, the rate governor capped at ten requests per minute,
              PostgreSQL with row-level security per tenant, the cost ledger priced per call,
              and the hash-chained audit log. That plane drives the agent plane below it —
              durable, resumable, governed — which holds the fourteen agents with their
              prompts, tools, schemas and guardrails, the AI adapters for the language model,
              documents, speech and translation, and the connectors to Graviton, the business
              rules engine, DigiLocker, Account Aggregator and telephony.
            </desc>

            <defs>
              <marker
                id="tp-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="9"
                markerHeight="9"
                markerUnits="userSpaceOnUse"
                orient="auto-start-reverse"
              >
                <path d="M1 1.6 L9 5 L1 8.4 z" fill="var(--gv-brand)" />
              </marker>
              <marker
                id="tp-arrow-soft"
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
              <filter id="tp-lift" x="-12%" y="-20%" width="124%" height="150%">
                <feDropShadow
                  dx="0"
                  dy="1.5"
                  stdDeviation="2"
                  floodColor="#14284e"
                  floodOpacity="0.1"
                />
              </filter>
            </defs>

            {PLANES.map((plane) => {
              const xs = plane.wide ? WIDE_X : DENSE_X;
              const nodeW = plane.wide ? WIDE_W : DENSE_W;
              const nodeY = plane.y + 44;

              return (
                <g key={plane.id}>
                  {/* The plane itself: a tinted ground that gets deeper as the
                      stack descends, so the hierarchy reads before the words. */}
                  <rect
                    x={BAND_X}
                    y={plane.y}
                    width={BAND_W}
                    height={bandHeight(plane)}
                    rx="14"
                    fill={plane.fill}
                    stroke={plane.stroke}
                  />

                  {/* Header: accent chip, plane name, count, role. */}
                  <rect
                    x={RAIL_L}
                    y={plane.y + 12}
                    width="10"
                    height="10"
                    rx="3"
                    fill={plane.accent}
                  />
                  <text
                    x={RAIL_L + 18}
                    y={plane.y + 21}
                    fill="var(--gv-ink)"
                    style={{
                      fontFamily: "var(--font-sans)",
                      fontSize: "10.5px",
                      fontWeight: 600,
                      letterSpacing: "0.12em",
                    }}
                  >
                    {plane.label.toUpperCase()}
                  </text>
                  <rect
                    x={COUNT_X}
                    y={plane.y + 10}
                    width={plane.countWidth}
                    height="15"
                    rx="7.5"
                    fill="var(--gv-surface)"
                    stroke="var(--gv-brand-200)"
                  />
                  <text
                    x={COUNT_X + plane.countWidth / 2}
                    y={plane.y + 20.5}
                    textAnchor="middle"
                    fill="var(--gv-brand)"
                    style={{ fontFamily: "var(--font-mono)", fontSize: "9.2px", fontWeight: 500 }}
                  >
                    {plane.count}
                  </text>
                  <text
                    x={RAIL_R}
                    y={plane.y + 21}
                    textAnchor="end"
                    fill="var(--gv-ink-3)"
                    style={{ fontFamily: "var(--font-sans)", fontSize: "9.8px" }}
                  >
                    {plane.note}
                  </text>
                  <line
                    x1={RAIL_L}
                    y1={plane.y + 32}
                    x2={RAIL_R}
                    y2={plane.y + 32}
                    stroke="var(--gv-line-tint)"
                    strokeWidth="1"
                  />

                  {plane.nodes.map((node, index) => {
                    const x = xs[index];
                    const plate = plane.wide ? 26 : 24;
                    const plateX = x + (plane.wide ? 13 : 12);
                    const plateY = nodeY + 12;
                    const titleX = plane.wide ? x + 49 : x + 12;
                    const titleY = plane.wide ? nodeY + 30 : nodeY + 56;

                    return (
                      <g key={node.title}>
                        <rect
                          x={x}
                          y={nodeY}
                          width={nodeW}
                          height={plane.nodeHeight}
                          rx="9"
                          fill="var(--gv-surface)"
                          stroke={plane.nodeStroke}
                          filter="url(#tp-lift)"
                        />
                        <rect
                          x={plateX}
                          y={plateY}
                          width={plate}
                          height={plate}
                          rx={plane.wide ? 7 : 6}
                          fill="var(--gv-brand-50)"
                          stroke="var(--gv-brand-100)"
                        />
                        <Glyph
                          name={node.glyph}
                          x={plateX + (plate - 18) / 2}
                          y={plateY + (plate - 18) / 2}
                          tone={plane.accent}
                        />
                        <text
                          x={titleX}
                          y={titleY}
                          fill="var(--gv-ink)"
                          style={{
                            fontFamily: "var(--font-sans)",
                            fontSize: plane.wide ? "12.5px" : "11px",
                            fontWeight: 600,
                          }}
                        >
                          {node.title}
                        </text>
                        {node.sub.map((line, lineIndex) => (
                          <text
                            key={line}
                            x={x + 12}
                            y={
                              plane.wide
                                ? nodeY + 52 + lineIndex * 13
                                : nodeY + 70 + lineIndex * 12
                            }
                            fill="var(--gv-ink-3)"
                            style={{
                              fontFamily: "var(--font-sans)",
                              fontSize: plane.wide ? "10px" : "9.6px",
                            }}
                          >
                            {line}
                          </text>
                        ))}
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {/* Interface calls the platform; the platform drives the agents. */}
            {LINK_LABELS.map((label, index) => {
              const top = bandBottom(PLANES[index]) + 4;
              const bottom = PLANES[index + 1].y - 4;
              const mid = (top + bottom) / 2;
              const chipWidth = label.length * 5.6 + 24;

              return (
                <g key={label}>
                  {SIDE_X.map((x) => (
                    <line
                      key={x}
                      x1={x}
                      y1={top}
                      x2={x}
                      y2={bottom}
                      stroke="var(--gv-brand-300)"
                      strokeWidth="1.2"
                      markerEnd="url(#tp-arrow-soft)"
                    />
                  ))}
                  <line
                    x1={CENTRE_X}
                    y1={top}
                    x2={CENTRE_X}
                    y2={bottom}
                    stroke="var(--gv-brand)"
                    strokeWidth="1.5"
                    markerEnd="url(#tp-arrow)"
                  />
                  <rect
                    x="376"
                    y={mid - 11}
                    width={chipWidth}
                    height="22"
                    rx="11"
                    fill="var(--gv-surface)"
                    stroke="var(--gv-brand-200)"
                  />
                  <text
                    x={376 + chipWidth / 2}
                    y={mid + 3.6}
                    textAnchor="middle"
                    fill="var(--gv-ink-2)"
                    style={{ fontFamily: "var(--font-mono)", fontSize: "9.4px" }}
                  >
                    {label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      <figcaption className="gv-micro gv-measure mt-3">
        Every agent is reachable three ways — Graviton over REST, any model host over MCP, and
        the GravAI console — and all three enter through the same service layer.
      </figcaption>
    </figure>
  );
}
