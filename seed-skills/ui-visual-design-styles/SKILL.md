---
name: ui-visual-design-styles
description: Apply modern web visual-design languages -- UI/UX fundamentals, design-token systems, glassmorphism (glassify) and flat / flat-2.0 design -- with concrete CSS recipes and when-to-use guidance. Use when choosing or implementing the LOOK of a UI (surfaces, color, type, elevation, blur, motion), after the IA (user-flow-menu-design) and research (frontend-design-research) are settled. Triggers: "make it modern", "glassmorphism", "glassify", "frosted glass", "flat design", "UI style", "visual language", "design system tokens", "milyen stílus", "üveghatás", "lapos design".
---

# UI Visual Design Styles (modern web, UI/UX, glassmorphism, flat)

This is the VISUAL-LANGUAGE layer of Fron Ted's toolkit. It assumes the information
architecture is decided ([[user-flow-menu-design]]) and the trend research is done
([[frontend-design-research]]). Here you choose and implement HOW surfaces look:
color, type, spacing, elevation, blur, motion. QA uses the verification checklist
to sign off the look (alongside [[wcag-overlay-patterns]] for overlay a11y).

## When to use
- Picking a visual direction for a product or screen (glass vs flat vs hybrid).
- Implementing surfaces, cards, nav, modals with a consistent token system.
- Reviewing a UI for visual quality, consistency, and accessibility of the style.
- Whenever someone says "make it modern / premium / glassy / clean / flat".

## 0. Non-negotiables (apply to EVERY style)
- **Token-first, never hard-coded values.** Every color, space, radius, shadow,
  duration is a CSS custom property. White-label/theming demands it (e.g. CleanCore
  per-tenant `--brand-primary`). Hard-coded hex in a component = bug.
- **WCAG-AA contrast on all states** (text 4.5:1, large text/UI 3:1). Style never
  beats legibility. Re-check contrast in BOTH themes and over blurred backdrops.
- **Every surface ships 5 states:** default, hover/focus (visible focus ring),
  active/selected, disabled, and loading (skeleton). Plus empty + error at screen level.
- **Font must be Unicode-complete.** Use a family with full Latin Extended-A/B (and
  the scripts the product needs) so diacritics in all locales render in ONE typeface
  (CleanCore: EN/DE/PL/IT/FR/HU/ES — ő ű ł ą é è ñ ç ã etc. must not fall back).
  Safe variable choices: Inter, Geist, IBM Plex Sans, Source Sans 3, Noto Sans.
- **Respect `prefers-reduced-motion`** and `prefers-color-scheme`.

## 1. UI/UX fundamentals (the part that survives every trend)
- **Visual hierarchy:** one primary action per view; size, weight, color, and space
  encode importance. If everything is bold, nothing is.
- **Spacing scale (4/8px base):** `--space-1:4px … --space-8:48px`. Consistent rhythm
  reads as "designed". Group related items with proximity (Gestalt), separate with space.
- **Type scale (modular ~1.25):** 12 / 14 / 16 / 20 / 25 / 31 / 39. Set line-height by
  role (body ~1.5, headings ~1.2). Max line length 60–75ch for reading.
- **Laws to design by:** Fitts (big, close, thumb-reachable targets — ≥44px touch),
  Hick (fewer choices = faster), Jakob (match platform conventions), Miller (chunk).
- **Affordance & feedback:** interactive things look interactive; every action gets an
  immediate response (<100ms perceived) — hover, press, optimistic state, or skeleton.
- **Accessibility is design, not polish:** keyboard path, focus order, landmarks,
  `aria-current` on active nav, labels, target size. Bake in from the first screen.

## 2. Modern web design baseline (2024–2025)
A calm, token-driven base that any style sits on top of:
```css
:root{
  /* color — neutral base + one brand accent (theme-swappable) */
  --bg: #0b0c0e;            --surface: #15171b;     --surface-2: #1d2026;
  --text: #f2f4f7;          --text-muted: #9aa3af;  --border: #2a2e36;
  --brand-primary: #4f7cff; --brand-on: #ffffff;    --focus: #8ab4ff;
  /* radius / elevation / motion */
  --r-sm:8px; --r-md:14px; --r-lg:22px; --r-pill:999px;
  --e-1:0 1px 2px rgb(0 0 0/.30); --e-2:0 6px 20px rgb(0 0 0/.35);
  --dur-fast:120ms; --dur:200ms; --ease:cubic-bezier(.2,.7,.2,1);
}
@media (prefers-color-scheme: light){ :root{
  --bg:#f6f7f9; --surface:#fff; --surface-2:#f0f2f5; --text:#0c1116;
  --text-muted:#5b6470; --border:#e3e7ee; --brand-on:#fff;
}}
```
Hallmarks: generous whitespace, strong type hierarchy, card/list surfaces, status
chips, subtle depth, restrained, purposeful micro-interactions. Use a bento/asymmetric
grid where content benefits — not as decoration.

