import Link from "next/link";
import { GravAIWordmark } from "@/brand/Logo";
import { Arrow, ButtonLink } from "@/components/ui/Button";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { href: "/platform", label: "Platform" },
      { href: "/agents", label: "Agent catalog" },
      { href: "/how-it-works", label: "The lending journey" },
      { href: "/console", label: "Console" },
    ],
  },
  {
    heading: "Foundations",
    links: [
      { href: "/security", label: "Security and compliance" },
      { href: "/docs/architecture", label: "Architecture" },
      { href: "/docs/compliance", label: "Compliance overview" },
      { href: "/docs/connectors", label: "Connectors" },
    ],
  },
  {
    heading: "Build with it",
    links: [
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
    <footer className="gv-band-soft border-t border-line">
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
              <span className="gv-pip" aria-hidden="true" />
              <span className="text-[12px] font-medium text-ink-2">
                Data residency: India regions only
              </span>
            </p>

            <div className="mt-6">
              <ButtonLink href="/console" size="sm">
                Open the console
                <Arrow />
              </ButtonLink>
            </div>
          </div>

          {/* Organised columns */}
          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading} className="min-w-0">
              <p className="gv-eyebrow mb-4">{column.heading}</p>
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

        {/* The quiet legal line */}
        <div className="mt-14 border-t border-line pt-6">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="gv-micro">
              © {year} GravAI. The agent layer for the Graviton lending platform. Proprietary
              software.
            </p>
            <p className="gv-micro">
              Agents advisory by default · credit decisions require a human
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
