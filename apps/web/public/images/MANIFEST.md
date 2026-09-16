# Image and graphic manifest

Every visual asset used by `apps/web`, with its purpose, how it was produced and its
licence. There is no stock photography, no scraped imagery and no model-generated imagery
anywhere in this application. The rule is that an asset either appears in this manifest
with a licence, or it is not on the site.

**Licence key**

- **Proprietary — GravAI / Graviton** · the brand marks, derived from the Graviton
  wordmark's own outlines. Owned with the rest of the repository under
  [`LICENSE`](../../../../LICENSE).
- **Proprietary — GravAI** · diagrams and icons authored for this project.
- **SIL Open Font License 1.1** · the two webfont families, loaded from Google Fonts at
  runtime and not redistributed from this repository.

---

## Brand marks — `public/brand/`

Copied from `<repo>/brand/`. See `brand/README.md` for the construction, the clear-space
rule and the minimum sizes. These are outlines, not text: do not re-kern, re-colour or
re-set the name in a typeface.

| File | Purpose | Producer | Licence | Alt text |
|---|---|---|---|---|
| `gravai-wordmark.svg` | Default wordmark, light grounds. `GRAV` in Graviton blue `#204887`, `AI` in teal `#0C6B5F`. | Derived from the Graviton wordmark | Proprietary — GravAI / Graviton | "GravAI" |
| `gravai-wordmark-reverse.svg` | Wordmark for dark grounds. The teal is brightened to `#41B8A6` rather than inverted. Not used in this light-only app; kept for decks and email. | As above | As above | "GravAI" |
| `gravai-wordmark-mono.svg` | One-colour wordmark inheriting `currentColor`. For print, email and anywhere the two-tone split cannot be reproduced. | As above | As above | "GravAI" |
| `gravai-mark.svg` | The `G` monogram, inheriting `currentColor`. For use below the 90px minimum wordmark width. | As above | As above | "GravAI" |
| `favicon.svg` | Square app icon: blue tile, white `G`, teal rule. Reads down to 16px where a two-tone wordmark would turn to mud. | As above | As above | Decorative; the document title carries the name |

`src/brand/Logo.tsx` is the same artwork as React components — `GravAIWordmark`,
`GravAIMark`, `GravAIIcon` — and is what the application actually renders.

## Metadata routes

| File | Purpose | Producer | Licence | Alt text |
|---|---|---|---|---|
| `src/app/icon.svg` | Favicon and browser tab icon, served by Next.js from the app directory. A copy of `brand/favicon.svg`. | Derived from the Graviton wordmark | Proprietary — GravAI / Graviton | Decorative |
| `src/app/opengraph-image.tsx` | OpenGraph and Twitter card, rendered at build time by `next/og` from brand tokens. No external asset is fetched and no font is loaded. | Generated from code, GravAI | Proprietary — GravAI | `alt` supplied by the module's export |

## Inline SVG components — no files, no requests

Every diagram and icon is an inline SVG React component drawn from CSS variables, so it
re-colours with the palette and costs no network request. Each carries either a
`<title>`/`<desc>` pair referenced by `aria-labelledby`, or `aria-hidden="true"` where
adjacent text already names it.

