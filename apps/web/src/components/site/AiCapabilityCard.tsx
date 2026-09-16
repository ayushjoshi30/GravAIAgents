/**
 * The AI capabilities an agent consumes.
 *
 * Each card carries an icon and the unit the capability is billed in, because
 * "what does this agent spend" is the question the section asks and a bare
 * label does not answer it. The icons are inline SVG — the product ships no
 * raster assets, so nothing here can 404.
 *
 * Capabilities are matched on substring rather than an exact map: the agent
 * catalogue phrases them differently per agent ("Language model (rubric
 * scoring)", "Language model (fast tier)"), and an exact lookup would silently
 * fall through to a blank card the first time someone added a new wording.
 *
 * Each of the six categories is drawn in its own hue from the categorical
 * palette, so a list of four capabilities reads as four different things spent
 * rather than as four identical cards. The hue never says anything the card
 * does not also print: the title names the capability and the last line names
 * the unit it is billed in, both in words, and the colour only agrees with
 * them.
 */

import { hueStyle } from "@/components/build/blocks";

type Category = "document" | "model" | "voice" | "stt" | "tts" | "translate";

type Meta = {
  category: Category;
  billing: string;
  hue: string;
  icon: React.ReactNode;
};

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const ICONS: Record<Category, React.ReactNode> = {
  document: (
    <>
      <path d="M5 2.75h6.5L15.25 6.5v10.75a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3.75a1 1 0 0 1 1-1Z" {...stroke} />
      <path d="M11.25 2.9V6.75h3.85M6.75 10.5h6.5M6.75 13.5h4.5" {...stroke} />
    </>
  ),
  model: (
    <>
      <circle cx="10" cy="10" r="2.25" {...stroke} />
      <path d="M10 2.75v3M10 14.25v3M17.25 10h-3M5.75 10h-3M15.13 4.87l-2.12 2.12M6.99 13.01l-2.12 2.12M15.13 15.13l-2.12-2.12M6.99 6.99 4.87 4.87" {...stroke} />
    </>
  ),
  voice: (
    <>
      <rect x="7.75" y="2.75" width="4.5" height="8.5" rx="2.25" {...stroke} />
      <path d="M4.75 9.5a5.25 5.25 0 0 0 10.5 0M10 14.75v2.5" {...stroke} />
    </>
  ),
  stt: (
    <>
      <path d="M3 10.5v-1M6 13v-6M9 15.5v-11M12 12v-4M15 10.5v-1" {...stroke} />
      <path d="M17.25 8.25v3.5" {...stroke} />
    </>
  ),
  tts: (
    <>
      <path d="M4.75 7.75h2.5l3.5-3v10.5l-3.5-3h-2.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1Z" {...stroke} />
      <path d="M13.5 7.75a3.25 3.25 0 0 1 0 4.5M15.75 5.5a6.5 6.5 0 0 1 0 9" {...stroke} />
    </>
  ),
  translate: (
    <>
      <path d="M2.75 4.75h7.5M6.5 2.75v2M8.25 4.75c0 3.5-2.5 6.25-5.5 7.5" {...stroke} />
      <path d="M4.75 8.5c1.25 1.75 3 3 5 3.75M10.5 17.25l3.5-8.5 3.5 8.5M11.9 14.25h4.2" {...stroke} />
    </>
  ),
};

const BILLING: Record<Category, string> = {
  document: "Billed per page",
  model: "Billed per 1,000 tokens, input and output separately",
  voice: "Billed per second of audio and per 1,000 characters",
  stt: "Billed per second of audio",
  tts: "Billed per 1,000 characters",
  translate: "Billed per 1,000 characters",
};

