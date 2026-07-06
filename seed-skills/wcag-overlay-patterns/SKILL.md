---
name: wcag-overlay-patterns
description: Build WCAG-AA accessible overlay components -- modal dialogs, bottom sheets, drawer panels, lightboxes -- with correct focus trap, aria-modal, role=dialog, Escape-to-close, safe-area-inset, and keyboard navigation. Also covers: WCAG fail-closed contrast gate for white-label runtime theming (useBrandingLoader pattern). Triggers: "modal", "dialog", "bottom sheet", "drawer", "lightbox", "overlay", "focus trap", "aria-modal", "accessible popup", "theming", "white-label", "WCAG contrast gate", "branding".
---

# WCAG Overlay Patterns

## When to use

Any time you build a component that:
- Opens as a layer over the current page (modal, drawer, sheet, lightbox, popover)
- Traps or constrains focus while open
- Should close on Escape or backdrop click

These components look simple but have 5+ accessibility requirements that are easy to miss. This skill captures the complete, tested pattern.

## Core requirements (WCAG 2.1 AA)

1. `role="dialog"` + `aria-modal="true"` -- signals to screen readers that content behind is inert
2. `aria-labelledby` pointing to the visible title element
3. **Focus trap**: when open, Tab and Shift+Tab cycle only within the overlay
4. **Initial focus**: on open, focus moves to the first focusable element inside the overlay
5. **Escape to close**: keydown listener on `document`
6. **Backdrop click to close**: the backdrop element has onClick; the dialog itself does NOT (avoids bubbling issues)
7. **Return focus on close**: on unmount, return focus to the element that triggered the open (advanced -- implement if the trigger element is known)

## Focus trap implementation

The canonical pattern (used in BottomSheet, DrawerPanel, PhotoLightbox):

```tsx
useEffect(() => {
  if (!open) return
  const el = containerRef.current
  if (!el) return

  // Collect focusable elements at open time (not reactive -- intentional)
  const focusable = el.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )
  focusable[0]?.focus()

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key !== 'Tab' || focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus() }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }

  document.addEventListener('keydown', onKeyDown)
  return () => document.removeEventListener('keydown', onKeyDown)
}, [open, onClose]) // re-runs if open/onClose change; NOT if children change
```

**Pitfall**: do NOT add `focusable` to the dependency array -- this would re-query and re-attach on every child render. Query once at open time; it's a snapshot, which is correct for a trap.

## JSX structure

```tsx
if (!open) return null   // early return pattern -- simpler than conditional render

return (
  <>
    {/* Backdrop: aria-hidden so screen readers ignore it */}
    <div
      className="overlay__backdrop"
      aria-hidden="true"
      onClick={onClose}
    />
    {/* Dialog: does NOT have onClick -- avoids propagation issues */}
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="overlay"
    >
      <h2 id={titleId}>{title}</h2>
      <button type="button" aria-label="Bezár" onClick={onClose}>✕</button>
      {children}
    </div>
  </>
)
```

**titleId**: generate once on mount with `useRef`:
```tsx
const titleId = useRef(`dialog-title-${Math.random().toString(36).slice(2)}`)
```
This avoids hydration mismatches and is stable across re-renders. Do NOT use `useState` for this -- no render needed.

## Variant: PhotoLightbox (no title, navigation keys)

Lightboxes differ: no visible title, navigate with arrow keys, initial focus on close button.

```tsx
const closeRef = useRef<HTMLButtonElement>(null)
const open = activeIndex != null && activeIndex >= 0 && photos.length > 0

useEffect(() => {
  if (!open) return
  closeRef.current?.focus()   // focus close button, not first focusable

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    if (e.key === 'ArrowLeft') { e.preventDefault(); prev() }
    if (e.key === 'ArrowRight') { e.preventDefault(); next() }
  }
  document.addEventListener('keydown', onKeyDown)
  return () => document.removeEventListener('keydown', onKeyDown)
}, [open, onClose, prev, next])

// aria: use aria-label (the photo alt) instead of aria-labelledby (no title element)
<div role="dialog" aria-modal="true" aria-label={photo.alt}>
```

Guard navigation at boundaries:
```tsx
const canPrev = open && activeIndex > 0
const canNext = open && activeIndex < photos.length - 1
// Only render prev/next buttons when canPrev/canNext is true
// Only call onNavigate if the direction is valid
```