| Component | Location | Purpose | Accessibility |
|---|---|---|---|
| `ThreePlanes` | `src/components/diagrams/ThreePlanes.tsx` | The interface / platform / agent plane architecture. Home and `/platform`. | `role="img"` with a prose description of all three planes |
| `DocAiLifecycle` | `src/components/diagrams/PlatformDiagrams.tsx` | One 30-second document job on a time axis: ten back-off polls against thirty-seven flat polls. Tick positions are computed from the real back-off schedule (0.8 s, ×1.35, 5.0 s cap), not drawn by eye. | `role="img"` describing both lanes and both call counts |
| `GovernorDiagram` | `src/components/diagrams/PlatformDiagrams.tsx` | Four tenant queues into a weighted round-robin rotor into a ten-token bucket into the document endpoint. | `role="img"` describing the fair-share behaviour |
| `McpHandshake` | `src/components/diagrams/PlatformDiagrams.tsx` | Sequence diagram of the MCP OAuth 2.1 handshake and a tool call. | `role="img"` naming all four participants and each message |
| `RunTimelineDiagram` | `src/components/diagrams/PlatformDiagrams.tsx` | A durable agent run as a horizontal timeline, including the human-approval wait. | `role="img"` with a full description |
| `AgentIcon` | `src/components/icons/AgentIcon.tsx` | Fourteen agent icons, one per catalog entry, on a 24×24 grid with 1.4-unit strokes. | `aria-hidden="true"` — the agent name is always adjacent |
| `Icon` | `src/components/icons/AgentIcon.tsx` | Twenty-two interface icons (navigation, status, chrome) drawn to the same rules. | `aria-hidden="true"` |
| `AgentGlyph` | `src/components/site/AgentGlyph.tsx` | Fourteen agent motifs, one per catalog entry, on a 160×40 field with the icon set's 1.4-unit strokes, square caps and no fill: a document scan, a transaction sparkline, a FOIR meter, a banded risk gauge, a consented pipe, an identity match, a routed queue, a presentment timeline, two voice waveforms, an applicant journey, a turnover reconciliation, a segment field and a throughput ceiling. Structural parts sit one step back in `brand-200`; the risk gauge's GREEN/AMBER/RED arc is the catalog's own banding, the only semantic colour in the set. Plus a neutral fallback for any id the catalog adds later. **Motion:** three of the fourteen now move, and only while their card on `/agents` is hovered or holds keyboard focus — `doc_intelligence`'s scan line, `aa_data`'s consented pipe and `case_allocation`'s dispatch fan become a travelling dash, reusing the run graph's own `gv-dash` keyframe so a line carrying work looks the same everywhere in the product. The other eleven draw a settled reading rather than something in transit and stay still; animating a balance history or a FOIR meter would say the opposite of what it means. | `aria-hidden="true"` — the agent name, its capability chips and its tier marker are all adjacent, and no state is signalled by the drawing alone. The motion is `motion-safe:`-only, so a reduced-motion preference leaves the still drawing, which was always the complete one, and nothing moves at rest, so a listing of fourteen never animates by itself |
| `AgentPipeline` | `src/components/agents/AgentPipeline.tsx` | The animated explanation of what one agent does, drawn as three columns on a rail: what it reads, the stages the work moves through, what it produces. Markup and CSS plus one two-path play/pause mark drawn to the 24×24 / 1.4-stroke icon rules — no image, no recording. Every stage is read from the agent's own catalog entry (declared inputs, tool allowlist, AI capabilities, output-contract keys), so nothing is written per agent and the picture can only go stale when the catalog does. Where it cannot draw everything — the rail draws at most five stages, the Produces column three keys compact and five full — it counts what it left out beside the list rather than shortening the list silently, and the escalation condition is quoted from the catalog verbatim rather than paraphrased or cut. Teal marks a stage where an AI capability does the work and navy a stage that is deterministic code; the single travelling packet is the only continuous motion and it runs along the rail in the direction a real run takes, so the movement reinforces that reading rather than competing with it. Mounted at the top of every `/agents/[id]` page, once in compact form on the `/agents` index as the key to the set, and on every card in `/console/agents`. | `role="img"` with a prose description that names every stage in full, says for each whether it is an AI capability or deterministic code, gives the input and output counts, says how many declared stages the rail did not draw (that count is printed on the page but sits inside the `role="img"` subtree, where a screen reader cannot reach it) and states the escalation condition. The rail, the packet and the stage dots are `aria-hidden="true"`, and the heading carries the agent's name as `sr-only` so several panels on one page are distinguishable. A play/pause control is offered wherever there is motion to stop, is keyboard-reachable and takes the global `:focus-visible` ring. Under `prefers-reduced-motion: reduce` the animation stops rather than slows, the packet is not rendered at all, the outputs stay at full strength so the still diagram is complete, and the control is withdrawn rather than disabled because there is nothing left to pause. Off-screen instances stop animating, and that observer can only ever turn motion off, so a browser that never reports intersection still shows a working picture |
| `UseCaseFlow` | `src/components/site/UseCaseFlow.tsx` | One recorded run of an agent on `/agents/[id]`, drawn as a flow: who arrived, what the platform did, what came back. Tinted panel, cards and dashed connectors — the connector arrow and the tone ticks are the only inline SVG. Figures come from `src/lib/agent-usecase.ts`, transcribed from a real sandbox run and pinned to it by `tests/test_usecase_figures.py`. | A definition list per result; every tone carries an `sr-only` word and a coloured left edge as well as a hue, so nothing is signalled by colour alone. Decorative marks are `aria-hidden="true"` |
| `UseCaseProof` | `src/components/site/UseCaseFlow.tsx` | The measured figures from that same run, and whether it escalated. | Definition list laid out `flex-col-reverse`, so the term precedes the value in the DOM while the figure still reads first |
| `HomeHeroPanel` | `src/components/site/HomeHeroPanel.tsx` | The home hero's product visual: one agent run drawn as a control plane — window chrome, a status pill, a ticked document-intelligence step list on a connection line, a dashed connector to the next agent, a risk readout on the published band scale, and the same run's credit figures. Markup, CSS and two inline SVG glyphs, drawn to the 24×24 / 1.4-stroke icon rules. Figures are transcribed from the recorded sandbox run in `src/lib/agent-samples.json`. Colour means exactly three things here and nothing else: each agent's plate is that agent's own hue from the generated node catalog (teal for Document Intelligence, amber for Risk, indigo for Credit Appraisal, never chosen in the component); the risk band scale and the status pills are semantic green / amber / red; and a `ChannelMark` says in words which half of the platform did the work, teal for a language model and navy for deterministic code. | A `<figure>` whose caption states that it is a stylised view rather than a live dashboard; the panel is a named region, every status and every model/code channel carries a word as well as a hue, and the connector, the step spine and the band marker are `aria-hidden="true"` |
| `HomeMetricCompare` | `src/components/site/HomeMetricCompare.tsx` | The calls-per-document comparison on the home page: twelve calls against forty, drawn as two unit bars in which one cell is one API call, plus the deltas. CSS grid only — the cells are generated from `CALL_MODEL` in `src/lib/platform.ts`, so the drawing cannot drift from the numbers. Both bars share one four-hue key by KIND of call rather than one hue per path — violet submit, cyan status poll, indigo results fetch, teal language-model read — so the finding that the long bar is almost entirely polling is visible before it is stated. The two paths are told apart by the plane they sit on, not by hue; green, amber and rose are absent because a call is not an outcome. | Both bars are `aria-hidden="true"`; every count they encode is restated in words in the legend beneath, where each swatch is paired with its count and the name of the call |
| `AgentSpectrum` | `src/app/(site)/page.tsx` | The home hero's closing strip: the whole catalog as fourteen chips, each carrying the hue `lib/nodeCatalog.ts` gives that agent and its own `AgentIcon`. Markup and CSS over the existing icon set — no new artwork. It is the key to the colour system for the rest of the site, which is why it is generated from the catalog rather than listed by hand. | Each chip names its agent, so nothing is carried by the colour alone; the icons are `aria-hidden="true"` and the chips are links, so the row's horizontal scroller on a phone is reachable by keyboard without a stray tab stop |

