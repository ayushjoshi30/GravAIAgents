import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";

/**
 * The two faces the product serves: Inter for everything readable,
 * IBM Plex Mono for identifiers, hashes and anything a person might copy, where
 * telling 0 from O matters more than warmth.
 *
 * They come through `next/font/google` rather than the stylesheet link the site
 * used to carry. That is a delivery change, not a design one — the faces on
 * screen are identical — but the files are self-hosted at build time, so first
 * paint costs no third-party round trip, there is no swap-in shift, and nothing
 * about a lender's session reaches a font CDN. Behind a tenant login that last
 * point is worth more than it would be on an ordinary marketing site.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/* Inter ships as a variable font, so its weights come for free. Plex Mono does
   not, which is why these two have to be named: 400 for body identifiers, 500
   for the emphasised ones in chips and table keys. */
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://gravai.local"),
  title: {
    default: "GravAI — the agent layer for Indian lending",
    template: "%s · GravAI",
  },
  description:
    "GravAI is the AI agent layer for the Graviton lending platform: fourteen auditable agents for documents, credit, risk, collections and voice, multi-tenant and built for Indian BFSI.",
  applicationName: "GravAI",
  keywords: [
    "lending",
    "BFSI",
    "NBFC",
    "credit appraisal",
    "loan origination",
    "MCP",
    "agent platform",
    "India",
  ],
  openGraph: {
    type: "website",
    siteName: "GravAI",
    title: "GravAI — the agent layer for Indian lending",
    description:
      "Fourteen auditable agents for documents, credit, risk, collections and voice. Multi-tenant, governed, hash-chained audit.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#204887",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The font variables are declared here, on <html>, because the theme layer
    // in globals.css resolves --font-sans and --font-mono against them and has
    // to see them above everything it styles. Self-hosting is also why there is
    // no preconnect: there is no font origin left to warm up.
    <html lang="en-IN" className={`${inter.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
