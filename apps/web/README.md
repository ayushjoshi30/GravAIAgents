# `apps/web` — GravAI marketing site, documentation and console

Next.js 15 (App Router) · TypeScript · Tailwind CSS v4 · MDX · Recharts.

One application serves three things:

| Route group | What it is |
|---|---|
| `src/app/(site)` | Marketing pages and MDX documentation. Static, public, indexed. |
| `src/app/console` | The production console. Token-gated, `noindex`, client-rendered. |
| `src/app/icon.svg`, `opengraph-image.tsx`, `sitemap.ts`, `robots.ts` | Metadata routes. |

---

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
```

```bash
npm run build      # production build
npm run start      # serve the production build on :3000
npm run typecheck  # tsc --noEmit
```

Node 22 and npm 10.

### Connecting the console to the API

The console talks to the GravAI REST API directly from the browser.

```bash
# apps/web/.env.local   (both optional)
NEXT_PUBLIC_GRAVAI_API_BASE=http://localhost:8000
NEXT_PUBLIC_GRAVAI_ENV=local
```

Start the API (`uv run uvicorn gravai_api.main:app --reload --port 8000`), mint a token
(`uv run python scripts/dev_token.py --tenant acme --role underwriter`), then paste it into
**Console → Settings**. The token is kept in `localStorage` and attached to API calls from
the browser; no Next.js server route proxies it, so it is never written to a server log.

**Without a token the console still works.** Every screen renders illustrative data under a
banner reading *"Example data — API not connected"*. Endpoints that have not shipped yet
(`/v1/runs`, `/v1/usage`, `/v1/tasks`) return 404, which renders as a labelled empty state
rather than an error.

---

## Where the brand tokens live

### Colour, type, radius, shadow — `src/app/globals.css`

Everything is defined once, at the top of that file:

- `:root` holds the raw values: the brand ramp (`--gv-brand-50` … `--gv-brand-700`,
  primary `--gv-brand: #204887`), neutrals, the semantic trio, the six-step categorical
  chart ramp, and three elevation steps.
- `@theme inline` maps those to Tailwind utility names, so `bg-brand-50`,
  `text-ink-2`, `border-line`, `shadow-sm` and `rounded-lg` all resolve to the tokens.
- `@layer components` defines the shared classes: `.gv-card`, `.gv-field`, `.gv-eyebrow`,
  `.gv-label`, `.gv-help`, `.gv-link`, `.gv-skip`, and the `.gv-prose` documentation
  typography.

**There is one theme.** Light only — no `prefers-color-scheme` branch, no `dark:` variants,
no toggle.

`blue` is deliberately kept as an alias of `brand` in the theme map so no component can
drift onto a second, unmanaged blue.

### The logo — `src/brand/Logo.tsx`

Copied verbatim from `<repo>/brand/`. Exports `GravAIWordmark`, `GravAIMark`, `GravAIIcon`
and `brandColors`.

The letterforms are the Graviton wordmark's own outlines, reused rather than redrawn: the
`G`, `R`, `A` and `V` keep their original coordinates, and the second `A` and the `I` are
the same outlines translated along the baseline by gaps taken from the source mark's own
spacing.

- **Do not re-kern, re-colour or re-set the name in a typeface.** If the wordmark looks
  wrong, the fix is upstream in the Graviton mark.
- Minimum wordmark width is 90px — every usage in this app is at `height={30}` or above,
  which is 92px wide.
- Colour split: `GRAV` in Graviton blue `#204887`, `AI` in teal `#0C6B5F`. That split is
  the positioning: the platform you have, and the layer on top.

Static copies live in `public/brand/` (wordmark, reverse, mono, monogram, favicon), and
`src/app/icon.svg` is the favicon.

### Typography

Inter for everything readable; IBM Plex Mono for identifiers, hashes, endpoints and code,
where character disambiguation matters. Loaded from Google Fonts with a full fallback
stack and `display=swap`, so the build never depends on a network fetch.

Every figure carries `tabular-nums` (via `data-numeric` or `.font-mono`), so columns of
numbers align on the decimal point.

---

## The design system

Components are the system; pages never style a control themselves.

| Component | File | Covers |
|---|---|---|
| `Button`, `ButtonLink`, `IconButton` | `components/ui/Button.tsx` | 4 variants × 3 sizes, hover/active/disabled/focus |
| `Badge`, `StatusBadge`, `TierBadge`, `RiskBandBadge`, `Tag` | `components/ui/Badge.tsx` | Status vocabulary and its tone mapping |
| `Card`, `Panel`, `SectionHeading`, `DefinitionRow`, `Eyebrow` | `components/ui/Surface.tsx` | Containers and headings |
| `TextField`, `TextArea`, `SelectField`, `ToggleField`, `SliderField`, `SegmentedControl` | `components/ui/Field.tsx` | All form controls, labels, hints, error states |
| `DataTable`, `SimpleTable` | `components/ui/DataTable.tsx` | Sorting, hover, keyboard activation, pagination, windowing |
| `StatTile`, `Meter` | `components/ui/Stat.tsx` | Metric tiles and utilisation bars |
| `DataModeBanner`, `EmptyState`, `InlineNote` | `components/ui/States.tsx` | Live / example / loading and empty states |
| `ChartFrame` and chart wrappers | `components/console/Charts.tsx` | Recharts bound to brand tokens |

Diagrams and icons are hand-authored inline SVG in `components/diagrams/` and
`components/icons/`. There are no raster assets anywhere in the application.

---

## Data and honesty rules

| File | Purpose |
|---|---|
| `lib/platform.ts` | Every real platform figure, each with its source. Nothing on the marketing pages is quoted from anywhere else. |
| `lib/agents.ts` | The thirteen agents, transcribed from `packages/gravai_agents/catalog.py`. |
| `lib/throughput.ts` | The throughput and backlog model behind the usage dashboard. Pure functions. |
| `lib/api.ts` | Typed REST client. Never throws at a call site; every method returns a discriminated result. |
| `lib/useResource.ts` | Fetch-with-fallback hook that exposes `live` / `example` / `loading`. |
| `lib/examples.ts`, `lib/exampleDossier.ts` | Deterministic example data. Always rendered under the example banner. |

Two rules are enforced throughout:

1. **No invented numbers.** A figure is either traceable to `platform.ts` with a source, or
   it is example data and the screen says so. Unset rate-card rows stay blank rather than
   being guessed, because a guessed unit price propagates into every derived cost.
2. **Example data is always labelled.** Every console screen renders a `DataModeBanner`
   above its content.

---

## Accessibility

- One `h1` per page and a real heading order under it.
- Skip links on both the site and the console shell.
- Every interactive element is reachable and operable by keyboard; table rows activate on
  Enter and Space; sortable headers are buttons with `aria-sort`.
- Focus is always visible: a 2px brand outline with an offset, plus a soft ring on fields.
- Every SVG either has a `<title>`/`<desc>` pair referenced by `aria-labelledby`, or
  `aria-hidden="true"` where adjacent text already names it.
- Colour is never the only signal: status badges carry a dot and a word.
- Long tables scroll inside their own frame; the page body never scrolls horizontally at
  any width down to 320px.

## Assets and licensing

Every graphic is listed in [`public/images/MANIFEST.md`](./public/images/MANIFEST.md) with
its purpose, producer and licence. There is no stock photography, no scraped imagery and no
model-generated imagery anywhere in this application.

## Decisions

Choices made while building this, and why, are in [`DECISIONS.md`](./DECISIONS.md).