## Mobile: safe-area-inset-bottom (PWA bottom sheets)

For bottom sheets on iOS/Android PWA standalone mode, the home bar overlaps content:

```css
.bottom-sheet {
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
```

`env(safe-area-inset-bottom, 0px)` -- the second argument is the fallback for browsers that don't support it. Always include it.

The bottom tab bar also needs this treatment:
```css
.bottom-tab-bar {
  padding-bottom: env(safe-area-inset-bottom, 0px);
  height: calc(56px + env(safe-area-inset-bottom, 0px));
}
```

## CSS animation pattern

```css
/* Backdrop */
.overlay__backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  animation: fade-in 150ms ease;
}

/* Bottom sheet */
.bottom-sheet {
  position: fixed; bottom: 0; left: 0; right: 0;
  animation: slide-up 200ms ease;
}

/* Drawer (right side) */
.drawer-panel {
  position: fixed; top: 0; right: 0; bottom: 0;
  animation: slide-in-right 200ms ease;
}

@keyframes fade-in   { from { opacity: 0 } to { opacity: 1 } }
@keyframes slide-up  { from { transform: translateY(100%) } to { transform: translateY(0) } }
@keyframes slide-in-right { from { transform: translateX(100%) } to { transform: translateX(0) } }
```

No `exit` animation needed for a simple implementation (the element unmounts immediately on `open=false`). Add exit animation only if explicitly requested.

## Vitest test checklist

Every overlay component needs these tests:

```
✓ renders null when closed (open=false / activeIndex=undefined)
✓ renders dialog when open
✓ has role="dialog" aria-modal="true"
✓ calls onClose on Escape keypress
✓ calls onClose on backdrop click
✓ calls onClose on close button click
✓ moves initial focus into the overlay on open
✓ [variant-specific] applies fullHeight/width prop correctly
✓ [lightbox] shows prev/next buttons only when canPrev/canNext
✓ [lightbox] calls onNavigate with correct index on ArrowLeft/Right
✓ [lightbox] does not call onNavigate at boundary (index 0 / last)
✓ [lightbox] shows counter only for multi-photo
```

Use `userEvent.setup()` (not `fireEvent`) for keyboard tests -- it correctly handles event sequencing.

## Pitfalls

- **`focusable` in dep array**: causes focus to reset on every child render inside the overlay. Query once at open time.
- **onClick on the dialog element**: if the dialog has onClick={onClose}, clicking inside content bubbles up and closes the sheet. Always put onClick only on the backdrop.
- **Missing aria-hidden on backdrop**: screen readers will read out the invisible backdrop div. Always add `aria-hidden="true"`.
- **`Math.random()` in titleId state**: if titleId is in useState, it generates a new ID on every re-render if the state is initialized with Math.random(). Use useRef instead.
- **No fallback in env()**: `env(safe-area-inset-bottom)` without a fallback returns empty string in unsupported browsers, breaking the CSS property. Always write `env(safe-area-inset-bottom, 0px)`.
- **Forgetting to return the cleanup**: the keydown listener MUST be removed in the useEffect cleanup, otherwise multiple listeners accumulate on re-render.
- **COMMIT-OR-CLEAN before declaring done (BINDING rule)**: If you have WIP component files that are untracked/unstaged alongside your finished files, they will break `tsc --noEmit` on the full workspace even if your own files are clean. Before any REVIEW/waiting move: either commit ALL related WIP files with pathspec, or delete/revert them. Never leave unstaged WIP that makes the full `tsc` red. Check: `git status` + `pnpm tsc --noEmit -p <workspace-tsconfig>` must both be clean on your scope.

## WCAG Contrast Gate for Runtime Theming (fail-closed)

Different from overlay a11y: this pattern applies BEFORE a tenant theme is applied
to the DOM. A white-label theming engine must BLOCK themes with bad contrast, not
just warn.

