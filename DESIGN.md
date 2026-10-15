# Design — NYC × SKY

<!-- impeccable:design-schema 1 -->

The record of the visual system this dashboard is built on. Written from the built
result, not from a plan. `src/styles/tokens.css` is the machine-readable form; this
is the reasoning.

## Direction

**The Analytical Figure Plate.** The page is a set of labeled, axis-sharing figure
panels written in the grammar of a printed statistical figure: hairline rules doing
all structural work, every number tabular, one restrained ground. The category
defaults it refuses are the neon-glass analytics panel and the plain white card
grid — this dashboard has no shadow, no glass, no structural gradient, and no
metric-card hero.

The world was chosen as grounded candidate 7 of 7 (seed `cffe09db`) after weighing
six catalog challengers. Four disciplines were taken from the challengers that lost:

- from a variable-font specimen — **one control remaps the whole surface**: the
  lens in the top bar re-runs every panel, and the year panel redraws with the
  selected window in ink against the full year as a ghost.
- from a dark developer console — **elevation is a plane, never a shadow**.
- from a gardens guide map — **colour plus shape, never colour alone**.
- from a gate board — **the ranking reranks in place, and one alert colour is
  reserved for "this moved under your lens"**.

## Type

One family. **Archivo** variable (wght 100–900, wdth 62–125), self-hosted as a
single latin woff2 at `public/fonts/archivo-var-latin.woff2`. It carries three
registers, distinguished by width, weight, size and tracking rather than by adding
faces:

| register | setting | used for |
|---|---|---|
| label | 11px · w600 · wdth 88 · uppercase · +0.10em | figure labels, panel labels, field labels, axis ticks |
| data | 13–15px · w400–500 · wdth 100 · `tnum` | table cells, prose, captions, readouts |
| figure | 18–36px · w700 · wdth 100 · −0.03em | KPI values, the masthead, panel titles |

Numerals are tabular everywhere (`font-variant-numeric: tabular-nums`,
`font-feature-settings: 'tnum' 1`) because the entire surface is columns of numbers
that must align by digit. No monospace: nothing here is code or a terminal, and a
mono would be a costume.

## Colour

**Restrained page, one committed panel.** The page ground is a cool paper white
(`#f4f5f4`), panels sit half a step up (`#fbfbfa`), and one tinted plane
(`#eceeec`) carries the active nav row, the selected table row and highlighted
chart regions. Structure is ink at four alphas, never a border colour.

Two accents, both with a defined job and neither allowed on chrome:

- `--rain #2c62d6` (with `--rain-deep #17357f` for text, `--rain-wash` for fields)
  is **reserved for weather** and for findings caused by weather. It appears only
  on precipitation, wet-hour marks, and rain-caused statements.
- `--frost #3f7fa8` is snow — the same weather family at lower intensity.
- `--rev #7d5a12` is the quieter second accent, used only for the revenue series.
- `--alert #a8261c` is reserved for exactly one meaning: **this moved under the
  filter you applied**. It marks zones whose rain index shifted in the ranking, and
  the emitters in the net-flow chart. It is never a generic "negative".

Selection is expressed without spending an accent: a selected zone is shown by
dimming its neighbours to 34% and outlining it in ink (`#zones.has-sel`).

## Rules and depth

There are no shadows in this system. Every boundary is a 1px hairline:

- `--rule` (13% ink) — internal table rows, gridlines, panel borders
- `--rule-mid` (24%) — control borders, the sidebar edge, the topbar edge
- `--rule-strong` (46%) — figure heads, table heads, the no-effect line
- `--rule-ink` (86%) — chart baselines

Panels are square (2px radius on controls only). The one deliberate piece of
decoration is the spine: a single faint vertical rule at the grid division in the
document-style layouts, which is the layout armature made visible.

## Layout

A fixed 236px left rail (brand, six sections each carrying the question it answers,
and a live MongoDB status line), a sticky filter bar spanning the content, then a
12-column panel field. Panels snap to spans 4 / 6 / 8 / 12 and collapse to a single
column below 1000px; below 760px the rail becomes a two-column strip at the top.

Charts are hand-drawn SVG with no chart library. Each renderer measures its
container and draws at that exact pixel width, so type is never scaled by a
viewBox. The map uses a locally-correct equirectangular projection (longitude
compressed by cos 40.7° = 0.758) and `vector-effect: non-scaling-stroke` so borders
hold their weight at any zoom.

## Motion

One authored moment: the map's zoom transform, 320ms on `cubic-bezier(.22,.68,.32,1)`.
Everything else is a 170ms state transition on background, colour or border. No
entrance choreography — the dashboard loads into a task. All of it is disabled under
`prefers-reduced-motion`.

## Charts and their encodings

Every categorical series carries **two** encodings so nothing depends on hue alone:
weekday mean is a filled bar and weekend mean an open one; precipitation bins carry
a square marker and a dashed line, the controlled series a circle and a solid line;
snow days get a horizontal cap over their rainfall bar. Diverging data is drawn
about a real zero line, computed from the data — a bar chart that clamps negatives
to a one-pixel stub is worse than no chart.

Sequential shading on a heavy-tailed variable is logarithmic and says so. A linear
ramp makes 250 of 262 zones the same shade next to JFK.

## Browser surfaces

Text selection is rain-blue on white. Focus is a 2px `--rain-deep` outline at 2px
offset, never removed. Scrollbars are themed from the rules. The caret and the
underline offset ship themed. This is treated as part of the design, not left at
the browser default.

## States

Every panel has a loading skeleton (a ruled grid, not a spinner), a drawn state, and
an error state that names the failure and the command to fix it. Empty states teach
the control ("select any zone on the map…") rather than saying "nothing here". The
zone table has a real empty result at some lenses and says which lens produced it.

## Access

Targets WCAG 2.2 AA. Body and secondary text are at or above 4.5:1 on the ground.
Every chart carries an `aria-label` describing what it encodes, tables have captions,
the map is `role="img"` with the table as the accessible equivalent, controls are
real `<button>`/`<select>` elements with `aria-pressed` where they toggle, and the
lens is reflected in the URL so a filtered view is linkable.
