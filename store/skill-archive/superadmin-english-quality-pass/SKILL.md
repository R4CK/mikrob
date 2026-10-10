---
name: superadmin-english-quality-pass
description: Find and fix hardcoded (non-i18n-key) strings in apps/superadmin. Use when a hardcoded string is found in superadmin JSX/TS, or before gating a superadmin card to DONE. NOTE (Peti 10240, 2026-10-03): superadmin is NO LONGER English-only -- it has its own en+hu i18n system (card 09b112e3). Do not translate Hungarian strings into English; migrate every hardcoded string into an i18n key with BOTH locales filled in.
---

# Superadmin i18n Quality Pass

## When to use

- A hardcoded string literal (English or Hungarian) is found directly in `apps/superadmin/src/**/*.tsx|ts` JSX/text, instead of going through `useTranslation()`.
- QA or a gate finds a string that doesn't localize when the user switches `sa.locale`.
- Before gating a superadmin card to DONE.

## Background (read before using an older copy of this skill)

Peti's decision 10240 (2026-10-03, see memory `mopsion-superadmin-hu-en-decision`) **reversed** the earlier English-only convention. Card 09b112e3 landed a real i18n system for superadmin:

- `@mopsion/i18n`'s `SUPERADMIN_LOCALES` = `['en', 'hu']` (NOT the 7-locale tenant-facing set).
- Catalogs live at `packages/i18n/messages/superadmin/en.json` and `.../hu.json`.
- `apps/superadmin/src/i18n/setup.ts` wires them via `useTranslation()`; default locale is `hu` (Peti's preference), with the user's own saved choice (`sa.locale` in localStorage) taking priority, falling back to browser language.

**Do NOT grep for Hungarian accented characters and translate them to English.** That was the old (now-wrong) procedure. A Hungarian string found directly in JSX is not "policy drift" to purge -- it's a hardcoded string that was never routed through an i18n key, and now has NO English counterpart either. The fix in both directions is the same: move it into the i18n catalog.

## Procedure

### 1. Find hardcoded string literals (either language) in superadmin JSX

A hardcoded string is JSX text content, a literal prop value (`title="..."`, `placeholder="..."`, `aria-label="..."`), or a literal passed to an alert/toast — anything NOT going through `t('namespace.key')`.

```bash
grep -rn '[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]' apps/superadmin/src/ --include='*.tsx' --include='*.ts'
```

This still catches Hungarian literals (useful signal — they can only have gotten in by being typed directly, since the i18n catalog round-trips through `t()`), but is NOT the only class to check: a plain English hardcoded string shows exactly the same bug and this grep is blind to it. For those, visually scan touched files for string literals in JSX/props that are not `t(...)` calls.

### 2. For each offending string, add an i18n key to BOTH locale files

```json
// packages/i18n/messages/superadmin/en.json
"myNamespace": { "myKey": "English text" }

// packages/i18n/messages/superadmin/hu.json
"myNamespace": { "myKey": "Magyar szöveg" }
```

Follow the existing namespace structure (do not invent a new top-level namespace for a string that belongs under an existing page/feature namespace). Keep key names in English, values in each respective language.

### 3. Replace the hardcoded literal with `t('myNamespace.myKey')`

```tsx
// before
<button>Mégsem</button>
// or
<button>Cancel</button>

// after
const { t } = useTranslation()
<button>{t('myNamespace.cancel')}</button>
```

### 4. Currency / number formatting

Still locale-aware, now via the ACTIVE i18n locale rather than `navigator.language` directly:

```tsx
{new Intl.NumberFormat(i18n.language, {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
}).format(valueInCents / 100)}
```

### 5. Run the superadmin i18n parity guard (card a2cf692b)

```bash
npx vitest run packages/i18n/__tests__/superadmin-messages.test.ts
```

This enforces 0 key-parity gaps between `superadmin/en.json` and `superadmin/hu.json` — every key added to one MUST be added to the other in the same commit.

### 6. Verify no hardcoded literals remain in the touched files

```bash
grep -n '[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]' apps/superadmin/src/<touched-file>.tsx
```

Must return nothing in JSX/prop text (comments are fine — see Buktatók).

### 7. TypeScript check

```bash
cd apps/superadmin && npx tsc --noEmit 2>&1 | tail -5
```

Must return 0 errors.

## Buktatók

- **Comments can contain Hungarian or English freely** — they're not user-facing. Grep for JSX string literals and prop values, not comments; use `-n` with visual inspection to confirm context.
- **CLAUDE.md / doc strings** are not user-facing — skip them.
- **Module catalog arrays** often have all labels in one array — add the whole array's keys to both locale files in one pass rather than one-by-one.
- **Count/pluralization**: use i18next's plural/ICU forms (see `packages/i18n/__tests__/messages-icu.test.ts` for the pattern apps/web already uses), not a hand-rolled "works for all counts" English string — Hungarian pluralization differs from English and a shared literal breaks one of the two locales.
- **Busy/loading states**: check `busy ? t('ns.working') : t('ns.confirm')` patterns — both branches need keys in both locales.
- **Do not delete a Hungarian string you find** — add its English counterpart and route both through `t()`. Deleting it (the old procedure) throws away real content and does not fix the underlying hardcoding bug.

## Verification

- Zero non-`t()` string literals in the touched files' JSX/props (comments excluded).
- `superadmin-messages.test.ts` (card a2cf692b) green — 0 key-parity gaps between en/hu.
- `tsc --noEmit` (apps/superadmin) 0 errors.
- No i18n test regressions in `packages/i18n/__tests__/`.
