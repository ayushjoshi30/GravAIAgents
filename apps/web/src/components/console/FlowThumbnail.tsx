/**
 * A saved flow, drawn small.
 *
 * This is the picture beside an agent's name on /console/workflows. It exists
 * so that the list is scannable by shape: someone who has built four agents
 * knows which is which from the silhouette long before they have read four
 * names.
 *
 * It is a pure function of the two arrays it is handed. No fetching, no React
 * Flow instance, no screenshot of the canvas. The list endpoint sends a TRIMMED
 * thumbnail payload — node positions and types, edge source/target pairs, and
 * nothing else — precisely so that a card can be drawn without loading the
 * configuration behind it, and this component is the other half of that
 * bargain. It also means the file needs no `"use client"`: it uses no hook, no
 * browser API and no event, so it renders on the server as happily as inside
 * the console's client tree.
 *
 * COLOUR COMES FROM ONE PLACE. A plate takes its hue from `NODE_BY_TYPE` in the
 * generated catalog — the same lookup the minimap uses and the same one
 * `StudioNode` uses for the canvas — so the KYC agent is the same violet on a
 * card here, as a blob in the minimap, and as a plate on the canvas. That
 * agreement is the only reason the colour is worth drawing at all; a thumbnail
 * palette of its own would be decoration. `hueOf` is duplicated here rather
 * than imported from `StudioNode` for one reason: that module is a client
 * component that imports `@xyflow/react`, and importing a two-line helper from
 * it would pull the whole of React Flow into a route whose job is to render a
 * list of cards. The value read is identical and comes from the same generated
 * table, so the two cannot disagree about a node's colour — only about which
 * bundle pays for the lookup.
 *
 * WHY A HUE IS NEVER SPELLED INTO A CLASS NAME. Tailwind builds its stylesheet
 * by reading the source for whole class names, so `fill-${hue}` compiles to no
 * style at all and fails silently — the mistake this project has made four
 * times. Nothing here builds a class from a value. The hue is interpolated into
 * a custom property NAME inside an SVG `fill`, which the browser resolves at
 * paint time rather than the compiler resolving at build time, exactly as the
 * minimap's `nodeColor` does; and the `var()` fallback covers a hue the
 * stylesheet has never heard of because the catalog was regenerated ahead of
 * the theme.
 *
 * WHAT HAPPENS WHEN A FLOW IS TOO BIG TO DRAW WELL, and why it is not "draw the
 * first N". Two things can go wrong at the extremes: a three-node flow magnified
 * to fill the frame becomes three meaningless slabs, and a forty-node flow
 * shrunk to fit becomes forty specks. Both are answered by clamping, and neither
 * by dropping nodes.
 *
 *   - `maxScale` stops the magnification. A small flow is drawn at about the
 *     scale a zoomed-out canvas would use and sits centred with air around it,
 *     which is the truth of it: it is a small flow.
 *   - `minMarkScale` is a floor under the MARK, not under the fit. Positions go
 *     on shrinking, so the whole flow always stays inside the frame and nothing
 *     is ever cropped; but a plate is never drawn smaller than a few pixels.
 *     Past that floor the plates are larger than their true footprint and dense
 *     clusters start to overlap — which is what the canvas itself looks like
 *     zoomed out, and what the minimap does, so it reads as "this flow is
 *     dense" rather than as a broken drawing. Every plate keeps a hairline of
 *     its own darker hue so that overlapping ones stay countable.
 *
 * Drawing only the first N was the alternative and it is worse. The order the
 * API returns nodes in is a storage order, not a reading order, so "the first
 * twenty" is an arbitrary twenty; and the one thing a thumbnail is for — the
 * SHAPE, one long chain against three parallel arms — is exactly what a
 * truncated drawing gets wrong. A caption reading "20 of 43 shown" would be
 * honest about the truncation and still leave the reader holding a picture of a
 * workflow that does not exist.
 *
 * MOTION. Nothing here moves, so there is nothing for a reduced-motion
 * preference to switch off. If a hover state or an entrance is ever added it
 * belongs behind `prefers-reduced-motion: reduce`, and behind that query the
 * motion has to stop rather than merely slow down.
 */

import type { CSSProperties } from "react";
import { NODE_BY_TYPE } from "@/lib/nodeCatalog";

