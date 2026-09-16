/**
 * The three typefaces of the design system.
 *
 * Loaded through `next/font/google` rather than a stylesheet link so the files
 * are self-hosted at build time: no request to a third party on first paint, no
 * layout shift while a webfont arrives, and nothing about a tenant's session
 * leaking to a font CDN — which matters more here than on an ordinary site,
 * because the console is behind a lender's login.
 *
 * The variables are consumed by `gravai-theme.css`, which is the only place
 * that decides what "sans", "display" and "mono" mean.
 */
import { Archivo_Narrow, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";

/** Body and UI. */
export const instrument = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-instrument",
  display: "swap",
});

/** Display, page titles and every figure. Narrow, so a large number stays compact. */
export const archivo = Archivo_Narrow({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-archivo",
  display: "swap",
});

/** Identifiers, keys and anything a person might copy. */
export const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const fontClassName = `${instrument.variable} ${archivo.variable} ${plexMono.variable}`;
