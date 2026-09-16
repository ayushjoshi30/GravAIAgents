# DECISIONS.md — `apps/web`

Assumptions and choices made while building the web application, recorded instead of
blocking. Format follows the repository root's `DECISIONS.md`.

Prefix `W-` so these do not collide with the platform's `D-` numbering.

---

**W-001 | 2026-09-14 | Brand | Graviton blue is `#204887`, not `#2F3F8F`**
The earlier brief and `GRAVAI_SPEC.md` §7.1 gave the secondary as `#2F3F8F`. The supplied
brand package (`brand/README.md`, and the `Logo.tsx` in it) reads `#204887` from the actual
Graviton SVG and says explicitly that the spec guessed. The real file wins. `#204887` is now
the primary across the whole application; the teal `#0C6B5F` is retained only for the `AI`
half of the wordmark and as a rare secondary accent, so the brand reads as blue-on-white.
*Verify-with:* `brand/README.md` and the source Graviton mark. *Reversible:* one token.

**W-002 | 2026-09-14 | Brand | The logo is used, not redrawn**
`brand/Logo.tsx` is copied verbatim into `src/brand/Logo.tsx` and imported everywhere. An
earlier iteration of this app drew its own monogram and wordmark; those were deleted. The
letterforms are Graviton's own outlines and the gaps come from the source mark, so
re-kerning or re-setting the name in a typeface would break the one idea the mark carries.
Every usage is at `height={30}` or larger, which is 92px wide and clears the 90px minimum in
`brand/README.md`. *Reversible:* no — the mark is the mark.

**W-003 | 2026-09-14 | Theme | Light only**
No dark theme, no `prefers-color-scheme` branch, no `dark:` variants, no toggle. A single
committed light design on `#F7F9FC` with white cards. An earlier iteration shipped a
designed dark theme; it was removed on instruction. Removing it also removed the
theme-bootstrap inline script, so there is no flash-of-wrong-theme problem to solve.
*Reversible:* yes, but it would mean reintroducing a second palette to keep correct.

