---
name: rule13-touch-target-compliance
description: Fix and pre-empt Rule 13 touch target violations (min 44px on all interactive elements at every breakpoint). QA FAIL pattern: tab/button components with padding-only sizing that shrinks on mobile. Triggers: "QA FAIL touch target", "min-height 44px", "Rule 13 mobile", "touch target too small", "tab button sizing".
---

# Rule 13 Touch Target Compliance

## When to use
- QA returns FAIL citing touch-target <44px on a button, tab, or interactive element.
- Pre-ship review: any element with `role="tab"`, `role="button"`, or `<button>` that uses only padding for height.
- Any responsive CSS where a mobile breakpoint overrides padding to reduce it (creating a shrink path).

## The violation pattern

```css
/* WRONG — height determined only by font-size + padding */
.some-tab {
  padding: 6px 14px;
  font-size: 13px;
  /* No min-height. At 13px * 1.2 line-height + 12px = ~27.6px — well under 44px */
}

/* Mobile breakpoint SHRINKS it further */
@media (max-width: 600px) {
  .some-tab {
    padding: var(--space-2);  /* smaller — now maybe 35px total */
  }
}
```

## The fix

Add `min-height: 44px` to the BASE rule. If a mobile breakpoint also overrides padding, add it there too.

```css
/* CORRECT */
.some-tab {
  padding: 6px 14px;
  min-height: 44px;           /* <-- add this */
  font-size: 13px;
}

@media (max-width: 600px) {
  .some-tab {
    padding: var(--space-2);
    min-height: 44px;         /* repeat if mobile breakpoint re-declares padding */
  }
}
```

## How to audit a file

```bash
# Find all button/tab classes without min-height
grep -n "\.some-class" File.css
# Check: does it have min-height? Does any @media override remove it?
```

## Real cases in this codebase

- `SiteDetail.css` → `.sd2-tab`: base had no min-height; mobile breakpoint removed padding. Fixed: `min-height: 44px` in BOTH base and mobile breakpoint (commit `f792ecc`).
- `ClientRequestsPage.css` → `.cp-req-tab`: base had `padding: 6px 14px` only. No mobile override. Fixed: `min-height: 44px` in base only (commit `400f0d2`).

## Pre-emption checklist (before submitting to QA)

For every interactive element (button, tab, link acting as button):
- [ ] `min-height: 44px` on the base CSS rule
- [ ] Any `@media` override that reduces padding → re-declare `min-height: 44px`
- [ ] Verify in browser DevTools: computed height ≥ 44px at mobile viewport (375px width)

## Gotchas

- `padding-based tabs` with `display: flex; align-items: center` — the flex alignment centers the text but does not guarantee 44px height. Add `min-height: 44px` explicitly.
- `border-bottom: 2px` tabs with `margin-bottom: -1px` — the border offset doesn't add to touch area. Min-height still required.
- `font-size` alone cannot guarantee the target — e.g. `16px * 1.5 line-height = 24px`, still under 44px.
- **Circular icon buttons** (`border-radius: 50%`) are the most common hidden violation: they use explicit `width: Npx; height: Npx` instead of padding, which hides the miss. Example: `.bal-close-btn { width: 40px; height: 40px; }` — 40px < 44px, QA FAIL. Fix: replace with `min-width: 44px; min-height: 44px;` (CSS min-* wins over explicit height when min > height). The visual size stays 40×40 only if the content forces it; use `width: 44px; height: 44px` to also fix the visual size. Real case: `BeforeAfterLightbox.css` `.bal-close-btn` gated as QA FAIL (2026-07-16).
