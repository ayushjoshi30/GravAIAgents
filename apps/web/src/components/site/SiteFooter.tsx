import Link from "next/link";
import { GravAIWordmark } from "@/brand/Logo";
import { hueStyle } from "@/components/build/blocks";
import { Icon, type IconName } from "@/components/icons/AgentIcon";
import { Arrow, ButtonLink } from "@/components/ui/Button";

/**
 * The site footer.
 *
 * It carries colour the same way the rest of the site does: a hue stands for a
 * category and always arrives attached to the words that name it. Each of the
 * three link columns has one, so the footer reads as three distinct places to
 * go rather than as nine grey lines.
 *
 * Three hues are deliberately not here. Green, amber and rose mean an outcome
 * everywhere in this product — a run proceeded, a rule flagged risk, a run
 * stopped — and a footer that spent one of them on decoration would weaken
 * every one of them on the screens where a person is deciding credit. That is
 * also why the data-residency line lost the green pip it used to carry: it is
 * a statement of fact about where the data lives, not a check that passed.
 */

const COLUMNS: {
  heading: string;
  hue: string;
  icon: IconName;
  links: { href: string; label: string }[];
}[] = [
  {
    heading: "Product",
    hue: "indigo",
    icon: "grid",
    links: [
      { href: "/platform", label: "Platform" },
      { href: "/agents", label: "Agent catalog" },
      { href: "/how-it-works", label: "The lending journey" },
      { href: "/console", label: "Console" },
    ],
  },
  {
    heading: "Foundations",
    hue: "violet",
    icon: "shield",
    links: [
      { href: "/security", label: "Security and compliance" },
      { href: "/docs/architecture", label: "Architecture" },
      { href: "/docs/compliance", label: "Compliance overview" },
      { href: "/docs/connectors", label: "Connectors" },
    ],
  },
  {
    heading: "Build with it",
    hue: "cyan",
    icon: "terminal",
    links: [
      // /build is not repeated here: it is the filled action in the brand
      // block above, and one destination under two different names in one
      // footer is a worse answer than one name in one place.
      { href: "/docs/quickstart", label: "Quickstart" },
      { href: "/docs/mcp", label: "Connect over MCP" },
      { href: "/docs/rest", label: "REST reference" },
      { href: "/docs/runbooks", label: "Runbooks" },
    ],
  },
];

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="gv-band-tint gv-dots border-t border-line-tint">
      <div className="mx-auto max-w-[1240px] px-5 py-14 sm:px-6 sm:py-16">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.45fr)_repeat(3,minmax(0,1fr))] lg:gap-10">
          {/* Brand presence */}
          <div className="min-w-0 sm:col-span-2 lg:col-span-1">
            <Link href="/" className="inline-block no-underline" aria-label="GravAI home">
              <GravAIWordmark height={28} />
            </Link>
            <span className="gv-rule-brand mt-5 block" aria-hidden="true" />
            <p className="gv-support mt-5 max-w-xs">
              The agent layer for Indian lending. Multi-tenant, governed and auditable end to
              end.
            </p>

            <p className="mt-5 inline-flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 shadow-resting">
              <span className="shrink-0 text-brand" aria-hidden="true">
                <Icon name="globe" size={14} />
              </span>
              <span className="text-[12px] font-medium text-ink-2">
                Data residency: India regions only
              </span>
            </p>

            {/* The same ranking the header uses, so the primary path is the
                same one on the way out of a page as on the way in. */}
            <div className="mt-6 flex flex-wrap gap-2.5">
              <ButtonLink href="/build" variant="primary" size="sm">
                Build your own agent
                <Arrow />
              </ButtonLink>
              <ButtonLink href="/console" size="sm">
                Open the console
              </ButtonLink>
            </div>
          </div>

          {/* Organised columns, each with its own hue on the heading it
              belongs to. The plate is never the only thing distinguishing a
              column — the heading above the links says which is which. */}
          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading} className="min-w-0">
              <p
                style={hueStyle(column.hue)}
                className="mb-4 flex items-center gap-2.5"
              >
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--plate-border)] bg-[var(--plate)] text-[var(--plate-accent)]"
                  aria-hidden="true"
                >
                  <Icon name={column.icon} size={13} />
                </span>
                <span className="gv-eyebrow truncate text-[var(--plate-strong)]">
                  {column.heading}
                </span>
              </p>
              <ul className="space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-[13.5px] text-ink-2 no-underline transition-colors duration-150 ease-gv hover:text-brand"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        {/* The quiet legal line. Not `.gv-micro`: its ink-3 is tuned against
            white and lands at 4.2:1 on the tinted band this footer now sits
            on, so the same two lines are set one step darker. */}
        <div className="mt-14 border-t border-line-tint pt-6">
          <div className="flex flex-col gap-2.5 text-[12.5px] leading-[1.5] text-ink-2 sm:flex-row sm:items-center sm:justify-between">
            <p>
              © {year} GravAI. The agent layer for the Graviton lending platform. Proprietary
              software.
            </p>
            <p>Agents advisory by default · credit decisions require a human</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
