---
name: d3-data-visualization
description: Build interactive, accessible data visualizations with D3.js -- bar/line/area/pie/scatter, time series, maps/choropleth, network graphs, with tooltips, zoom/pan/brush, and responsive layouts. Use for dashboards, KPI tiles, analytics, reports, and any chart where the data tells the story. Triggers: "chart", "graph", "data viz", "D3", "dashboard chart", "KPI", "time series", "choropleth", "network graph", "diagram", "vizualizáció", "grafikon".
---

# D3.js Data Visualization

The data-viz layer of Fron Ted's toolkit. Use AFTER the visual language is set
([[ui-visual-design-styles]]) so charts inherit the same tokens (color, type, spacing).
For motion/3D storytelling use [[scroll-driven-3d-motion]] instead -- this skill is
about making *data* legible and interactive, not spectacle.

## When to use
- Dashboards, KPI tiles, analytics panels, reports, exports.
- A field-service SaaS fits: operations KPIs (jobs done, on-time %, photo-gate pass rate),
  evidence/audit timeline, site/zone map (choropleth or pins), inventory trends,
  billing/usage charts. Charts live in the data-dense manager web app, NOT the field PWA core.
- Any time a table would hide the trend a chart would reveal.

## Choose the right rendering
- **SVG** (default): crisp, stylable with CSS/tokens, accessible, good to ~1–2k marks.
- **Canvas**: switch when >~2k points or smooth pan/zoom of large series (SVG janks).
- **Hybrid**: Canvas for the dense data layer, SVG/HTML for axes, labels, tooltips.

## Core pattern (the D3 idioms that matter)
```js
// 1. Scales map data -> pixels. Always domain from data, range from layout.
const x = d3.scaleTime().domain(d3.extent(data, d => d.t)).range([m.l, w - m.r]);
const y = d3.scaleLinear().domain([0, d3.max(data, d => d.v)]).nice().range([h - m.b, m.t]);
// 2. Data join (enter/update/exit) — the heart of D3; use .join() (v6+).
const bars = svg.selectAll('rect').data(data, d => d.id).join('rect');
// 3. Axes from scales (don't hand-draw ticks).
svg.append('g').attr('transform', `translate(0,${h - m.b})`).call(d3.axisBottom(x));
// 4. Color from design tokens, never hard-coded.
const color = getComputedStyle(root).getPropertyValue('--brand-primary').trim();
```
- Use `.nice()` on numeric domains; format axes with `d3.format` / `d3.timeFormat`.
- One responsive size source: a ResizeObserver on the container re-runs scales+render.
- Transitions with `.transition().duration(var)` for update — animate position, not layout thrash.

## Interactivity
- **Tooltip:** an absolutely-positioned HTML node (not SVG `<title>`) follows pointer;
  show value + label; dismiss on leave; keyboard-focusable points for a11y.
- **Zoom/pan:** `d3.zoom()` with rescale of the x/y scales; clamp `scaleExtent`.
- **Brush:** `d3.brushX()` for range selection (e.g. time window) → filter the rest.
- **Crossfilter feel:** selecting in one chart filters siblings via shared state.

## Accessibility (charts fail a11y by default — fix it)
- `role="img"` + `aria-label` summarizing the chart; or a visually-hidden data `<table>`
  as the accessible equivalent (best practice for screen readers).
- Don't encode meaning by color alone — add pattern/label/shape; check AA contrast.
- Color scales: use perceptually-uniform / colorblind-safe ramps (viridis, cividis,
  or a tokenized brand ramp); categorical = `d3.schemeTableau10` not random hues.
- Keyboard: focusable data points, focus ring, arrow-key traversal for key series.
- Respect `prefers-reduced-motion`: skip entry animations, render final state.

## Performance
- Canvas past ~2k marks; for huge series downsample (LTTB) before drawing.
- Don't rebind/re-create the whole DOM each tick — use the data join + transitions.
- Debounce ResizeObserver; cap devicePixelRatio for Canvas on mobile.
- Lazy-load D3 and the chart module (dynamic import) so dashboards stay fast.

## Dependencies (IMPORTANT in this repo)
D3 is a new dependency. In a shared multi-agent checkout, deps go through MikroB's
lockfile batch — do NOT add `d3` to package.json yourself; request it. Prefer modular
imports (`d3-scale`, `d3-selection`, `d3-shape`) over the full `d3` to keep bundle small.

## Pitfalls
- Hard-coded colors/sizes → breaks white-label theming; pull from tokens.
- SVG with thousands of nodes → jank; switch to Canvas.
- Color-only encoding; missing aria; tooltips that trap focus or never dismiss.
- Animating on every data tick → layout thrash; transition only what moved.
- Truncated/zero-baseline omission misleading the reader (bar charts must start at 0).

## Verification (QA sign-off)
- [ ] Colors/type/spacing from tokens; theme swap (light/dark) works.
- [ ] AA contrast; not color-alone; colorblind-safe ramp.
- [ ] `role=img`+aria-label OR hidden data-table equivalent; keyboard-traversable.
- [ ] Responsive via ResizeObserver; no overflow/clipping at mobile widths.
- [ ] >2k marks rendered on Canvas; no jank on pan/zoom; reduced-motion honored.
- [ ] Axes formatted/`.nice()`; bar baselines at 0; units labeled.
- [ ] D3 imported modularly + lazy-loaded; dep requested via lockfile batch.
