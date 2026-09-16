import type { MetadataRoute } from "next";
import { AGENTS } from "@/lib/agents";

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://gravai.local";

/** The console is excluded: it is authenticated and marked noindex. */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages = [
    "",
    "/platform",
    "/agents",
    "/how-it-works",
    "/security",
    "/docs",
    "/docs/quickstart",
    "/docs/architecture",
    "/docs/agent-reference",
    "/docs/mcp",
    "/docs/rest",
    "/docs/connectors",
    "/docs/compliance",
    "/docs/runbooks",
  ];

  return [
    ...pages.map((path) => ({
      url: `${BASE}${path}`,
      changeFrequency: "weekly" as const,
      priority: path === "" ? 1 : 0.7,
    })),
    ...AGENTS.map((agent) => ({
      url: `${BASE}/agents/${agent.id}`,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}
