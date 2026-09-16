"use client";

/**
 * How a step looks on the sketchpad.
 *
 * Two shapes, because the reference design is right that a split should not
 * look like a step: an ordinary step is a card, and a branch point is a
 * diamond whose outgoing edges carry their branch's name.
 *
 * TWO COLOUR CHANNELS, AND ONLY ONE OF THEM IS A CLAIM.
 *
 * The plate carries the node's hue, from the generated catalog. That is
 * identity, not meaning: it says "this is a Risk Agent" faster than the title
 * can be read, and across a canvas of forty cards it is what makes the shape of
 * a workflow legible at a zoom where no text is.
 *
 * The thing that actually matters in a lending workflow — did a language model
 * produce this figure, or did code — is now printed as a word. Every card
 * carries a chip that reads "model" or "code", teal or navy behind it. It is a
 * word first and a colour second deliberately: the previous design said it with
 * a teal or navy plate and nothing else, which meant an underwriter who cannot
 * separate those two hues could not read the one distinction the page exists to
 * make. A chip survives being printed in grayscale.
 *
 * The Human Approval card no longer gets the solid navy treatment the console
 * gives a gate, because navy on this page means "code decided" and a human gate
 * is the one step where a person does. It takes its catalog hue like every
 * other card, and the word "human gate" under its title is what marks it out.
 *
 * Every card is operable without a pointer. The title is a real input, and the
 * connect and remove controls are real buttons in the tab order, so a visitor
 * who cannot drag can still name a step, join two steps and take one out. The
 * drag affordances are the addition for people who have a mouse, not the other
 * way round.
 */

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AgentIcon, Icon } from "@/components/icons/AgentIcon";
import { blockFor, hueStyle } from "@/components/build/blocks";
import { useBuilder } from "@/components/build/builder-context";

export interface BuildNodeData {
  /** A registry node type: `input`, `condition`, `agent.risk_scoring`… */
  blockType: string;
  /** The visitor's own name for this step. */
  name: string;
  [key: string]: unknown;
}

/** Handles are sized and coloured by `.gv-handle` in gravai-theme.css, which
 *  the console's canvas already uses. Position is the only thing set here. */
const HANDLE_BASE = { width: 12, height: 12 } as const;

/**
 * The plate, in the node's own hue.
 *
 * One constant class string, with everything that varies coming through the
 * custom properties `hueStyle` sets on the same element — see the note there
 * for why a lookup of literal Tailwind classes is the wrong shape for this.
 */
const PLATE =
  "mt-[1px] inline-flex h-8 w-8 flex-none items-center justify-center rounded-[7px] border border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]";

/**
 * Model or code, said in a word.
 *
 * The two hues here are the only ones on this page that are a claim rather than
 * a label, so they are fixed rather than taken from the node's `hue`: teal means
 * a language model reasoned inside this step, navy means code reached a fixed
 * answer. The text is what carries it; the colour only agrees with the text.
 */
function ReasoningChip({ usesLlm }: { usesLlm: boolean }) {
  const tone = usesLlm
    ? "border-[var(--gv-hue-teal-border)] bg-[var(--gv-hue-teal-soft)] text-[var(--gv-hue-teal-strong)]"
    : "border-[var(--gv-hue-navy-border)] bg-[var(--gv-hue-navy-soft)] text-[var(--gv-hue-navy-strong)]";
  return (
    <span
      className={`inline-flex flex-none items-center rounded-full border px-1.5 py-px text-[9.5px] font-semibold tracking-[0.06em] uppercase ${tone}`}
    >
      {usesLlm ? "model" : "code"}
      {/* The chip is two words wide and the distinction is the point of the
          page, so the ears get the whole sentence rather than the abbreviation. */}
      <span className="sr-only">
        {usesLlm ? " — a language model reasons in this step" : " — code decides this step"}
      </span>
    </span>
  );
}

