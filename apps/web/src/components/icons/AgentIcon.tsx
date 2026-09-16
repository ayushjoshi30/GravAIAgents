/**
 * One icon per agent, hand-authored on a 24x24 grid.
 * Stroke only, 1.4 units, square caps — the same drawing rules as the
 * diagrams, so a grid of icons reads as one set rather than as clip art.
 * Decorative: always aria-hidden, since the agent name is always adjacent.
 */

type IconPaths = string[];

const PATHS: Record<string, IconPaths> = {
  doc_intelligence: [
    "M5 3h9l5 5v13H5z",
    "M14 3v5h5",
    "M8 12h5",
    "M8 16h3",
    "M15.5 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
    "M15.3 17.3 17.5 19.5",
  ],
  bank_statement_analytics: [
    "M5 3h9l5 5v13H5z",
    "M14 3v5h5",
    "M8.5 17v-3",
    "M12 17v-6",
    "M15.5 17v-4",
  ],
  credit_appraisal: [
    "M4 6h9",
    "M4 12h6",
    "M4 18h6",
    "M13.5 15.5 16 18l4.5-5",
    "M16 4v5",
    "M13.5 6.5h5",
  ],
  risk_scoring: [
    "M3.5 18a9 9 0 0 1 17 0",
    "M12 18 16.5 11",
    "M12 18h.01",
    "M4.6 13.2l1.9.9",
    "M19.4 13.2l-1.9.9",
    "M12 9V7",
  ],
  // Two parties, one consented pipe: the lock sits on the wire because the
  // consent artefact is what the fetch actually turns on.
  aa_data: [
    "M8 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
    "M21 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
    "M8 12h1.5",
    "M14.5 12h1.5",
    "M9.5 10h5v4h-5z",
    "M10.75 10V9a1.25 1.25 0 0 1 2.5 0v1",
  ],
  kyc_verification: [
    "M3 5h18v14H3z",
    "M9.5 11.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
    "M6 16c0-1.7 1.6-3 3.5-3S13 14.3 13 16",
    "M15.5 9.5h3.5",
    "M15.5 13h3.5",
  ],
  case_allocation: [
    "M4 12h5",
    "M9 12 15 6",
    "M9 12l6 6",
    "M4 9.5v5",
    "M15 3.5h5v5h-5z",
    "M15 15.5h5v5h-5z",
  ],
  smart_mandate: [
    "M4 5h16v16H4z",
    "M4 9.5h16",
    "M8 3v4",
    "M16 3v4",
    "M8.5 15l2.5 2.5 4.5-5",
  ],
  voice_collections: [
    "M6 10v4",
    "M9.5 7v10",
    "M13 9.5v5",
    "M16.5 6v12",
    "M20 9.5v5",
    "M2.5 11.5v1",
  ],
  speech_analytics: [
    "M4 10v4",
    "M7.5 7.5v9",
    "M11 10.5v3",
    "M18.5 13.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z",
    "M17.8 16 20.5 18.7",
  ],
  onboarding_assistant: [
    "M3.5 5h17v11h-10l-4.5 4v-4H3.5z",
    "M8 9.5h8",
    "M8 12.5h5",
  ],
  msme_underwriting: [
    "M3.5 9.5 5.5 4h13l2 5.5",
    "M3.5 9.5h17v11h-17z",
    "M3.5 9.5a2.8 2.8 0 0 0 5.6 0 2.8 2.8 0 0 0 5.6 0 2.8 2.8 0 0 0 5.8 0",
    "M9.5 20.5V14h5v6.5",
  ],
  customer_data_intelligence: [
    "M10 15.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11Z",
    "M15 19.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11Z",
    "M12.5 8.8a5.5 5.5 0 0 0 0 6.4",
  ],
  ops_research: [
    "M4 4v16h16",
    "M7 16l3.5-5 3 2.5L19 7",
    "M15.5 7H19v3.5",
  ],
};

const FALLBACK: IconPaths = ["M4 4h16v16H4z", "M8 9.5h8", "M8 14.5h5"];

export function AgentIcon({
  id,
  size = 22,
  className,
}: {
  id: string;
  size?: number;
  className?: string;
}) {
  const paths = PATHS[id] ?? FALLBACK;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Generic interface icons, drawn to the same rules. */
export type IconName =
  | "shield"
  | "clock"
  | "chain"
  | "database"
  | "bolt"
  | "check"
  | "cross"
  | "warning"
  | "book"
  | "terminal"
  | "globe"
  | "menu"
  | "close"
  | "chevron"
  | "external"
  | "grid"
  | "activity"
  | "inbox"
  | "file"
  | "chart"
  | "settings"
  | "sliders";

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const paths: Record<string, IconPaths> = {
    shield: ["M12 3 20 6v6c0 4.5-3.2 7.6-8 9-4.8-1.4-8-4.5-8-9V6z", "M9 12l2 2 4-4"],
    clock: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 7v5.5l3.5 2"],
    chain: ["M9 15 15 9", "M10.5 6.5 13 4a4 4 0 0 1 6 6l-2.5 2.5", "M13.5 17.5 11 20a4 4 0 0 1-6-6l2.5-2.5"],
    database: [
      "M20 6c0 1.7-3.6 3-8 3S4 7.7 4 6s3.6-3 8-3 8 1.3 8 3Z",
      "M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
      "M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
    ],
    bolt: ["M13 2 4 14h7l-1 8 9-12h-7z"],
    check: ["M4 12.5 9.5 18 20 6"],
    cross: ["M5 5 19 19", "M19 5 5 19"],
    warning: ["M12 3 22 20H2z", "M12 10v5", "M12 17.5h.01"],
    book: ["M4 4h7a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2H4z", "M20 4h-3a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2H20z"],
    terminal: ["M3 4h18v16H3z", "M7 9l3 3-3 3", "M12.5 15h4.5"],
    globe: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M3 12h18", "M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"],
    menu: ["M3 6h18", "M3 12h18", "M3 18h18"],
    close: ["M5 5 19 19", "M19 5 5 19"],
    chevron: ["M8 10l4 4 4-4"],
    external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v6H4V6h6"],
    grid: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
    activity: ["M3 12h4l3-8 4 16 3-8h4"],
    inbox: ["M3 13h5l1.5 3h5L16 13h5", "M5.5 4h13l2.5 9v7H3v-7z"],
    file: ["M6 3h8l5 5v13H6z", "M14 3v5h5", "M9 13h6", "M9 17h4"],
    chart: ["M4 4v16h16", "M8 16v-5", "M12.5 16V8", "M17 16v-3"],
    settings: [
      "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
      "M19.5 13.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H2a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H8a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V8a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z",
    ],
    sliders: ["M4 7h10", "M18 7h2", "M4 12h4", "M12 12h8", "M4 17h10", "M18 17h2", "M15 5v4", "M9 10v4", "M15 15v4"],
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {(paths[name] ?? FALLBACK).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