### The three mandatory WCAG AA pairs (mirror these in every context)
```ts
// 1. Text on primary brand button
checkContrast(tokens['--color-text-on-primary'], tokens['--color-brand-primary'], 'szöveg primary gombban')
// 2. Body text on page surface
checkContrast(tokens['--color-text-primary'], tokens['--color-surface-base'], 'fő tartalom')
// 3. Secondary text on page surface
checkContrast(tokens['--color-text-secondary'], tokens['--color-surface-base'], 'másodlagos szöveg')
// All must be >= 4.5:1 (WCAG AA). ratio=0 for unparseable color -> always fails -> always safe.
```

Keep these three pairs in sync across: the admin wizard UI gate, the `wcagGuard.ts`
runtime check, and the `validateBrandColors` server-side domain function. Divergence
means a theme can pass in one context and fail in another.

### `isWcagAACompliant` — the go/no-go gate
```ts
export function isWcagAACompliant(tokens: DesignTokenMap): boolean {
  return checkBrandingContrast(tokens).every((c) => c.passAA)
}
// checkBrandingContrast: runs the 3 pairs above, uses platform fallback defaults
// for ABSENT tokens (not for BAD tokens -- absent = safe, bad = fail-closed).
```

### `useBrandingLoader` — the correct runtime-theming pattern
```ts
export function useBrandingLoader(): void {
  const { setBranding } = useTenantTheme()
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/tenant/branding', { credentials: 'include' })
        if (!res.ok) return                         // non-2xx -> keep default
        const data: unknown = await res.json()
        if (!isTenantBranding(data)) return         // malformed -> keep default
        if (!isWcagAACompliant(data.tokens)) return // WCAG fail -> keep default (fail-closed)
        if (!cancelled) setBranding(data)           // only apply if WCAG passes
      } catch { /* network error -> keep default */ }
    }
    void load()
    return () => { cancelled = true }               // unmount guard
  }, [setBranding])
}
```

Key invariants:
- EVERY failure mode (network, parse, WCAG) keeps the platform default active
- `cancelled` guard prevents state updates after unmount
- `setBranding` only called once, only on the happy path

### Domain-layer publish gate (NOT just UI blocking)

The publish MUST also be fail-closed at the domain layer, not only in the UI:

```ts
export function publishDraft(draft, publishedBy, existingPublished, now): PublishResult {
  // Re-sanitize BEFORE WCAG check (defense in depth: reject hostile DB-mutated values)
  const cleanTokens = sanitizeTokens(draft.tokens)
  // Re-validate WCAG (reject even if valid at create time -- tokens could mutate)
  const validation = validateBrandColors(tokenMapToBrandColorInput(cleanTokens))
  if (!validation.allPassAA) throw new WcagValidationError('...', validation)
  // Only NOW set status=published
  return { published: { ...draft, tokens: cleanTokens, status: 'published', publishedAt: now } }
}
```

`WcagValidationError` carries the `BrandColorValidation` object so the API can
surface which pairs failed (client can highlight them). The UI's WcagGate is a
UX nicety; the domain throw is the real gate.

### Font-family tokens and the FONT_FAMILY_RE trap

Vendor-prefixed font names starting with `-` (like `-apple-system`) are NOT matched
by the FONT_FAMILY_RE whitelist in `@cleancore/brand-tokens`. They must be quoted:

```ts
// WRONG -- fails isSafeToken, token silently dropped
'--font-family-primary': "'Inter', system-ui, -apple-system, sans-serif"

// CORRECT -- -apple-system quoted
'--font-family-primary': "'Inter', system-ui, '-apple-system', sans-serif"

// OR simplify (recommended for platform defaults):
'--font-family-primary': "'Inter', system-ui, sans-serif"
```

Check any font stack against `isSafeToken` before putting it in platform defaults.
Run `tsc --noEmit -p packages/<pkg>/tsconfig.json` immediately after writing any
utility with type constraints (e.g. `exactOptionalPropertyTypes`).

## Verification

- Open overlay, press Tab repeatedly: focus cycles within overlay only
- Press Shift+Tab: cycles backward within overlay
- Press Escape: overlay closes
- Click backdrop: overlay closes
- Click inside overlay content: overlay stays open
- Check with axe-core or @testing-library/jest-axe: no violations on role, aria-modal, labelledby
- **Theming gate**: supply a theme with white-on-white primary (`#fff` on `#fff`) and verify `isWcagAACompliant` returns false, `useBrandingLoader` does NOT call `setBranding`, `publishDraft` throws `WcagValidationError`.
