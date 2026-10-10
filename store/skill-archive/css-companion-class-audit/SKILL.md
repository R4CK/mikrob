---
name: css-companion-class-audit
description: Before writing a companion CSS file for a page component, determine which classes are already available (global or shared CSS) vs which need new definitions. Prevents "class undefined, element unstyled" bugs. Trigger: "write the CSS for this page", "companion CSS", "page CSS file is missing", "which classes need defining".
---

# CSS Companion Class Audit

## When to use
- Before writing or extending a `.css` companion file for a page or component.
- When a page uses CSS classes but you're not sure which ones are already defined globally.
- When a QA fail or visual bug shows elements unstyled despite correct className usage.
- When converting a new page from inline `style={{}}` to externalized CSS classes.

## Core problem
In a React app with a global CSS file plus per-page companion files, a class can live in:
1. **Global shared CSS** — available everywhere, no re-definition needed.
2. **Feature-level shared CSS** — available to all components in the same feature folder that import it.
3. **Companion CSS** — the page's own `.css` file, only available when that file is imported.
4. **Parent-imported CSS** — a child component has no own CSS import but relies on the parent page to import the shared CSS first.

Writing a class that already exists globally wastes lines and can cause specificity conflicts. Omitting a class that only exists in a sibling's companion file causes silent styling failures.

## Procedure

### 1. Inventory all classNames used on the page
```bash
grep -oP "className=\"[^\"]+\"" PageName.tsx | sort -u
# Or for dynamic classNames:
grep -n "className" PageName.tsx | head -40
```

### 2. For each class, grep the global CSS first
```bash
grep -n "\.className-here" apps/web/src/styles/global.css
# Or the equivalent global stylesheet path in your project
```
- **Found** → class is globally available, do NOT redefine it in the companion file.
- **Not found** → continue to step 3.

### 3. Check feature-level shared CSS files
```bash
# Check shared CSS files in the same feature folder (e.g. Shell.css, Page.css, Feature.css):
grep -n "\.className-here" apps/web/src/features/FEATURE/*.css
```
- **Found in a file the page imports** → available, no re-definition needed.
- **Found in a file the page does NOT import** → add the import, OR redefine in companion.
- **Not found anywhere** → must be defined in the companion CSS file.

### 4. Build the companion file with ONLY the missing classes
Write only the classes from step 3 that are not already defined. Pattern:
```css
/* PageName.css — page-specific styles only.
   Global classes (global.css) are NOT redefined here. */

.my-page-specific-class {
  /* ... */
}
```

### 5. Verify no orphan classes remain
After writing the companion, grep the TSX for classNames and cross-check each against both global and companion CSS:
```bash
grep -oP "(?<=className=\")[^\"]+(?=\")" PageName.tsx | tr ' ' '\n' | sort -u | while read cls; do
  found=$(grep -rn "\.$cls[^-]" apps/web/src/styles/global.css apps/web/src/features/FEATURE/*.css 2>/dev/null | wc -l)
  [ "$found" -eq 0 ] && echo "ORPHAN: $cls"
done
```
Any `ORPHAN:` output = class used in TSX but defined nowhere. Add it to the companion CSS.

## Common patterns (what usually lives where)

### Typically global (do NOT redefine):
- Generic form classes: `.form`, `.form__field`, `.form__label`, `.form__input`, `.form__error`, `.form__actions`
- Button variants: `.btn-primary`, `.btn-ghost`, `.btn-danger`
- Navigation/breadcrumb: `.breadcrumb`, `.breadcrumb__back`
- Success/error/empty states: `.form-success`, `.form-success__icon`, `.empty-state`
- Loading skeleton: `.skeleton`, `.skeleton--line`
- Alert variants shared across features

### Typically per-page (always define in companion):
- Page wrapper/root: `.page`, `.page__title`, `.page__header`
- Alert in a specific color/context not covered by global
- Button size modifiers not in global (`btn-sm`, `btn-xs`)
- Layout primitives specific to this page's form shape

### Typically in feature-level shared CSS (check before redefining):
- Shell/wrapper styles (`Shell.css`, `PartnerShell.css`)
- Component card patterns shared within one feature
- Status chip styles specific to a domain (active/suspended, pending/done)

## Pitfall: the "Works in sibling, broken here" trap
If page A and page B are in the same feature folder, and page A defines `.my-class` in `PageA.css`, page B CANNOT use `.my-class` unless it imports `PageA.css` (bad) or redefines it (correct). Shared classes between sibling pages belong in a feature-level shared CSS file, not one page's companion.

## Pitfall: parent-page CSS inheritance for child components
A child component (e.g. `CalendarSyncCard.tsx`) may have no CSS import of its own and rely entirely on the parent page (`SettingsPage.tsx`) importing a shared CSS file. This is intentional when:
- The child is always rendered inside the same parent.
- The child's classes are defined in a file the parent imports.
This pattern is acceptable but fragile if the component is ever reused elsewhere. When extracting a reusable component, add a CSS import to the component itself.

## Verification checklist
- [ ] Every className in the TSX is defined in global CSS, feature CSS, or the companion file
- [ ] No class in the companion CSS already exists in global CSS (check with grep)
- [ ] Companion file is imported at the top of the TSX: `import './PageName.css'`
- [ ] `tsc --noEmit` passes (no TS errors from the import)
- [ ] Visual inspection: all styled elements render correctly
