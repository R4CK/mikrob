---
name: css-rule13-guard-and-fix
description: Build a vitest CI guard for Rule-13 touch-target compliance (min-height >= 44px at BASE CSS rule level), then do a comprehensive batch fix of all violations found. Use when QA returns touch-target failures or when adding a systemic guard to prevent the class from recurring.
---
# CSS Rule-13 Touch-Target Guard + Bulk Fix

## When to use
- QA FAIL citing touch-target < 44px on buttons/tabs/inputs across multiple files.
- Adding a CI guard to prevent future Rule-13 violations (end whack-a-mole).
- After any sweep where you've fixed one file, to find what else is broken.

## Procedure

### 1. Create the vitest guard (Node env required)

Put the guard in `apps/web/src/styles/rule13-touch-target.test.ts`:
- First line MUST be `// @vitest-environment node` (otherwise `import.meta.url` has no `file://` scheme)
- Use `fileURLToPath(new URL('..', import.meta.url))` to get the `src/` root
- Walk ALL `.css` files recursively
- Parse BASE-level rules only (skip `@media/@keyframes/@supports/@layer/@font-face` blocks by tracking brace depth)
- Strip CSS comments before parsing (they can contain `{` characters)
- Flag any rule where:
  - Selector contains an interactive class (`-btn` at end/start, or `-tab`/`-input`/`-select`/`-close`/`-toggle`/`-trigger`/`-action` at END, BEM `__` variants too)
  - Block has `padding:` or `padding-top`/`padding-bottom:` (sizing signal), OR has explicit `height: NNpx < 44`
  - Block has NO `min-height` >= 44px (also check `height` >= 44px as equivalent)
  - `var(...)` values are trusted (unknown at parse time)
- Skip false positives:
  - **Child element targets**: last token after combinator is a non-interactive HTML tag (e.g. `.icon-btn svg` → `svg` is non-interactive, skip)
  - **Spinner/compound non-interactive**: `-btn-` in class name but ends with `-spinner`, `-icon`, `-label`, `-text`, `-arrow`, `-dot`, `-indicator`, `-loading` → not a button
  - **Native form controls with delegated touch area**: `TOUCH_TARGET_DELEGATED` set — checkbox/radio inputs whose touch area comes from a wrapping `<label>` (identified by `accent-color` in block or explicit exclusion list). Apply at outer loop level to catch `cursor:pointer` path too.

### 2. Run the guard to collect violations

```bash
npx vitest run apps/web/src/styles/rule13-touch-target.test.ts 2>&1 | grep "features/\|components/\|styles/"
```

Collect the list into a violations map: `{file: [classes]}`.

### 3. Bulk fix with Python script

Write a Python script that:
- For each `(file, class_anchor)` pair, scans the CSS string
- Uses brace-counting to verify the class is at depth 0 (not inside @media)
- Inserts `min-height: 44px;` after the first `padding:` line, matching indentation
- Skips if `min-height:` already exists (bug: also check if value < 44px — bump it)

Key bugs to avoid:
- **Substring match**: searching `.wop-tab` finds `.wop-tab-list` first. Use exact class boundary: `css.find(search)` then verify no ` ` or `-` follows.
- **min-height < 44px treated as OK**: the script must check `>= 44px`, not just presence.
- **Indentation detection**: detect indent from first non-empty, non-comment line in the block.

### 4. Handle remaining violations manually

After the bulk fix, re-run the guard. Remaining violations fall into categories:
- **Value too low** (`min-height: 34px`, `38px`, `40px`): simple `old_string → new_string` Edit.
- **Substring match missed**: find the class in context, add `min-height: 44px;` after `padding:`.
- **global.css violations**: always audit the diff before staging (another agent may have unstaged changes).

### 5. Commit (shared checkout — NEVER git add -A)

```bash
git add apps/web/src/styles/rule13-touch-target.test.ts \
        apps/web/src/styles/global.css \
        apps/web/src/components/[changed].css \
        apps/web/src/features/**/[changed].css
git commit -m "feat(fe): Rule-13 touch-target guard + comprehensive min-height audit ..."
```

## Buktatók

- **jsdom vs node**: vitest default is `jsdom`, where `import.meta.url` returns `about:blank`. Force `// @vitest-environment node`.
- **Substring hit**: `.wop-tab` search hits `.wop-tab-list` — fix by anchoring to word-boundary or checking the char after the match is `{`, ` `, `,`, `:`, `.`.
- **@media depth counting**: `before.count('{') - before.count('}')` works for well-formed CSS with no comments that contain braces. Strip comments first.
- **global.css staged by another agent**: run `git diff apps/web/src/styles/global.css` before staging. Unstage if foreign changes are included.
- **False positives — child selectors**: `.icon-btn svg` targets the SVG, not the button. Add `isChildElementTarget()`: if selector has a combinator and last token is a non-interactive HTML tag, skip.
- **False positives — spinner inside btn**: `.wsr-btn-spinner` has `-btn-` in the middle but it's a CSS animation spinner. Check: if class contains `-btn-` and ends with `-spinner`/`-icon` etc., it's NOT interactive.
- **False positives — native controls**: `accent-color` in block = native checkbox/radio. Touch area comes from `<label>`. Add to `TOUCH_TARGET_DELEGATED` and apply check BEFORE the interactive predicate (at outer loop level) — not just in `isInteractiveBySelector`, because `cursor:pointer` would still trigger `isInteractiveByBlock`.
- **Toggle switch tracks**: track element uses `inset:0` filling the label. Fix: add `cursor:pointer` + `min-height:44px` to the LABEL (`.pa-toggle`/`.st-toggle`), change track from `inset:0` to `top:50%;transform:translateY(-50%);height:20px` (preserves visual, label provides touch area).
- **tab-badge/-list/-panel**: decorative, not interactive. Only flag when `-tab` is at the END of the class name.

### Icon buttons (`height: NNpx` without padding)

For buttons sized with `width` + `height` (close buttons, icon buttons, swatches): add BOTH `min-height: 44px` AND `min-width: 44px`. The guard catches these via `hasExplicitSmallHeight()` — regex on `height: NNpx` where N < 44, skips `var()` values.

Pattern:
```css
/* before */
.fw-close { width: 32px; height: 32px; ... }
/* after */
.fw-close { width: 32px; height: 32px; min-height: 44px; min-width: 44px; ... }
```

### Commit in single shell call

`git add` and `git commit` MUST be in the same Bash tool call. If run in separate calls, the staging area resets between shell instances and commit fails with "no changes added to commit".

## Ellenőrzés

After bulk fix:
```bash
npx vitest run apps/web/src/styles/rule13-touch-target.test.ts
# expect: Tests 1 passed
```
