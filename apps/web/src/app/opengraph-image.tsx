import { ImageResponse } from "next/og";

/**
 * OpenGraph card, rendered at build time from brand tokens.
 * No external asset is fetched and no image file is committed.
 */

export const alt =
  "GravAI — the agent layer for Indian lending. Fourteen auditable agents, a ten requests per minute document intelligence governor, and a hash-chained audit log.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BRAND = "#204887";
const INK = "#101828";
const INK_2 = "#475467";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#ffffff",
          padding: "64px 72px",
          color: INK,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              display: "flex",
              width: 44,
              height: 44,
              borderRadius: 10,
              background: BRAND,
              alignItems: "center",
              justifyContent: "center",
              color: "#ffffff",
              fontSize: 26,
              fontWeight: 700,
            }}
          >
            G
          </div>
          <div style={{ display: "flex", fontSize: 30, fontWeight: 700, letterSpacing: "-0.5px" }}>
            <span style={{ color: BRAND }}>Grav</span>
            <span style={{ color: "#0C6B5F" }}>AI</span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 62,
              fontWeight: 700,
              lineHeight: 1.1,
              letterSpacing: "-2px",
              maxWidth: 980,
              display: "flex",
              flexWrap: "wrap",
            }}
          >
            The agent layer for Indian lending.
          </div>
          <div
            style={{
              fontSize: 62,
              fontWeight: 700,
              color: BRAND,
              letterSpacing: "-2px",
              marginTop: 4,
            }}
          >
            Built on the platform you already run.
          </div>
        </div>

        <div style={{ display: "flex", gap: 48, color: INK_2, fontSize: 19 }}>
          {[
            ["14 agents", "documents to collections"],
            ["12 vs 40", "API calls per document"],
            ["10 req/min", "governed, fairly shared"],
            ["Hash-chained", "append-only audit"],
          ].map(([figure, caption]) => (
            <div
              key={figure}
              style={{
                display: "flex",
                flexDirection: "column",
                borderTop: `3px solid ${BRAND}`,
                paddingTop: 12,
              }}
            >
              <span style={{ color: INK, fontSize: 28, fontWeight: 600 }}>{figure}</span>
              <span style={{ marginTop: 2 }}>{caption}</span>
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