All: Proprietary — GravAI.

## Charts

Charts are rendered by Recharts from data, not from image assets. Colours come from the
six-step brand-led categorical ramp in `globals.css` (`--gv-series-1` … `-6`); semantic
green and red are reserved for pass and fail and are never used to distinguish one series
from another. Every chart sits inside a `ChartFrame` whose caption states what is shown.

## Typography

| Family | Use | Source | Licence |
|---|---|---|---|
| Inter | All readable text, including headings | Google Fonts, loaded at runtime | SIL Open Font License 1.1 |
| IBM Plex Mono | Identifiers, hashes, endpoints, scopes and code | Google Fonts, loaded at runtime | SIL Open Font License 1.1 |

Requested from `fonts.googleapis.com` with `display=swap` and a complete fallback stack. No
font file is redistributed from this repository.

## What is deliberately absent

- **No photography of any kind**, licensed or otherwise. No stock, no scraped imagery, no
  model-generated pictures.
- **No console screenshots committed here.** The specification calls for Playwright captures
  from a seeded sandbox in CI. That job does not exist yet, and hand-taken screenshots would
  be stale within a week and would show example data as though it were real. See
  `DECISIONS.md` W-009.
- **No icon library dependency.** Every icon is authored here, so the set is consistent and
  the bundle carries only the icons actually used.
