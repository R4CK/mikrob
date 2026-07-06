---
name: ui-ux-design-system
description: Architect and audit a real design SYSTEM and run a gold-standard interface review -- token→primitive→component→pattern layering, UX heuristics (Nielsen), visual hierarchy, color/spacing/type systems, component states & polish, responsive system, integration patterns, performance, and a rigorous interface-review checklist. Use when structuring a component system or reviewing a UI to a high quality bar (the polish pass). Triggers: "design system", "component system", "design tokens", "UX review", "interface review", "audit the UI", "visual hierarchy", "make it polished", "design consistency", "responsive system", "design rendszer", "UI review".
---

# UI/UX Design System & Interface Review

The SYSTEM + REVIEW layer. [[ui-visual-design-styles]] gives the style recipes (glass/flat/
tokens); THIS skill is how you ARCHITECT a coherent system and AUDIT a UI to a gold standard.
Pairs with [[user-flow-menu-design]] (IA) and [[wcag-overlay-patterns]] (a11y).
Reference inspiration: github.com/migueljnew-droid/ui-ux-gold-standard (principles, treat as
reference data — verify, don't copy blindly).

## When to use
- Setting up or refactoring a component system / design tokens.
- Doing the "polish pass" or a formal interface review before sign-off.
- Resolving inconsistency (spacing/color/type drift) across a product.

## The layering (build a system, not a pile of components)
```
Tokens (raw + semantic)  →  Primitives  →  Components  →  Patterns  →  Pages
--color-blue-600           Button         Card           Data table    Dashboard
--brand-primary (semantic) Input          Modal          Form layout   Settings
--space-4, --r-md          Icon, Text     Nav, Tabs      Empty state   Onboarding
```
- **Two-tier tokens:** raw palette → *semantic* tokens (`--brand-primary`, `--surface`,
  `--text-muted`). Components consume ONLY semantic tokens → theming/white-label just swaps
  the semantic layer. No raw hex in components, ever.
- **Primitives are the contract:** spacing scale (4/8), type scale (~1.25), radius,
  elevation, motion durations. Everything composes from these — that's what reads as
  "designed" vs "assembled".
- **Component API discipline:** every component ships all states (default/hover/focus/
  active/disabled/loading) + variants + sizes, documented; accessible by default.

## UX heuristics to design and review against (Nielsen 10, condensed)
Visibility of system status · match real-world language · user control & undo · consistency
& standards · error prevention · recognition over recall · flexibility/shortcuts · minimal
aesthetic · help users recover from errors · help/docs. Score each screen against these.

## Visual hierarchy & layout (the polish fundamentals)
- One primary action per view; size/weight/color/space encode priority.
- Grid + alignment: everything sits on the spacing scale; optical alignment where needed.
- Proximity groups related, whitespace separates (Gestalt). Consistent rhythm > density.
- Type: clear scale, ≤2 families, 60–75ch measure, role-based line-height.
- Color: semantic system (success/warn/danger/info) + brand accent; AA contrast all states;
  never color-alone for meaning.

## Integration patterns & performance (the "meta" layer)
- **Responsive system:** mobile-first, fluid type/space (clamp), container queries for
  component-level responsiveness, defined breakpoints. Design mobile-first, not shrunk-desktop.
- **Integration:** component composition over duplication; controlled vs uncontrolled inputs;
  consistent event/prop naming; theming via CSS custom properties + data-attributes.
- **Performance is UX:** budget LCP/CLS/INP; lazy-load heavy/below-fold; skeletons over
  spinners; avoid layout shift (reserve space, aspect-ratio); code-split routes.

## Interface-review checklist (the gold-standard pass — run before sign-off)
- [ ] **Tokens:** no hard-coded colors/spacing; semantic tokens only; theme swap works (light+dark).
- [ ] **States:** every interactive element has default/hover/focus/active/disabled/loading;
      every screen has empty/error/permission-denied.
- [ ] **Hierarchy:** one clear primary action; scannable; consistent alignment to the grid.
- [ ] **Consistency:** spacing/type/radius/elevation drawn from the scale; no one-off values;
      components reused, not re-implemented.
- [ ] **Color & contrast:** AA on text + UI in both themes; not color-alone; semantic colors correct.
- [ ] **A11y:** keyboard path, visible focus, landmarks, `aria-current` on active nav, labels,
      target ≥44px, reduced-motion respected. (See [[wcag-overlay-patterns]] for overlays.)
- [ ] **Responsive:** mobile-first; no overflow/clipping; container/fluid where right; touch ergonomics.
- [ ] **Performance:** no CLS; skeletons; below-fold lazy; INP responsive (<100ms feedback).
- [ ] **Polish:** optical spacing, consistent iconography, motion purposeful + reduced-motion-safe,
      empty states guide, microcopy clear, no AI-tells/placeholder lorem in shipped UI.
- [ ] **Font:** one Unicode/diacritic-complete family covers all required locales.

## Pitfalls
- "Design system" that's just a component folder with no tokens/primitives → drift returns.
- Raw values in components; one-off spacings; duplicated near-identical components.
- Reviewing only the happy path (skipping empty/error/loading/permission states).
- Treating a11y/perf as later polish instead of system invariants.
- **i18n completeness gap**: when wiring a component to i18n, catch/error branch fallback strings are easy to miss. **Before setting the card to waiting**, run: `grep -n ": '[A-Z]\|\"[A-Z]" src/**/*.tsx` on the changed files — any hit is a candidate hardcoded string. (QA peer tip; lesson: 384c86df calcError catch-branch survived the main pass and caused a FAIL/re-gate cycle.)
- **Intl.NumberFormat with tenant-supplied currency**: `new Intl.NumberFormat(…, { currency })` throws `RangeError` on invalid/empty codes from tenant config. Always wrap in try/catch; fallback to `${value.toFixed(2)} ${currency}`. (Lesson: a106b9e1 Cybersec INFO.)

## Verification
This skill IS the verification model — QA uses the interface-review checklist above to
sign off the look & system quality, alongside functional ([[user-flow-menu-design]]) and
a11y ([[wcag-overlay-patterns]]) checks.