/**
 * One node of the trimmed thumbnail payload.
 *
 * `x` and `y` are the canvas coordinates the definition was saved with, which
 * in React Flow are a node's TOP-LEFT corner rather than its centre. The fit
 * below depends on that, because it measures the flow as the box the node
 * bodies occupy and not as the box their corners occupy.
 *
 * They are optional and nullable because the API's `ThumbnailNodeOut` declares
 * them that way: a node saved by something other than the canvas may carry no
 * position at all. Accepting the shape the server actually sends, rather than
 * the shape it would be convenient to receive, is what lets the missing case be
 * drawn as the absence it is — see the placeholder below. A caller holding
 * plain numbers satisfies this unchanged.
 */
export interface FlowThumbnailNode {
  id: string;
  type: string;
  x?: number | null;
  y?: number | null;
}

export interface FlowThumbnailEdge {
  source: string;
  target: string;
}

/**
 * How large the drawing will be shown, which is not the same question as how
 * large the SVG is.
 *
 * The viewBox scales to whatever the caller sizes the element to, so one set of
 * proportions would be right at both sizes if legibility were scale-free. It is
 * not: a plate that is 4% of the frame is a clear mark on a 320px card and four
 * device pixels of mush in a 96px table cell. `row` therefore draws relatively
 * bigger marks on a relatively smaller ground, and drops the caption from the
 * empty state, which at that size would be unreadable text pretending to be
 * information.
 */
export type FlowThumbnailDensity = "card" | "row";

export interface FlowThumbnailProps {
  nodes: FlowThumbnailNode[];
  edges: FlowThumbnailEdge[];
  /**
   * How the element is sized, which replaces the default rather than adding to
   * it — see the default's own note below for what it is defending against.
   */
  className?: string;
  density?: FlowThumbnailDensity;
  /**
   * The flow's real size, where the payload is a sample of it rather than the
   * whole thing.
   *
   * The list endpoint sends `node_count` and `edge_count` separately from the
   * thumbnail, and the thumbnail carries a `truncated` flag, which means the
   * two can legitimately disagree: the server may report 43 steps and send the
   * shapes for 12. Left unset these default to the arrays' own lengths, which
   * is right whenever the payload is complete. Set them and the description
   * below states the server's count and says how much of it is drawn, because
   * "8 steps" under a picture of a flow with 43 of them is exactly the kind of
   * count this console is not allowed to print.
   */
  nodeCount?: number;
  edgeCount?: number;
}

/* The studio node's real footprint on the canvas, and the branch diamond's.
   These are the numbers `StudioNode` draws with — a card is `w-[180px]` and
   around 88px tall before its optional summary, and the diamond's polygon spans
   120 by 108 inside its 132-unit SVG. They are copied here as the unit the
   thumbnail scales, so that a plate stands for the space a node actually
   occupies rather than for a point. Getting them slightly wrong costs a little
   padding; leaving them out entirely would make every flow's bounding box too
   small by one node and crop the right-hand column. */
const STUDIO_NODE_W = 180;
const STUDIO_NODE_H = 88;
const BRANCH_W = 120;
const BRANCH_H = 108;

interface DensitySpec {
  /** The viewBox, in its own units. Both densities are 16:9. */
  width: number;
  height: number;
  /** Frame margin, in viewBox units, so that a plate never touches the edge. */
  pad: number;
  /** The most a flow may be magnified; see the note on small flows above. */
  maxScale: number;
  /** The least a mark may be shrunk; see the note on large flows above. */
  minMarkScale: number;
  /** The dotted ground's pitch and dot size, in CSS pixels rather than units. */
  dotPitch: number;
  dotRadius: number;
  edgeWidth: number;
  plateStroke: number;
  plateRadius: number;
  /** False where text would be too small to read, so none is drawn. */
  caption: boolean;
}

const DENSITY: Record<FlowThumbnailDensity, DensitySpec> = {
  card: {
    width: 320,
    height: 180,
    pad: 12,
    maxScale: 0.3,
    minMarkScale: 0.075,
    dotPitch: 8,
    dotRadius: 1,
    edgeWidth: 1,
    plateStroke: 0.75,
    plateRadius: 2.5,
    caption: true,
  },
  row: {
    width: 160,
    height: 90,
    pad: 7,
    maxScale: 0.22,
    minMarkScale: 0.055,
    dotPitch: 6,
    dotRadius: 0.75,
    edgeWidth: 0.8,
    plateStroke: 0.6,
    plateRadius: 2,
    caption: false,
  },
};

