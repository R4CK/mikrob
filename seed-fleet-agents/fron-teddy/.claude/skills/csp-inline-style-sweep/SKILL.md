---
name: csp-inline-style-sweep
description: Convert React style={{}} inline styles to CSS classes for Content Security Policy compliance. Use when a CSP batch sweep card lands, or when `default-src 'self'` blocks inline styles.
---
# CSP Inline Style Sweep

## When to use
- A card says "CSP sweep: convert inline styles in [page list]"
- `default-src 'self'` (or `style-src 'self'`) is the target CSP — it blocks React `style={{}}` props
- Finding the violations: `grep -rn "style={{" apps/web/src/features/<page> | grep -v "CSSProperties\|--[a-z]"`

## Core rule
`style={{ color: ..., background: ... }}` = CSP violation.
`style={{ '--var': value } as CSSProperties}` = CSP-safe (custom properties are NOT style attributes in CSP terms).
`className="..."` = always safe.

## Conversion patterns

### 1. Static value → CSS class
```tsx
// BEFORE
<td style={{ fontWeight: 700 }}>

// AFTER — add class to CSS file, remove style prop
<td className="col-bold">
```
CSS: `.col-bold { font-weight: 700; }`

### 2. Boolean conditional → conditional className
```tsx
// BEFORE
<td style={{ color: val >= 0 ? '#00c2b2' : '#ef4444' }}>

// AFTER
<td className={`cell-num ${val >= 0 ? 'cell-positive' : 'cell-negative'}`}>
```
CSS:
```css
.cell-positive { color: var(--color-success, #00c2b2); }
.cell-negative { color: var(--color-danger, #ef4444); }
```

### 3. Multi-tier color → data attribute selector
When there are 3+ distinct color tiers (e.g. profit margin great/ok/thin/loss), avoid N separate classes.
```tsx
// BEFORE — MARGIN_COLORS constant + inline style
const MARGIN_COLORS = { great: '#00c2b2', ok: '#10b981', thin: '#f59e0b', loss: '#ef4444' }
<span style={{ color: MARGIN_COLORS[tier], background: MARGIN_BG[tier] }}>

// AFTER — data attribute selector
<span className="margin-pill" data-tier={tier}>
```
CSS:
```css
.margin-pill[data-tier="great"] { color: var(--color-success); background: var(--color-success-bg); }
.margin-pill[data-tier="ok"]    { color: var(--color-ok);      background: var(--color-ok-bg); }
.margin-pill[data-tier="thin"]  { color: var(--color-warn);    background: var(--color-warn-bg); }
.margin-pill[data-tier="loss"]  { color: var(--color-danger);  background: var(--color-danger-bg); }
```
Eliminates constant objects entirely.

### 4. Dynamic numeric value → CSS custom property (safe)
```tsx
// BEFORE — percentage width from data (VIOLATION)
<div style={{ width: `${pct}%` }}>

// AFTER — CSS custom property (CSP-safe)
<div className="bar-fill" style={{ '--bar-pct': `${pct}%` } as React.CSSProperties}>
```
CSS: `.bar-fill { width: var(--bar-pct, 0%); }`

### 5. Cursor conditional → class
```tsx
// BEFORE
<tr style={{ cursor: row.hasDetail ? 'pointer' : 'default' }}>

// AFTER
<tr className={`row${row.hasDetail ? ' row--clickable' : ''}`}>
```
CSS: `.row--clickable { cursor: pointer; }`
(Default cursor is inherited — no class needed for the `default` case.)

## Workflow

1. **Find violations**: `grep -rn "style={{" apps/web/src/features/<page>.tsx | grep -v "CSSProperties\|'--"`
2. **Categorize each**: static / boolean / multi-tier / dynamic-numeric
3. **Add CSS classes** to the companion `.css` file (externalized — never `<style>` tags in JSX)
4. **Remove inline styles** — also remove the constant objects they came from
5. **Verify**: re-run grep; it should return 0 hits (or only `CSSProperties` hits, which are safe)
6. **TS check**: `npx tsc -p apps/web/tsconfig.json --noEmit 2>&1 | grep <PageName>`
7. **Tests**: `npx vitest run --reporter=verbose <PageName>` if tests exist

## Common gotchas

- **Removing the constant but leaving the reference**: if you delete `MARGIN_COLORS` but leave `style={{ color: MARGIN_COLORS[tier] }}`, TS will error. Fix both in the same edit.
- **CSS file is NOT imported**: check the TSX for `import './PageName.css'` — if missing, add it. Also verify the CSS file is EXTERNALIZED (not a `<style>` tag inside render, which is also a CSP violation).
- **`style={{ '--var': value } as CSSProperties}` is safe**: do NOT convert these; they're the correct pattern for dynamic values.
- **SVG fill/stroke attributes**: `fill="#3b82f6"` on `<svg>` elements is NOT a CSP violation (it's an HTML attribute, not a style prop). Leave SVG presentation attributes alone.
- **`style` from parent component props**: if a component accepts `style?: CSSProperties` as a prop and passes it down, that's a separate concern (component API design, not a sweep target).

## Verification
- [ ] `grep -n "style={{" <page>.tsx | grep -v "CSSProperties\|'--"` returns 0 lines
- [ ] Companion CSS file is externalized and imported at the top of the TSX
- [ ] `tsc --noEmit` shows no new errors for the changed file
- [ ] Constant objects (COLORS, BG_MAP, etc.) are fully removed if no longer referenced
