# Design

## World

A lit board in a dark room. The page is near-black with a cool cast; the board
is warm paper and the only bright surface. Everything else — panels, controls,
telemetry — sits back so the board and the numbers beside it carry the page.

## Tokens

Defined in `src/styles/app.css` on `:root`.

- Ink ramp `--ink-900` … `--ink-500`: page, panels, controls, hairlines.
- Paper `--paper`, `--grid-ink`: the board surface and its ruling.
- Text `--text-hi` / `--text` / `--text-lo`: three steps, all ≥4.5:1 on ink.
- `--amber` is the single accent: the primary action, the winning line, the
  candidates an engine is weighing. Nothing else may claim it.
- `--teal` is reserved for measurement — probability bars, key fingerprints.
- `--rose` marks rejection only: a forbidden point, a destructive control.

## Type

- Display: Instrument Serif. Headline and section openers.
- UI: Inter. Everything a person operates.
- Data: JetBrains Mono with tabular numerals, for anything a reader compares —
  coordinates, latency, token counts, probabilities.

## Motion

One authored moment: a stone settles into place with an exponential ease-out
from 0.55 scale. Candidate rings pulse in sequence while an engine thinks,
staggered 70 ms apart. Probability bars scale on the compositor. Everything
collapses under `prefers-reduced-motion`.

## Waiting states

A board that is about to be played on by an engine is veiled, not covered: the
veil is paper-tinted and light enough that the grid, the star points and the
coordinates still read. The control on it is small and in ink, and the caption
under it carries who is about to move. Amber is the only accent this design
has, so it is not spent on the least interesting moment of a game.

## Rules

- Elevation is declared once, by shadow. No shadow-plus-border cards.
- Browser surfaces are themed: selection, caret, scrollbars, focus rings,
  underline offset.
- Icons are authored SVG at a single 1.4 stroke. No emoji, no glyph icons.
- The providers section uses hairline-separated columns, not cards.
