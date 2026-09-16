"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const DOCS_SECTIONS = [
  {
    heading: "Start here",
    links: [
      { href: "/docs", label: "Overview" },
      { href: "/docs/quickstart", label: "Quickstart" },
      { href: "/docs/architecture", label: "Architecture" },
    ],
  },
  {
    heading: "Reference",
    links: [
      { href: "/docs/agent-reference", label: "Agent reference" },
      { href: "/docs/mcp", label: "Connect over MCP" },
      { href: "/docs/rest", label: "REST reference" },
      { href: "/docs/connectors", label: "Connectors" },
    ],
  },
  {
    heading: "Operating it",
    links: [
      { href: "/docs/compliance", label: "Compliance overview" },
      { href: "/docs/runbooks", label: "Runbooks" },
    ],
  },
];

export function DocsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Documentation" className="lg:sticky lg:top-24 lg:self-start">
      <div className="space-y-6">
        {DOCS_SECTIONS.map((section) => (
          <div key={section.heading}>
            <p className="gv-eyebrow mb-2.5">{section.heading}</p>
            <ul className="space-y-0.5">
              {section.links.map((link) => {
                const active = pathname === link.href;
                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      aria-current={active ? "page" : undefined}
                      className={`block rounded-md px-2.5 py-1.5 text-[13.5px] transition-colors duration-150 ${
                        active
                          ? "bg-brand-50 font-medium text-brand"
                          : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                      }`}
                    >
                      {link.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