/** The quiet controls in a card's footer, and the loud one during a link. */
function ControlButton({
  children,
  onClick,
  label,
  emphasis = "quiet",
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  emphasis?: "quiet" | "loud";
}) {
  const tone =
    emphasis === "loud"
      ? "border-navy bg-navy text-white"
      : "border-line bg-surface text-ink-2 hover:border-navy hover:text-navy";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      /* `nodrag`/`nopan` stop React Flow treating a press on a control as the
         start of a drag or a pan, which would otherwise swallow the click. */
      className={`nodrag nopan inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-[3px] text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy ${tone}`}
    >
      {children}
    </button>
  );
}

function StepNodeImpl({ id, data, selected }: NodeProps) {
  // React Flow types node data as an open record, so the shape is narrowed here
  // rather than in the signature: a component typed on narrower props is no
  // longer assignable to the `NodeTypes` map.
  const node = data as BuildNodeData;
  const block = blockFor(node.blockType);
  const builder = useBuilder();

  const usesLlm = block?.usesLlm ?? false;
  const canBeSource = node.blockType !== "output";
  const canBeTarget = node.blockType !== "input";

  const linking = builder.linking;
  const isLinkSource = linking?.source === id;

  /* Slate for a type the catalog does not know. It is the palette's neutral, so
     an unrecognised node reads as uncoloured rather than borrowing some other
     node's identity — and the card says so in words underneath either way. */
  const hue = block?.hue ?? "slate";

  return (
    <div
      className={`gv-node w-[248px] box-border border-l-[3px] border-l-[var(--plate-accent)] ${
        selected ? "gv-node-selected" : ""
      } ${isLinkSource ? "ring-2 ring-navy ring-offset-1" : ""}`}
      /* The hue is set once here, at the top of the card, so the plate, the
         spine and anything else that wants it read the same four properties
         rather than each recomputing them. */
      style={hueStyle(hue)}
      data-node-type={node.blockType}
    >
      {canBeTarget ? (
        <Handle
          type="target"
          position={Position.Left}
          className="gv-handle"
          style={{ ...HANDLE_BASE, left: -7 }}
        />
      ) : null}

      <div className="flex items-start gap-2.5 px-3 pt-2.5">
        <span className={PLATE} aria-hidden="true">
          {block?.agentId ? (
            <AgentIcon id={block.agentId} size={17} />
          ) : block?.icon ? (
            <Icon name={block.icon} size={16} />
          ) : (
            <Icon name="grid" size={16} />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <input
            value={node.name}
            onChange={(event) => builder.renameNode(id, event.target.value)}
            aria-label={`Name of this ${block?.label ?? node.blockType} step`}
            className="nodrag nopan w-full rounded-[3px] border border-transparent bg-transparent px-1 py-px text-[13.5px] font-semibold text-ink hover:border-line focus:border-navy focus:bg-surface focus:outline-none"
          />
          {/* The TYPE line, beside the model/code chip. Small and quiet on
              purpose: it answers "what kind of thing is this" without competing
              with the name the visitor chose. */}
          <span className="mt-px flex items-center gap-1.5 px-1">
            <span className="min-w-0 truncate text-[10px] font-medium tracking-[0.09em] text-ink-3 uppercase">
              {block?.kind ?? "unrecognised"}
            </span>
            {block ? <ReasoningChip usesLlm={usesLlm} /> : null}
          </span>
        </span>
      </div>

      <p className="px-3 pt-1.5 text-[11.5px] leading-[1.45] text-ink-2">
        {block
          ? block.summary
          : "This step's type is not in the library this page was built from, so there is nothing truthful to say about what it does."}
      </p>

      {block?.caveat ? (
        <p className="mx-3 mt-2 rounded-[4px] border border-amber-border bg-amber-soft px-2 py-1.5 text-[10.5px] leading-[1.4] text-amber-strong">
          {block.caveat}
        </p>
      ) : null}

      {block?.sketchNote ? (
        <p className="mx-3 mt-2 border-l-2 border-line-strong pl-2 text-[10.5px] leading-[1.4] text-ink-3">
          {block.sketchNote}
        </p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
        {linking && !isLinkSource ? (
          canBeTarget ? (
            <ControlButton
              emphasis="loud"
              label={`Connect to ${node.name || block?.label || id}`}
              onClick={() => builder.completeLink(id)}
            >
              Connect here
            </ControlButton>
          ) : (
            <span className="text-[10.5px] text-ink-3">Input has nothing coming in</span>
          )
        ) : isLinkSource ? (
          <ControlButton label="Cancel this connection" onClick={builder.cancelLink}>
            Cancel
          </ControlButton>
        ) : canBeSource ? (
          <ControlButton
            label={`Connect from ${node.name || block?.label || id}`}
            onClick={() => builder.startLink(id, "")}
          >
            Connect →
          </ControlButton>
        ) : (
          <span className="text-[10.5px] text-ink-3">Output ends the run</span>
        )}

        <span className="flex-1" />

        <ControlButton label={`Remove ${node.name || block?.label || id}`} onClick={() => builder.removeNode(id)}>
          Remove
        </ControlButton>
      </div>

      {canBeSource ? (
        <Handle
          type="source"
          position={Position.Right}
          className="gv-handle"
          style={{ ...HANDLE_BASE, right: -7 }}
        />
      ) : null}
    </div>
  );
}

/**
 * A branch point.
 *
 * The diamond is drawn as an SVG rather than a rotated box so the label under
 * it stays upright and legible. Each branch gets its own handle and its own
 * button, which is what makes a branch connectable without a pointer: you pick
 * the branch first and the target second, rather than drawing an edge and then
 * being asked which outcome it followed.
 */
function BranchNodeImpl({ id, data, selected }: NodeProps) {
  const node = data as BuildNodeData;
  const block = blockFor(node.blockType);
  const builder = useBuilder();
  const branches = block?.branches ?? [];

  const linking = builder.linking;
  const isLinkSource = linking?.source === id;

  /* The diamond's own points, in node coordinates, minus half a handle so the
     handle sits centred on the point rather than hanging off it. The right
     point takes the first branch and the bottom point the second, which is why
     a two-way split reads as a split; a third would stack down the right edge,
     and no registry node has one today. */
  const handlePosition = (index: number) =>
    index === 0
      ? { left: 120, top: 54 }
      : index === 1
        ? { left: 60, top: 108 }
        : { left: 120, top: 54 + index * 20 };

  return (
    <div
      className="w-[132px]"
      /* Same four properties as a card, so the diamond is coloured by the same
         declaration and cannot drift to its own idea of indigo. The SVG below
         reads them through `fill`/`stroke`, which resolve custom properties. */
      style={hueStyle(block?.hue ?? "slate")}
      data-node-type={node.blockType}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="gv-handle"
        style={{ ...HANDLE_BASE, left: 0, top: 54, right: "auto", bottom: "auto", transform: "none" }}
      />

      <div className="relative h-[120px] w-[132px]">
        <svg
          width="132"
          height="120"
          viewBox="0 0 132 120"
          className="block"
          role="img"
          /* The shape itself is the information a sighted reader gets and a
             screen reader would not: this step splits the run. The name and the
             word "branch" are already in the text beside it, and the dashed-edge
             rule is carried by each edge's own label, so the description says
             only what the drawing adds. */
          aria-label={`Branch point${
            branches.length > 0 ? `, splitting into ${branches.join(" and ")}` : ""
          }`}
        >
          <polygon
            points="66,6 126,60 66,114 6,60"
            fill="var(--plate)"
            /* Selection is a thicker, darker edge as well as a colour change,
               so it is still visible to someone who cannot tell the base hue
               from its own lighter border. */
            stroke={selected || isLinkSource ? "var(--plate-accent)" : "var(--plate-border)"}
            strokeWidth={selected || isLinkSource ? 3 : 2}
          />
        </svg>
        <span
          className="pointer-events-none absolute top-[48px] left-[54px] text-[var(--plate-accent)]"
          aria-hidden="true"
        >
          <Icon name="activity" size={24} />
        </span>
      </div>

      <input
        value={node.name}
        onChange={(event) => builder.renameNode(id, event.target.value)}
        aria-label={`Name of this ${block?.label ?? node.blockType} branch`}
        className="nodrag nopan mt-1 w-full rounded-[3px] border border-transparent bg-transparent px-1 py-px text-center text-[12px] font-semibold text-ink hover:border-line focus:border-navy focus:bg-surface focus:outline-none"
      />
      <p className="flex items-center justify-center gap-1.5 text-center text-[10px] font-medium tracking-[0.09em] text-ink-3 uppercase">
        <span>{block?.kind ?? "unrecognised"}</span>
        {/* A Condition and a Router are both code with a fixed answer, but the
            diamond says nothing about that on its own, so it carries the same
            chip every card does rather than being the one shape you have to
            already know the rule for. */}
        {block ? <ReasoningChip usesLlm={block.usesLlm} /> : null}
      </p>
      {/* The registry's own sentence, on a diamond exactly as it is on a card.
          A branch point is a step a visitor has to understand before they place
          it, and the rail row beside it shows only the label — so if the
          description is not printed here it is printed nowhere a sighted
          visitor reads it. It is `summary` from the generated catalog, whole:
          a shorter line written to fit this narrow shape would be this page's
          own description of the platform rather than the platform's.

          There is no "not recognised" fallback here, unlike the card: the
          canvas only draws a diamond when the catalog says the node branches,
          so a type this file cannot look up is always drawn as a card and it is
          the card that has to explain itself. */}
      {block ? (
        <p className="mt-1 text-center text-[10.5px] leading-[1.35] text-ink-2">{block.summary}</p>
      ) : null}

      {/* A caveat belongs to the node, not to the shape it is drawn as. No
          branching node in today's registry carries one, but dropping it for
          one of the two shapes is how a limitation the engine states quietly
          stops being stated. Amber here is the reserved risk hue doing its own
          job, which is what the caveat is. */}
      {block?.caveat ? (
        <p className="mt-1 rounded-[4px] border border-amber-border bg-amber-soft px-1.5 py-1 text-center text-[10px] leading-[1.35] text-amber-strong">
          {block.caveat}
        </p>
      ) : null}

      {block?.sketchNote ? (
        <p className="mt-1 text-center text-[10px] leading-[1.35] text-ink-3">{block.sketchNote}</p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap justify-center gap-1">
        {linking && !isLinkSource ? (
          <ControlButton
            emphasis="loud"
            label={`Connect to ${node.name || block?.label || id}`}
            onClick={() => builder.completeLink(id)}
          >
            Connect here
          </ControlButton>
        ) : isLinkSource ? (
          <ControlButton label="Cancel this connection" onClick={builder.cancelLink}>
            Cancel
          </ControlButton>
        ) : (
          branches.map((branch) => (
            <ControlButton
              key={branch}
              label={`Connect the ${branch} branch of ${node.name || block?.label || id}`}
              onClick={() => builder.startLink(id, branch)}
            >
              {branch} →
            </ControlButton>
          ))
        )}
        <ControlButton label={`Remove ${node.name || block?.label || id}`} onClick={() => builder.removeNode(id)}>
          Remove
        </ControlButton>
      </div>

      {branches.map((branch, index) => (
        <Handle
          key={branch}
          id={branch}
          type="source"
          position={index === 1 ? Position.Bottom : Position.Right}
          className="gv-handle"
          style={{
            ...HANDLE_BASE,
            ...handlePosition(index),
            right: "auto",
            bottom: "auto",
            transform: "none",
          }}
        />
      ))}
    </div>
  );
}

export const StepNode = memo(StepNodeImpl);
export const BranchNode = memo(BranchNodeImpl);

export const BUILD_NODE_TYPES = { step: StepNode, branch: BranchNode };
