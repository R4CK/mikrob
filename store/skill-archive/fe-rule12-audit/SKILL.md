---
name: fe-rule12-audit
description: >
  Systematic frontend Rule 12 audit: detect phantom buttons, phantom form fields,
  SVG placeholders instead of real images, demo data in real API calls, and silent
  error swallowing. Use when auditing a frontend page or before marking a card done.
---

# Frontend Rule 12 Audit Patterns

Patterns learned from the CleanCore STITCH audit sweep (2026-08-08, fron-ted).
Rule 12: no phantom actions, no fake data, no silent data loss.

## When to use

- Before marking any FE card done
- When auditing a page as part of the STITCH sweep
- When reviewing a PR that touches UI interactions or form submissions
- When "demo" or "DEMO_" appears in a page's grep output

## Pattern 1: Photo placeholder (SVG instead of real img)

**What to look for:**
```tsx
// BUG: objectKey in key prop but SVG rendered
{allMedia.map((m) => (
  <div key={m.objectKey}>
    <svg><path d="M23 19..." /></svg>   // camera placeholder -- bug!
  </div>
))}

// FIX: use thumbnailUrl()
import { thumbnailUrl } from './proofPhotoApi.js'
<img src={thumbnailUrl(m.objectKey)} alt="" className="..." loading="lazy" />
```

**Grep:**
```bash
grep -n "M23 19\|camera\|IconCamera\|svg.*objectKey\|objectKey.*svg" pages/
```

**Verify:** The `key` prop uses the objectKey but no `<img src={...objectKey...}>` exists in the same loop.

**Pattern found in:** FieldChecklistRunPage, ChecklistRunDetailPage

---

## Pattern 2: Phantom form fields

**What to look for:** A field is:
- Rendered in the form (UI collects it)
- Validated (blocks submit when missing)
- But NOT included in the submit payload

**Grep:**
```bash
# Find state variables that appear in input onChange but not in the submit body
grep -n "setState\|set[A-Z]\|handleSubmit\|createX\|updateX" Page.tsx
```

**Verify by cross-referencing:**
1. List all `useState` calls → field state variables
2. Find the submit handler → what goes into the API body
3. Find the backend handler → what fields does it accept?
4. Any field present in (1) but absent from (2) or (3) is phantom

**Examples found:**
- `NewSitePage`: areaSqm, timezone, zones -- collected, validated, but backend only accepts name/address/geofence
- `FormBuilderEditorPage`: `name` -- required by UI, stored in session-local map, never sent to backend (backend domain has no name field)

**Fix:** Either send the field (if backend supports it) or replace the input with an honest info note.

---

## Pattern 3: Phantom buttons / dead links

**What to look for:**
```tsx
// BUG: href="#" with preventDefault -- does nothing
<a href="#pdf" onClick={(e) => e.preventDefault()}>Download PDF</a>

// BUG: onClick that's a no-op
<button onClick={() => {}}>Download</button>

// FIX: disabled with honest tooltip
<button disabled aria-disabled="true" title={t('common.comingSoon')}>
  Download PDF
</button>
```

**Grep:**
```bash
grep -n "href=\"#\"\|onClick.*preventDefault\|onClick.*{}\|onClick.*noop" pages/
```

**Pattern found in:** PortalBizDetail (PDF download), various forms

---

## Pattern 4: DEMO_* constants in real API calls

**What to look for:**
```tsx
// BUG: demo constant in real custody write
apiReturn(assetId, DEMO_WAREHOUSE_ID)      // hardcoded demo ID!
apiConsume(DEMO_LOT_ID, 1)                  // hardcoded!
apiIssueToCrew(assetTypeId, DEMO_CREW_ID, 1)  // hardcoded!
```

**Grep:**
```bash
grep -n "DEMO_\|demo_\|FAKE_\|MOCK_ID\|hardcoded" apps/web/src/features/
```

**Distinguish:** DEMO_* used only in a clearly-labelled demo/fallback block is OK.
DEMO_* passed as arguments to real API calls (apiReturn, apiConsume, apiFetch...) is a bug.