## 3. Glassmorphism ("glassify" / frosted glass)
Translucent, blurred surfaces that float above a colorful/imagery backdrop, with a thin
luminous border. Premium, depth-rich, great for overlays, nav bars, hero cards, HUDs.

**Recipe (the four ingredients):** translucent fill + backdrop-blur + 1px hairline
border + soft shadow. The border and a faint top highlight sell the "glass edge".
```css
.glass{
  background: rgba(255,255,255,.10);          /* light theme: .55–.7 over imagery */
  backdrop-filter: blur(16px) saturate(160%);
  -webkit-backdrop-filter: blur(16px) saturate(160%);
  border: 1px solid rgba(255,255,255,.18);
  border-radius: var(--r-lg);
  box-shadow: var(--e-2), inset 0 1px 0 rgb(255 255 255/.15); /* inset = top edge */
}
```
**Use it for:** modals/sheets, sticky top nav, notification toasts, KPI/hero cards,
media-rich dashboards. Needs something behind it (gradient, photo, mesh) — glass over
flat gray is just a weak card.

**Pitfalls (this is where glass goes wrong):**
- **Contrast collapse.** Text on translucent glass often fails AA. Fix: raise fill
  opacity, add a `rgba(0,0,0,.25)` scrim layer behind text, or a subtle text shadow.
  ALWAYS measure contrast over the actual worst-case backdrop.
- **Performance.** `backdrop-filter` is GPU-heavy; many stacked blurs jank low-end
  mobiles. Limit count, avoid animating blur radius, test on a real phone.
- **Fallback.** `@supports not (backdrop-filter: blur(1px))` → use a solid/near-solid
  fill so it degrades to a clean opaque card. Never ship illegible glass.
- **Accessibility.** Honor `prefers-reduced-transparency` where available; keep a solid
  variant for users who need it. Don't put long-form reading text on glass.

## 4. Flat design (and flat 2.0 / "semi-flat")
No skeuomorphic depth: solid fills, crisp edges, bold color, clear type, iconography
over photorealism. **Flat 2.0** (recommended default) adds *just enough* depth — long/
subtle shadows, soft elevation, ghost/gradient accents — to signal interactivity that
pure flat removed.
```css
.flat-card{
  background: var(--surface);
  border: 1px solid var(--border);     /* edge instead of heavy shadow */
  border-radius: var(--r-md);
  box-shadow: var(--e-1);              /* flat-2.0: a hint of lift, not a drop-shadow */
}
.btn-primary{ background: var(--brand-primary); color: var(--brand-on);
  border-radius: var(--r-md); transition: filter var(--dur) var(--ease); }
.btn-primary:hover{ filter: brightness(1.07); }
```
**Use it for:** data-dense apps, dashboards, tables, forms, B2B/operational tooling
where clarity and speed beat spectacle (e.g. CleanCore Manager Web). Flat scales,
performs, and stays legible.
**Pitfall:** pure flat can hide what's clickable — use flat 2.0 cues (elevation on
hover, clear button fills, focus rings) so affordance survives.

## 5. Choosing & combining
- **Flat 2.0 = safe default** for productivity/B2B, tables, mobile PWAs (fast, legible).
- **Glass = accent layer**, not the whole UI: apply to floating chrome (nav, modals,
  toasts, hero) over a flat content base. Best hybrid: flat content + glass overlays +
  one brand accent + a colorful backdrop where the glass lives.
- **Avoid mixing too many languages.** One base style + one accent technique. Don't
  pile glass + neumorphism + heavy gradients in one view.
- Map style to brand tone: glass = premium/modern/consumer; flat = trustworthy/
  efficient/enterprise. Per-tenant white-label means tokens, not new stylesheets.

## Pitfalls (quick list)
- Hard-coded colors/spacing instead of tokens → breaks theming/white-label.
- Glass text failing contrast; animating blur; no `@supports` fallback.
- Pure flat with no affordance cues; clickable ≠ obvious.
- One font that lacks diacritic glyphs → ugly fallback for non-EN locales.
- Decorative bento/asymmetry with no content reason.
- Forgetting reduced-motion / reduced-transparency / dark-mode parity.

## Verification (QA sign-off checklist)
- [ ] All visual values come from tokens; theme/white-label swap works (light+dark).
- [ ] AA contrast holds for text + UI in BOTH themes AND over glass worst-case backdrop.
- [ ] Every interactive element: visible focus ring, hover, active, disabled, loading.
- [ ] Glass surfaces have `@supports` fallback + solid variant; blur not animated.
- [ ] Touch targets ≥44px; primary action obvious; one primary per view.
- [ ] Single chosen font renders ALL required locales' diacritics (no glyph fallback).
- [ ] `prefers-reduced-motion` and `prefers-color-scheme` respected.
- [ ] Style language is consistent (one base + one accent), not a pile-up.