/**
 * A hue per category, from the twelve-family palette.
 *
 * `model` IS TEAL ON PURPOSE, AND NOTHING ELSE HERE IS. Across this product
 * teal means a language model is reasoning and navy means deterministic code
 * reached a fixed answer — the distinction the whole platform is built to make
 * auditable. The `model` card is a language model, so teal here is the claim
 * being restated rather than decoration borrowing it.
 *
 * The speech and translation capabilities are models too, but they are not a
 * language model reasoning about a case, so they take ordinary categorical
 * hues and leave teal meaning exactly one thing. None of the six is green,
 * amber or rose: spending a capability is not an outcome, and those three are
 * how this site says a run passed, carried risk or stopped.
 */
const HUE: Record<Category, string> = {
  document: "indigo",
  model: "teal",
  voice: "orange",
  stt: "pink",
  tts: "violet",
  translate: "cyan",
};

/**
 * Order matters. The combined voice capability mentions both "speech to text"
 * and "text to speech", so it has to be tested before either of them.
 */
function classify(capability: string): Category {
  const value = capability.toLowerCase();
  if (value.includes("speech to text") && value.includes("text to speech")) return "voice";
  if (value.includes("document intelligence")) return "document";
  if (value.includes("speech to text")) return "stt";
  if (value.includes("text to speech")) return "tts";
  if (value.includes("translation") || value.includes("translate")) return "translate";
  return "model";
}

function meta(capability: string): Meta {
  const category = classify(capability);
  return { category, billing: BILLING[category], hue: HUE[category], icon: ICONS[category] };
}

/**
 * Splits "Language model (fast tier, classification)" into a heading and the
 * qualifier, so the card has a scannable title rather than one long line.
 */
function split(capability: string): { title: string; qualifier: string | null } {
  const match = capability.match(/^(.*?)\s*\((.*)\)\s*$/);
  if (!match) return { title: capability, qualifier: null };
  return { title: match[1].trim(), qualifier: match[2].trim() };
}

export function AiCapabilityCard({ capability }: { capability: string }) {
  const { icon, billing, hue } = meta(capability);
  const { title, qualifier } = split(capability);

  return (
    /* The category is decided at runtime from the capability's wording, so the
       hue cannot be a class name: Tailwind reads the source for complete class
       names at build time and would emit nothing for one assembled here. The
       class names stay constant and `hueStyle` varies the values underneath
       them — the same helper the studio's nodes use. */
    <li className="gv-card flex gap-3 border-[var(--plate-border)] p-4" style={hueStyle(hue)}>
      <span
        aria-hidden="true"
        className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" focusable="false">
          {icon}
        </svg>
      </span>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium leading-snug text-ink">
          {title}
        </span>
        {qualifier ? (
          <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-2">
            {qualifier}
          </span>
        ) : null}
        {/* The billing line keeps its muted ink. It is the one fact on the card
            that is the same kind of fact whatever the capability is, and
            colouring it per category would imply a difference that is not
            there. */}
        <span className="mt-1.5 block font-mono text-[11px] uppercase tracking-wide text-ink-3">
          {billing}
        </span>
      </span>
    </li>
  );
}

export function AiCapabilityList({ capabilities }: { capabilities: string[] }) {
  // Some agents are pure arithmetic and connector calls — the Account
  // Aggregator agent spends nothing at all. Saying so is worth more than a
  // headed section with nothing under it, which is what an empty list gave.
  if (capabilities.length === 0) {
    return (
      <div className="gv-card self-start p-4">
        <p className="text-[13.5px] font-medium leading-snug text-ink">
          None — this agent makes no AI calls
        </p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">
          Everything it produces comes from connector responses and arithmetic in
          code, so a run costs nothing against the rate card.
        </p>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-wide text-ink-3">
          Not billed
        </p>
      </div>
    );
  }

  return (
    // self-start stops the list stretching to the height of the heading column
    // beside it, which is what left each card mostly empty.
    <ul className="grid content-start gap-3 self-start sm:grid-cols-2">
      {capabilities.map((capability) => (
        <AiCapabilityCard key={capability} capability={capability} />
      ))}
    </ul>
  );
}