**Pattern found in:** AssetScanPage (card 689033cd)

---

## Pattern 5: Silent error swallowing

**What to look for:**
```tsx
// BUG: catches and discards real errors
listClients().catch(() => {})  // user sees no feedback if clients fail to load

// OK: explicit fallback with user-visible consequence
listClients().catch(() => {
  setClientError(t('clients.loadError'))  // user knows what failed
})
```

**Grep:**
```bash
grep -n "\.catch.*{}\|\.catch.*() => {}" apps/web/src/features/
```

**Assess severity:** Swallowed error with a visible downstream failure (e.g., "client required" on submit) is LOW. Swallowed error that silently shows wrong data is HIGH.

**Pattern found in:** BidBuilderPage (`listClients().catch(() => {})`)

---

## Pattern 6: Stale "route not deployed" error handling

**What to look for:**
```tsx
// BUG: uses 404 as "feature not deployed yet" instead of real error
.catch((err) => {
  if (err.status === 404) {
    // show demo data  // BUG: 404 is a real error now that the backend exists!
    setDemoMode(true)
  }
})

// FIX: 404 on a real endpoint is an error
.catch((err) => {
  if (err.status === 0) setOffline(true)     // network failure
  else setError(t('page.loadError'))         // real API error including 404
})
```

**Trigger:** A page has a demo mode that activates on 404.
**Verify:** Does the backend endpoint actually exist now? If yes, 404 means "not found", not "not deployed".

**Pattern found in:** FieldTodayPage, ClockInPage (both fixed 2026-08-07)

---

## Verification checklist per page

For each page under audit, run:

1. `grep -n "DEMO_\|demo_\|FAKE_\|MOCK_ID" Page.tsx` -- check all DEMO constants
2. `grep -n "objectKey\|thumbnailUrl\|displayUrl" Page.tsx` -- verify photo display
3. `grep -n "href=\"#\"\|catch.*{}" Page.tsx` -- check phantom buttons and swallowed errors
4. Cross-reference all `useState` field vars against the submit body AND backend handler
5. Update the STITCH-IMPL-MATRIX.md row with audit results

## Output format for STITCH matrix

```
AUDITED YYYY-MM-DD (fron-ted): Nnn lines, [wired/not-wired status], [findings or "no bugs"].
```

If a bug is fixed:
```
AUDITED + FIXED YYYY-MM-DD (fron-ted, card XXXXXXXX): description of the bug and fix.
```

## Matrix hygiene (learned 2026-08-08)

After auditing a batch of pages, the STITCH-IMPL-MATRIX.md rows must be updated IN THE SAME SESSION.
Do not defer to a "backfill later" -- a future compaction will summarize the audit as "clean" but the
matrix row will still say "not deep-audited", requiring another session to reconcile.

**Rule:** whenever a page passes rule-12 audit or a bug is fixed, update the matrix row immediately.

**New page built this session:** Add a matrix row in the correct surface section, commit alongside
the implementation commit. Use the `(d) route+no-design` status when no Stitch V2 reference exists.

**Orphan designs:** if you implement a route that resolves an "orphan design" row in the matrix,
update that orphan row to say "now implemented" and update the summary count.

---

## Pitfalls

- `IconCamera` in a disabled "take photo" button is NOT a photo placeholder bug -- it's an honest UI for future functionality
- `DEMO_*` constants in a clearly-labelled `if (isDemoMode)` block are OK
- `name || id` as a display fallback is honest if `name` is genuinely optional in the domain model
- A `.catch(() => {})` that's followed by another mechanism (e.g., form validation) may be LOW severity
- "MikroB: skip on uncertain mockup-vs-code" means the DESIGN comparison was skipped, NOT the rule-12 audit. Always do the rule-12 check regardless of the Stitch reference quality.
- Pages audited in a prior session but not noted in the matrix will show up as an audit gap in future sessions. Update the matrix row immediately, even for trivially-clean pages.
