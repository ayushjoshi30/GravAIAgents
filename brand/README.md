# GravAI brand

The GravAI mark is **derived from the Graviton wordmark, not drawn alongside it.**

## How it was made

`GRAVITON` already contains every letter `GravAI` needs. The G, R, A and V keep
their original coordinates untouched; the second A and the I are the *same*
outlines translated along the baseline:

| Glyph | Source | Shift | Resulting gap |
|---|---|---|---|
| G R A V | GRAVITON, positions 1–4 | none | as drawn |
| A | GRAVITON's A | `+39.7` | 9.47 after V |
| I | GRAVITON's I | `+21.6` | 8.42 after A |

Both gaps are taken from the source mark's own spacing — 9.47 is its widest
natural gap (O→N), 8.42 is its V→I gap. Nothing about the spacing is invented,
which is why the split still reads in one colour.

**Do not re-kern these.** If the wordmark ever looks wrong, the fix is upstream
in the Graviton mark, not here.

## Colour

| Token | Hex | Use |
|---|---|---|
| Graviton blue | `#204887` | `GRAV`, the app-icon tile |
| AI teal | `#0C6B5F` | `AI` on light grounds |
| AI teal, bright | `#41B8A6` | `AI` on dark grounds |

The colour split is the idea: **GRAV** is the platform you already have, **AI**
is the layer on top. It is the whole positioning in two colours.

> The blue is `#204887`, read from the supplied Graviton SVG. An earlier draft
> of `GRAVAI_SPEC.md` guessed `#2F3F8F`; the real file wins (DECISIONS.md D-011).

On dark grounds the teal is brightened rather than inverted — `#0C6B5F` does not
hold contrast against a dark ground, and a naively inverted palette would make
`AI` the least legible part of the name.

## Files

| File | Use |
|---|---|
| `gravai-wordmark.svg` | Default. Light grounds. |
| `gravai-wordmark-reverse.svg` | Dark grounds. |
| `gravai-wordmark-mono.svg` | One colour, inherits `currentColor`. Footers, email, print. |
| `gravai-mark.svg` | G monogram, inherits `currentColor`. |
| `favicon.svg` | Square app icon. Blue tile, white G, teal rule. |
| `Logo.tsx` | React components: `GravAIWordmark`, `GravAIMark`, `GravAIIcon`. |
| `contact-sheet.html` | Every variant, both themes, at real sizes. |

## Clear space and minimum size

- **Clear space:** the height of the `G` on all four sides. The wordmark's own
  left margin (11.14 units at a 40-unit height) is that measure.
- **Minimum wordmark width:** 90px. Below that the `AI` counters close up — use
  the monogram instead.
- **Minimum monogram:** 16px.

## Don'ts

- Don't re-colour `GRAV` and `AI` the same shade in the colour variant — use
  `gravai-wordmark-mono.svg`, which is spaced to work that way.
- Don't set the name in a different typeface. These are outlines, not text; the
  point is that they are Graviton's letterforms.
- Don't add a gradient, a glow, or a container to the wordmark.
- Don't stretch. Scale proportionally; the React components do this for you.

## Usage

```tsx
import { GravAIWordmark, GravAIMark, GravAIIcon } from "@/brand/Logo";

<GravAIWordmark height={32} />                    {/* light ground */}
<GravAIWordmark tone="reverse" height={32} />     {/* dark ground */}
<GravAIWordmark tone="mono" className="text-slate-500" />
<GravAIMark size={24} />                          {/* inherits colour */}
<GravAIIcon size={40} />                          {/* square app icon */}
```