**W-004 | 2026-09-14 | Content | No AI vendor is named on any user-facing surface**
Marketing pages, documentation, diagrams, alt text and the console describe capabilities —
"the model layer", "document intelligence", "speech services", "the AI provider" — and never
a vendor. Ledger products render as neutral labels ("Document extraction", "Model input
tokens") through `productLabel()` in `lib/platform.ts`, with the API's own `label` field
preferred where it is present.
*Consequence:* the `/sarvam` page was deleted and its substance — the capability list and
language coverage — moved to `/platform#ai-layer`, so nothing was lost. The one remaining
occurrence of the vendor name in this app is the `sarvam_sandbox` field on the `/readyz`
wire type in `lib/api.ts`, which is the API's contract, is never rendered, and is surfaced
in the console as "AI sandbox". *Reversible:* yes.

**W-005 | 2026-09-14 | Typography | Inter for text, IBM Plex Mono for identifiers**
The final brief permits Inter and asks for a polished enterprise product; an earlier brief
asked for Fraunces as a display face. Inter is used for everything readable, including
headings. IBM Plex Mono is kept for identifiers, hashes, endpoints, scopes and code, where
character disambiguation is the point. Numerals are tabular everywhere via `data-numeric`.
*Reversible:* one token in `globals.css`.

**W-006 | 2026-09-14 | Fonts | Loaded by `<link>`, not `next/font`**
`next/font/google` downloads font files at build time. That makes `npm run build` fail on a
machine without network access, which is the wrong failure mode for a deliverable whose
acceptance criterion is that it builds. A `<link>` with `preconnect` and `display=swap`
plus a complete fallback stack costs one request and removes the build-time dependency.
*Alternatives:* self-host the woff2 files — better for performance, but it means committing
font binaries and tracking their licences; worth doing before a production deploy.
*Reversible:* yes.

**W-007 | 2026-09-14 | Console auth | Bearer token in `localStorage`, no server proxy**
The console calls the API directly from the browser with the token the operator pastes into
Settings. There is no Next.js route handler in between.
*Rationale:* a proxy would put a bearer token for a lending platform into this application's
server logs and memory, and would make the web tier a second place where tenant scoping
could go wrong. Direct calls keep the API the single authority on authorisation.
*Consequence:* the API must allow the console's origin in CORS. It already does for
`http://localhost:3000` in local mode.
*Verify-with:* a production deployment must set the allowed origin explicitly.
*Reversible:* yes, but it would need a deliberate secret-handling design first.

**W-008 | 2026-09-14 | Data | Example data on every screen, always labelled**
Screens render deterministic example data when the API cannot answer, behind a persistent
"Example data — API not connected" banner. A blank console teaches nobody what the console
does, and a reviewer without a running API would otherwise see nine empty pages.
*Constraint:* example figures never appear on the marketing pages, which quote only
`lib/platform.ts`, where every figure carries its source. Example data is seeded and uses
fixed timestamps so server and client render identically and screenshots are reproducible.
*Reversible:* yes.

**W-009 | 2026-09-14 | Images | No console screenshots committed**
`GRAVAI_SPEC.md` §7.3 asks for Playwright captures from a seeded sandbox, generated in CI.
That CI step does not exist yet. Hand-taken screenshots committed to the repository would be
stale within a week and would show example data as though it were real, so none are
included. The manifest records this.
*Verify-with:* add the Playwright capture job, then link the artefacts.
*Reversible:* yes.

**W-010 | 2026-09-14 | Endpoints | The console codes against contracts that have not shipped**
`/v1/runs`, `/v1/usage` and `/v1/tasks` are declared in `lib/api.ts` with full response
types and are called for real. A 404 is classified as `not-implemented` and renders a
labelled empty state.
*Rationale:* writing the screens against the contract now means they do not have to be
rewritten when the endpoints land, and a console that crashes when the API is one version
behind is not a console you can operate with.
*Verify-with:* when the endpoints ship, the screens should light up with no code change
beyond field names. *Reversible:* yes.

**W-011 | 2026-09-14 | Tables | Paginated by default, windowed at large page sizes**
`DataTable` paginates at 25 rows by default and offers 25/50/100/All. Above 150 rows on a
page it switches to windowed rendering with a spacer above and below.
*Rationale:* the specification asks for virtualisation on long lists and the final brief
asks for enterprise pagination. Both are satisfied: the default keeps the DOM small and
familiar, and "All" on a fifty-thousand-row export view still scrolls smoothly.
*Reversible:* yes.

**W-012 | 2026-09-14 | Layout | Wide tables scroll inside their own frame**
A nine-column run table cannot be made narrow without hiding data. Tables and diagrams
declare a natural minimum width and scroll horizontally inside their own container; the
page body never scrolls sideways at any width.
*Consequence:* several grid containers carry `min-w-0` explicitly, because a CSS grid item's
default `min-width: auto` otherwise lets a wide child ratchet its whole column wider. This
also fixes a Recharts feedback loop where the chart's own content grew its container on
every resize observation. *Reversible:* no reason to.

**W-013 | 2026-09-14 | Throughput model | Business hours, not 24/7, is the default**
The usage dashboard defaults to 10 submitting hours per day, 22 business days per month.
*Consequence:* with polls counted against the limit, the default scenario shows demand at
roughly eight times business-hours capacity, and about three times capacity even running
continuously. That is not a bug in the widget — it is the finding, and it is exactly why
`D-005` (do status polls count?) is the platform's highest-value open question and why a
committed-rate plan is a named open item. The dashboard states this in prose above the
projection rather than leaving an operator to infer it from a rising line.
*Verify-with:* the four-corner scenario matrix on the same screen. *Reversible:* yes.

**W-014 | 2026-09-14 | Rate card | Unconfirmed unit prices stay blank**
Only two rate-card rows are confirmed by a tenant contract: extraction at ₹1.00 per page and
digitisation at ₹0.50 per page. Language and speech rows render as "not set" rather than
carrying a plausible guess, because a guessed unit price propagates silently into every cost
figure and every unit economic on the usage dashboard.
*Verify-with:* the tenant contract. *Reversible:* fill the row.

**W-015 | 2026-09-14 | Tooling | No ESLint configuration**
The application ships without ESLint. `tsc --noEmit` in strict mode is wired as
`npm run typecheck` and runs clean.
*Rationale:* scope. A lint configuration that nobody has tuned produces either noise or a
false sense of coverage.
*Verify-with:* add `eslint-config-next` and tune it before this is a team codebase.
*Reversible:* yes.

**W-016 | 2026-09-14 | SEO | OpenGraph image generated at build time**
`src/app/opengraph-image.tsx` renders the card with `next/og` from brand tokens, using no
custom font and fetching no external asset, so it cannot fail a build or drift from the
palette. Per-page OG images are not generated; the single site-level card is used
throughout. *Reversible:* yes — add route-level `opengraph-image` files.
