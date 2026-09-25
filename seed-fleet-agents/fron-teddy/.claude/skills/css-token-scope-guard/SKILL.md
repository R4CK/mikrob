---
name: css-token-scope-guard
description: Fix and guard "undeclared CSS custom property" bugs in a flag-layered design system (v3 :root vs html[data-ds='v4'] blocks). Use when a bare var(--x) renders nothing (font-size inherits, spacing 0), when a QA gate reports a token that "exists somewhere" but not on the default root, or when adding a token guard. Covers scope-aware guard, transition-safe before/after measurement, and color-mix instead of rgb-triplet tokens.
---

# CSS token scope guard (fron-ted, cards 810b5bac / 1c15ff7b, 2026-09-02)

## When to use

- A stylesheet reads `var(--x)` without fallback and the computed value is empty on the
  default root (`getComputedStyle(document.documentElement).getPropertyValue('--x') === ''`).
- A guard must prove every bare `var(--x)` in `apps/web/src` points at a token that is live
  WHERE the reference is evaluated (not merely declared under a feature flag elsewhere).
- Someone proposes declaring `--color-x-rgb: "r, g, b"` to satisfy `rgba(var(--color-x-rgb), a)`.

## Procedure

1. Measure first, on the flag-off root: `getPropertyValue('--x')`; list consumers with
   `grep -rhoE "var\(--x\)" --include=*.css` (bare) vs `var\(--x,` (fallback -- those render
   their fallback today and CHANGE when you declare the token: report the delta).
2. Declare in `global.css :root` only aliases onto theme-fed tokens (`--color-surface-alt`,
   `--v3-hover`, `--shadow-card`, `--color-text-secondary`) or the values Peti approved; never a
   static colour that the ThemeProvider would not swap per tenant.
3. For alpha tints use `color-mix(in srgb, var(--color-x) N%, transparent)` at the call site;
   a `:root` rgb triplet lies for white-label tenants (see memory
   `a-static-rgb-triplet-token-lies-for-a-white-label-tenant`).
4. Guard (`styles/css-tokens-defined.test.ts` is the reference): walk braces, keep the selector
   stack; a declaration counts as unconditional only if no enclosing selector matches
   `[data-ds`; an unconditional bare reference needs an unconditional CSS declaration or a
   `'--x'` literal in .ts/.tsx (runtime injection); a reference under the flag may use a
   flag-scoped declaration. Add a vacuity check (flag-only tokens were seen) and a ratchet
   baseline that can only shrink -- WITH its `expect(stale).toEqual([])`.
5. Mutate every `it()` you touched: append a bare `var(--never-declared)` to a v3 sheet (must
   fail, named); put a declared token in the baseline (must fail). Restore with an absolute-path
   copy, then grep the mutant string is gone.
6. Before/after on live pages (headless Chromium, authed via the OAuth-callback fragment):
   before = tokens forced to `initial` inline on the root; after = removed; WAIT >= 500 ms
   between snapshots (transitions) and re-verify any fractional or viewport-varying delta on a
   fresh navigation before reporting it; assert `scrollWidth === innerWidth`.

## Pitfalls

- vite on /mnt/h serves a stale transform after edits: restart it (own pid, cwd verified).
- Edit test files with exact-string patches only; a regex spanning a newline swallowed the
  assertion below it once (QA FAIL round 3).
- "Declared somewhere" is not a scope statement; QA measured `--color-error` empty on v3 while
  the guard called the baseline empty.
- Do not run `cleancore-land.sh` (even --dry-run) on your own stack; that is MikroB's step.

## Verification

- Guard 4/4 green, both mutations red then restored; `git log <base>..HEAD -- <untouched file>`
  empty for anything you claim untouched; live root probe shows the token non-empty; REVIEW lists
  per-page changed-element counts and the fallback-site deltas.