/**
 * A node's place in the categorical palette.
 *
 * Slate is a real fallback and not a theoretical one. The console's node
 * library comes from the API, which is deployed separately from this front end
 * and can know types added after `lib/nodeCatalog.ts` was last generated. Such a
 * node still has to draw, and it draws in the palette's neutral: uncoloured
 * rather than wearing some other node's identity. Hashing the type into the
 * palette instead would put a node in a family the engine never placed it in,
 * which is the sort of quiet fiction this product exists to avoid.
 */
function hueOf(type: string): string {
  return NODE_BY_TYPE[type]?.hue ?? "slate";
}

/** The catalog's own flag for a node that sends the run down one of several
 *  branches. A type the catalog does not know is not assumed to branch. */
function isBranching(type: string): boolean {
  return NODE_BY_TYPE[type]?.branching ?? false;
}

/** Two decimals is well under a device pixel at any size this is drawn at, and
 *  it keeps a forty-node path list from being mostly floating-point noise. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A node the drawing can honestly place. Written as a predicate rather than a
 *  bare test so that the coordinates are numbers everywhere below it, instead
 *  of being asserted to be numbers once and hoped about afterwards. */
function isPlaced(node: FlowThumbnailNode): node is FlowThumbnailNode & { x: number; y: number } {
  return Number.isFinite(node.x) && Number.isFinite(node.y);
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function FlowThumbnail({
  nodes,
  edges,
  /* A CALLER WHO DOES NOT SIZE THIS MUST STILL NOT BE ABLE TO PUSH THE PAGE
     SIDEWAYS. The `width` and `height` attributes below are there so that a
     caller's own box wins and the SVG letterboxes into it instead of
     distorting; but an SVG carrying `width="320"` and no CSS is 320 physical
     pixels wide whatever its container is, so used bare — as the empty state on
     /console/workflows uses it, inside a `max-w-[320px]` div that is about
     278px at a 360px viewport — it overflowed and gave the whole console a
     horizontal scrollbar. `max-w-full` caps the width at the container's and
     `h-auto` lets the height follow the viewBox's ratio rather than staying
     pinned at the attribute, so the picture shrinks whole rather than sitting
     in a letterbox of ground. A caller that passes a className replaces this
     because it has taken responsibility for the box: `AgentCard` passes
     `h-full w-full` into a wrapper that is already `aspect-[16/9] w-full`. */
  className = "h-auto max-w-full",
  density = "card",
  nodeCount,
  edgeCount,
}: FlowThumbnailProps) {
  const spec = DENSITY[density];

  /* The canvas paper, as a CSS background rather than an SVG pattern.

     A `<pattern>` would need an id, and a list of twelve cards would then emit
     twelve of them; making the id unique costs a hook and therefore a client
     component, and making it shared leaves duplicate ids in the document. A
     background does the same job with neither problem, and it has a property
     the pattern does not: its pitch is in CSS pixels, so the dots stay the same
     physical texture however large the card is drawn, the way paper does.

     THE GROUND, THE DOTS AND THE CONNECTORS ARE THREE CONSECUTIVE STEPS OF ONE
     NEUTRAL RAMP, in that order, and that ordering is the whole of the recipe.
     The canvas itself draws its dots in `--gv-line` on the sunken plane and its
     edges in `--gv-line-strong`, which at canvas scale are far apart; shrunk to
     a 320-unit frame, a dot and a connector of the same weight become the same
     mark, and a reader counting connections ends up counting texture. Lifting
     the ground to `--gv-surface-2` keeps the dots legible at `--gv-line` while
     leaving `--gv-line-strong` free to mean "this is an edge" and nothing
     else. */
  const ground: CSSProperties = {
    backgroundColor: "var(--gv-surface-2)",
    backgroundImage: `radial-gradient(var(--gv-line) ${spec.dotRadius}px, transparent ${spec.dotRadius}px)`,
    backgroundSize: `${spec.dotPitch}px ${spec.dotPitch}px`,
  };

  /* A node with a missing or non-finite coordinate cannot be placed, and
     placing it at the origin would be an invention — it would put a step
     somewhere its author never put it, and drag the whole bounding box with it.
     It is dropped from the DRAWING only. The description below still counts
     every node the API reported, because that count is the API's statement
     about the flow and this component is not entitled to revise it. */
  const placed = nodes.filter(isPlaced);

  /* The counts come from the server where the server gave them, and from the
     arrays only as a fallback. Two independent things can make the drawing
     smaller than the count — the server truncating the payload, and a node
     arriving without a position — and both end in the same sentence, because
     what a reader needs to know is not which of the two happened but that what
     they are looking at is a part and not the whole. */
  const totalNodes = nodeCount ?? nodes.length;
  const totalEdges = edgeCount ?? edges.length;
  const head = `Flow thumbnail: ${count(totalNodes, "step", "steps")}, ${count(totalEdges, "connection", "connections")}`;

  /* A connection is drawn only where both of its ends are, and the ends go
     missing for the same two reasons the nodes do. Counting them here rather
     than trusting the node clause to imply them covers the case the node clause
     misses entirely: a payload whose nodes are all placed but which carries an
     edge pointing at a node it did not include. Every such edge is dropped
     silently by the loop below, and without this the label would announce nine
     connections over a picture of four with nothing to say which number the
     reader is looking at. */
  const placedIds = new Set(placed.map((node) => node.id));
  const drawnEdges = edges.filter(
    (edge) => placedIds.has(edge.source) && placedIds.has(edge.target),
  ).length;

  /* The partial clause names its units. "43 steps, 47 connections, of which 12
     are drawn here" reads as twelve CONNECTIONS, because "of which" attaches to
     the nearer noun — which is a wrong number stated confidently, the one thing
     this label exists to avoid. */
  const label =
    totalNodes === 0
      ? "Flow thumbnail: no steps yet"
      : placed.length === totalNodes && drawnEdges === totalEdges
        ? head
        : placed.length === 0
          ? nodes.length === 0
            ? `${head}, none of them drawn here`
            : `${head}, none of them drawn here — no saved positions`
          : `${head}; ${count(placed.length, "step", "steps")} and ${count(drawnEdges, "connection", "connections")} are drawn here`;

  /* Nothing to draw, which is three different situations and never a blank box.
     A new agent has no steps in it yet, and a blank rectangle beside its name
     reads as a thumbnail that failed to load rather than as an agent waiting to
     be built. The dashed outline is the empty slot on the canvas where the
     first node will go: honest, and the same picture the studio shows.

     The other two are separated from it, and from each other, because "you have
     not built this yet", "the list did not send a drawing for this one" and "we
     cannot place the steps you built" lead a person to do three completely
     different things next, and collapsing them into one grey box loses the only
     part that tells them which. */
  if (placed.length === 0) {
    const slotW = STUDIO_NODE_W * spec.maxScale;
    const slotH = STUDIO_NODE_H * spec.maxScale;
    const slotY = spec.height / 2 - slotH / 2 - (spec.caption ? 8 : 0);
    return (
      <svg
        viewBox={`0 0 ${spec.width} ${spec.height}`}
        width={spec.width}
        height={spec.height}
        preserveAspectRatio="xMidYMid meet"
        style={ground}
        className={`block ${className}`}
        role="img"
        aria-label={label}
      >
        <rect
          x={round(spec.width / 2 - slotW / 2)}
          y={round(slotY)}
          width={round(slotW)}
          height={round(slotH)}
          rx={spec.plateRadius}
          fill="var(--gv-surface)"
          fillOpacity={0.55}
          stroke="var(--gv-line-strong)"
          strokeWidth={spec.plateStroke * 1.6}
          strokeDasharray="4 3"
        />
        {spec.caption ? (
          <text
            x={spec.width / 2}
            y={round(slotY + slotH + 14)}
            textAnchor="middle"
            fontSize={11}
            fontWeight={500}
            fill="var(--gv-ink-3)"
          >
            {totalNodes === 0
              ? "No steps yet"
              : nodes.length === 0
                ? "No drawing for this flow"
                : "No saved positions"}
          </text>
        ) : null}
      </svg>
    );
  }

  /* The flow's true extent: the box the node BODIES cover, not the box their
     top-left corners cover. Adding one node's width and height to the spread of
     the corners is what keeps the rightmost and bottom-most nodes inside the
     frame, and it makes the fit exact rather than approximate — the room a
     plate needs is folded into the span instead of being guessed at beforehand
     and then reserved twice. */
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of placed) {
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }
  const spanW = maxX - minX + STUDIO_NODE_W;
  const spanH = maxY - minY + STUDIO_NODE_H;

  /* One uniform scale for both axes. Fitting each axis separately would fill
     the frame more completely and would stretch the flow to do it, turning a
     tall narrow graph into a square one — which is a lie about the only thing
     the picture is for. */
  const fit = Math.min((spec.width - 2 * spec.pad) / spanW, (spec.height - 2 * spec.pad) / spanH);
  const scale = Math.min(fit, spec.maxScale);
  const markScale = Math.max(scale, spec.minMarkScale);

  const offsetX = (spec.width - spanW * scale) / 2 - minX * scale;
  const offsetY = (spec.height - spanH * scale) / 2 - minY * scale;

  /* Marks are centred on a node's real centre, so that the legibility floor
     grows a plate symmetrically about the point it stands for rather than
     pushing it off to one side — and so that the growth stays inside the frame
     margin, since half of the largest floored plate is smaller than `pad`. */
  const centres = new Map<string, { x: number; y: number }>();
  for (const node of placed) {
    centres.set(node.id, {
      x: offsetX + (node.x + STUDIO_NODE_W / 2) * scale,
      y: offsetY + (node.y + STUDIO_NODE_H / 2) * scale,
    });
  }

  const plateW = STUDIO_NODE_W * markScale;
  const plateH = STUDIO_NODE_H * markScale;
  const branchW = BRANCH_W * markScale;
  const branchH = BRANCH_H * markScale;

  return (
    <svg
      viewBox={`0 0 ${spec.width} ${spec.height}`}
      width={spec.width}
      height={spec.height}
      preserveAspectRatio="xMidYMid meet"
      style={ground}
      className={`block ${className}`}
      role="img"
      /* The counts are printed as text beside this drawing on the card, so the
         label repeats rather than reveals. It is here anyway, because an
         unlabelled `role="img"` is announced as an image with no name and a
         reader then has to guess whether they have missed something. */
      aria-label={label}
    >
      {/* Connectors first, so that the plates paint over their ends and an edge
          appears to meet a node's edge rather than to run under its middle.
          Drawing centre to centre and letting the plate do the clipping is also
          what keeps an edge running right to left — a loop back to an earlier
          step — from needing a case of its own. */}
      <g stroke="var(--gv-line-strong)" strokeWidth={spec.edgeWidth} fill="none" strokeLinecap="round">
        {edges.map((edge, index) => {
          const from = centres.get(edge.source);
          const to = centres.get(edge.target);
          /* An edge naming a node this payload did not include cannot be drawn
             anywhere truthful, so it is not drawn. The description still counts
             it, because the server counted it. */
          if (!from || !to) return null;
          const mid = (from.x + to.x) / 2;
          return (
            <path
              // Two nodes may legitimately be joined twice — once per branch of
              // a condition — so the pair is not a unique key on its own.
              key={`${edge.source}->${edge.target}:${index}`}
              d={`M${round(from.x)},${round(from.y)} C${round(mid)},${round(from.y)} ${round(mid)},${round(to.y)} ${round(to.x)},${round(to.y)}`}
            />
          );
        })}
      </g>

      {placed.map((node) => {
        const at = centres.get(node.id);
        if (!at) return null;
        const hue = hueOf(node.type);
        /* Interpolated into a custom property NAME, not into a class name: the
           browser resolves this at paint time, so it works where a Tailwind
           class built the same way would silently produce nothing. The fallback
           catches a hue the stylesheet has not caught up with. */
        const fill = `var(--gv-hue-${hue}, var(--gv-hue-slate))`;
        const edge = `var(--gv-hue-${hue}-strong, var(--gv-hue-slate-strong))`;

        /* A branch point is a diamond here because it is a diamond on the
           canvas. Keeping the shape language the same across the two is what
           lets someone recognise their own flow in a 320px picture: the split
           is the landmark they steer by, and a split drawn as one more
           rectangle removes the only feature that made the silhouette
           distinctive. */
        if (isBranching(node.type)) {
          const halfW = branchW / 2;
          const halfH = branchH / 2;
          return (
            <polygon
              key={node.id}
              points={`${round(at.x)},${round(at.y - halfH)} ${round(at.x + halfW)},${round(at.y)} ${round(at.x)},${round(at.y + halfH)} ${round(at.x - halfW)},${round(at.y)}`}
              fill={fill}
              stroke={edge}
              strokeWidth={spec.plateStroke}
            />
          );
        }

        return (
          <rect
            key={node.id}
            x={round(at.x - plateW / 2)}
            y={round(at.y - plateH / 2)}
            width={round(plateW)}
            height={round(plateH)}
            rx={spec.plateRadius}
            fill={fill}
            /* The darker step of the same hue, at a hairline. Its only job is
               the dense case: once the legibility floor makes plates overlap,
               this is what keeps two nodes from reading as one wide one. */
            stroke={edge}
            strokeWidth={spec.plateStroke}
          />
        );
      })}
    </svg>
  );
}
