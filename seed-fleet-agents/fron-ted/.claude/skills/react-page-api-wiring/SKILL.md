---
name: react-page-api-wiring
description: Wire a React page from demo/stub data to a real REST API endpoint. Covers typed API client creation, state management pattern (loading/error/data), rule 12 error handling (descriptive i18n error + retry), PWA offline fallback, pre-ship i18n gate, and matching test file. Trigger: "wire this page to the real API", "remove demo fallback", "replace demo data with real API", "hook up GET /api/...", "replace DEMO_ imports".
---

# React Page API Wiring

## When to use
- A page currently renders from demo/stub data (DEMO_* constants or hardcoded arrays) and a real backend endpoint exists.
- You need to replace a catch-block demo fallback on non-network errors (5xx should NOT show demo data per rule 12).
- You need to add loading skeleton + descriptive error+retry to a page that currently has none.

## Procedure

### 1. Audit the current page
- Identify which DEMO_* imports are used and which endpoint they substitute.
- Check if the page has a real API call already or only demo data.
- Note the fallback policy: 404/network → demo; 403 → forbidden error; 5xx/400 → error+retry. Network errors are TypeError (not ApiError), so the non-ApiError else-branch catches them the same way as 404.

### 2. URL contract verification (BLOCKING — do this BEFORE writing featureApi.ts)
Grep the backend route-policy or handler file for the EXACT path before hard-coding it:

```bash
# Find what the backend actually mounts
grep -r "performance\|reviews\|<resource>" \
  apps/api/src \
  packages/*/src \
  --include="*.ts" \
  -l | head -5

# Then read the specific route-policy / handler to confirm the path:
# Example: if you see route-policy.ts, check:
#   GET /workers/:id/performance     <- NOT /performance/summary
#   GET /workers/:id/reviews         <- NOT /performance/reviews
```

**Common trap**: a nested resource (`/workers/:id/reviews`) is NOT the same as
`/workers/:id/performance/reviews`. Always compare against the source file, not
a guess from the domain name. A wrong URL hard-codes a 404 into the page — it
won't surface until the HTTP server is live.

### 3. Create a typed API client file (`featureApi.ts`)
```typescript
// Flow-connectivity manifest (rule 9):
//   GET /api/<resource>     -> listResources()   [wired]
//   GET /api/<resource>/:id -> getResource()     [wired]

import { apiFetch } from '@/api/client'

export interface ApiResource {
  readonly id: string
  readonly tenantId: string
  // ... other fields from the real API shape
}

// For offset-paginated endpoints:
export interface ApiResourcePage {
  items: ApiResource[]
  total: number
  page: number
  limit: number
}

// For cursor-paginated endpoints (BE uses keyset/cursor pagination — verify with the BE source):
export interface ApiResourceCursorPage {
  items: ApiResource[]
  nextCursor: string | null
  limit: number
}

export function listResources(opts?: { page?: number; limit?: number }): Promise<ApiResourcePage> {
  const params = new URLSearchParams()
  if (opts?.page) params.set('page', String(opts.page))
  if (opts?.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return apiFetch<ApiResourcePage>(`/api/resource${qs ? '?' + qs : ''}`)
}

export function getResource(id: string): Promise<ApiResource> {
  return apiFetch<ApiResource>(`/api/resource/${encodeURIComponent(id)}`)
}
```

**IMPORTANT:** Use `encodeURIComponent` on path segments. Never interpolate raw user input into URLs.

If the API shape has a field missing that the UI component needs, write an adapter:
```typescript
export function toDisplayItem(a: ApiResource): DisplayItem {
  return { ...a, missingField: [] }  // empty default
}
```

### 3. State pattern in the page component
```typescript
// Replace: const [items, setItems] = useState(DEMO_ITEMS)
// With:
const [items, setItems] = useState<DisplayItem[] | null>(null)
const [loading, setLoading] = useState(true)
const [error, setError] = useState<string | null>(null)

const load = useCallback(() => {
  setError(null)
  listResources({ limit: 100 })
    .then((page) => { setItems(page.items.map(toDisplayItem)); setLoading(false) })
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 403) {
        setError(t('feature.loadErrorForbidden'))
        setItems([])
      } else if (err instanceof ApiError && err.status !== 404) {
        // Real backend failure (5xx, 400) — show error state, never demo.
        setError(t('feature.loadError'))
        setItems([])
      } else {
        // 404 OR network failure (TypeError — NOT ApiError(status=0)): demo fallback.
        setItems(DEMO_ITEMS.map(toDisplayItem))
      }
      setLoading(false)
    })
}, [t])

useEffect(() => { load() }, [load])
```

**Rule: NO demo data on 5xx.** The CORRECT demo-fallback guard is: 404 or non-ApiError (TypeError = network failure) → demo; 403 → forbidden error; other ApiError (5xx, 400) → error state.
Network errors throw `TypeError`, NOT `ApiError(status=0)` — the `else` branch (non-ApiError) catches them correctly, exactly like the 404 case.

For optimistic UI mutations (retire, reactivate, etc.), guard for `null`:
```typescript
setItems((prev) => prev === null ? null : prev.map(...))
```

### 4. Render the three states

```tsx
{/* Loading */}
{loading && (
  <div aria-busy="true" aria-label={t('common.loading')}>
    <div className="skeleton" style={{ height: 48 }} />
    <div className="skeleton" style={{ height: 240 }} />
  </div>
)}

{/* Error */}
{!loading && error && (
  <div role="alert">
    <p>{error}</p>
    <button type="button" onClick={load}>{t('common.retry')}</button>
  </div>
)}

{/* Data */}
{!loading && !error && items !== null && (
  items.length === 0
    ? <EmptyState />
    : <DataTable rows={items} />
)}
```

KPI tiles that depend on loaded data: show `'…'` while loading:
```tsx
<KpiTile value={items === null ? '…' : String(items.length)} />
```

### 5. i18n error keys
Add to ALL supported locales (every file in `packages/i18n/messages/`):
```json
{
  "feature": {
    "loadError": "Failed to load <feature>. Please try again.",
    "loadErrorForbidden": "You do not have permission to view <feature>."
  }
}
```

### 6. Pre-ship i18n gate (BLOCKING — run before REVIEW)

**6a. Hardcoded locale check:**
```bash
grep -rnE "to(LocaleDateString|LocaleTimeString|LocaleString)|Intl\.(NumberFormat|DateTimeFormat)|'hu-HU'|\"hu-HU\"|'hu'" <changed files>
```
Any hardcoded locale string = blocking bug. Fix before moving to REVIEW.

**6b. Missing i18n key check (NEW — prevents QA FAIL on raw key rendered to user):**
```bash
# Extract every t('key') and t("key") call from the page:
grep -oP "t\(['\"]([^'\"]+)['\"]\)" <PageFile>.tsx | grep -oP "['\"][^'\"]+['\"]" | tr -d "'\"" | sort -u > /tmp/used_keys.txt

# Check each key exists in en.json (naive: grep for each key):
while IFS= read -r key; do
  # Convert dot-path to search pattern: "common.forbidden" -> grep for "forbidden"
  last=$(echo "$key" | rev | cut -d. -f1 | rev)
  if ! grep -q "\"$last\"" packages/i18n/messages/en.json; then
    echo "MISSING KEY: $key"
  fi
done < /tmp/used_keys.txt
```
Any `MISSING KEY` output = add the key to ALL locale files before REVIEW.

**The most common trap (cost us 2 QA rounds):** Using `t('common.forbidden')` in a new page when `common.forbidden` doesn't exist in ANY locale file. The i18n library silently renders the raw key string `"common.forbidden"` — localization failure that QA always catches.

Remedy: after adding i18n keys, confirm with:
```bash
grep -r '"forbidden"' packages/i18n/messages/ | wc -l  # must equal number of supported locales
```

Replace hardcoded locale calls:
```typescript
// BAD:
new Intl.NumberFormat('hu-HU').format(n)
value.toLocaleString('hu-HU')

// GOOD:
import { isValidLocale } from '@cleancore/i18n'
const locale = isValidLocale(i18n.language) ? i18n.language : 'en'
new Intl.NumberFormat(locale).format(n)
```

### 7. Remove unused DEMO_* imports
After wiring, check for leftover DEMO_* imports and remove them. Exception: offline PWA fallback may legitimately keep one DEMO_ import.

## Test template
Create `FeaturePage.test.tsx` alongside the page:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Routes, Route } from 'react-router-dom'
import { renderWithProviders } from '@/test/renderWithProviders'
import { FeaturePage } from './FeaturePage'
import { ApiError } from '@/api/client'

vi.mock('./featureApi.js', () => ({
  listResources: vi.fn(),
}))

import * as featureApi from './featureApi.js'

const MOCK_DATA = { items: [/* ... */], total: 1, page: 1, limit: 100 }

beforeEach(() => { vi.mocked(featureApi.listResources).mockReset() })

describe('loading', () => {
  it('shows loading skeleton while pending', async () => {
    vi.mocked(featureApi.listResources).mockReturnValue(new Promise(() => {}))
    await renderPage()
    expect(screen.getByLabelText('Loading…')).toHaveAttribute('aria-busy', 'true')
  })
})

describe('success', () => {
  it('renders data after load', async () => {
    vi.mocked(featureApi.listResources).mockResolvedValue(MOCK_DATA)
    await renderPage()
    await waitFor(() => screen.getByText('expected-text'))
    expect(screen.getByText('expected-text')).toBeInTheDocument()
  })
})

describe('error', () => {
  it('shows i18n error + retry on 5xx', async () => {
    vi.mocked(featureApi.listResources).mockRejectedValue(new ApiError(500, null, 'Error'))
    await renderPage()
    await waitFor(() => screen.getByRole('alert'))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('retry re-fetches', async () => {
    const user = userEvent.setup()
    vi.mocked(featureApi.listResources)
      .mockRejectedValueOnce(new ApiError(500, null, 'Error'))
      .mockResolvedValue(MOCK_DATA)
    await renderPage()
    await waitFor(() => screen.getByRole('alert'))
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => screen.getByText('expected-text'))
    expect(featureApi.listResources).toHaveBeenCalledTimes(2)
  })

  it('shows forbidden message on 403', async () => {
    vi.mocked(featureApi.listResources).mockRejectedValue(new ApiError(403, 'FORBIDDEN', ''))
    await renderPage()
    await waitFor(() => screen.getByRole('alert'))
    // Check for i18n forbidden message
  })
})

describe('offline', () => {
  it('shows demo/cached data on status=0 (PWA fallback)', async () => {
    vi.mocked(featureApi.listResources).mockRejectedValue(new ApiError(0, null, 'Network error'))
    await renderPage()
    // Verify demo data renders without an error alert
    await waitFor(() => screen.queryByRole('alert') === null)
  })
})
```

## Retry nonce pattern (alternative to useCallback load)
When the component already has complex `useEffect` deps that make a `useCallback`-based `load()` harder to wire, use a retry nonce instead:
```typescript
const [retryNonce, setRetryNonce] = useState(0)

useEffect(() => {
  let cancelled = false
  setLoading(true)
  setError(null)
  fetchData()
    .then(data => { if (!cancelled) { setData(data); setLoading(false) } })
    .catch(() => { if (!cancelled) { setError(t('feature.loadError')); setLoading(false) } })
  return () => { cancelled = true }
}, [id, retryNonce])  // retryNonce dep triggers re-fetch when incremented

// Retry button:
<button type="button" onClick={() => setRetryNonce(n => n + 1)}>{t('common.retry')}</button>
```
Both approaches are valid; the nonce pattern avoids the need for `useCallback` when `t` or other context deps would otherwise cause infinite loops.

## Modal with async data loading pattern

When a modal needs data from multiple endpoints before it can render its form (e.g. "Start Run" needing both template list + site list):

```typescript
function handleOpenModal() {
  setError(''); setShowModal(true); setLoading(true)
  Promise.all([apiFetchA(), apiFetchB()])
    .then(([a, b]) => {
      setDataA(a); setDataB(b)
      if (a.length > 0) setSelectedA(a[0].id)   // default selection
      if (b.length > 0) setSelectedB(b[0].id)
      setLoading(false)
    })
    .catch(() => {
      setError(t('feature.modal.loadError'))
      setLoading(false)
    })
}
```

Modal JSX structure — TWO distinct error zones, TWO distinct testids:
```tsx
{/* 1. Load-error zone (outside the form, shows when parallel-fetch fails) */}
{!loading && loadError && (
  <div role="alert" data-testid="modal-load-error">{loadError}</div>
)}
{/* 2. Form — renders even when loadError is set (shows empty selects + the load error above) */}
{!loading && (
  <form onSubmit={handleSubmit}>
    <select disabled={submitting}>
      {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
    {/* Submit-error zone (inside the form, shows on POST failure) */}
    {submitError && (
      <div role="alert" data-testid="modal-submit-error">{submitError}</div>
    )}
    <button type="submit" disabled={submitting || loading}>{t('common.submit')}</button>
  </form>
)}
```

**CRITICAL:** NEVER use the same `data-testid` for both the load-error div and the submit-error div. When `loading=false` and a load error is set, the form also renders — both error elements appear simultaneously, causing `findByTestId` to fail with "multiple elements" or timeout. Use distinct testids: `modal-load-error` + `modal-submit-error`.

## Auth redirect sinks (open-redirect security pattern)

When a component navigates after a successful login/auth flow (`window.location.href = value`), ALWAYS route the destination through `safeInternalPath()` before assigning — even if the value comes from the server response body:

```typescript
// BAD — trusts raw server response body
window.location.href = (body as { next?: string }).next ?? nextPath

// GOOD — routes through same-origin guard (mirror Verify.tsx pattern)
window.location.href = safeInternalPath((body as { next?: string }).next, nextPath)
```

`safeInternalPath(raw, fallback)` uses `new URL(raw, window.location.origin)` to check same-origin; rejects `https://evil.com`, `//evil.com`, `javascript:*`, etc. and returns `fallback`.

**Regression test pattern** — replace `window.location` without triggering jsdom navigation:

```typescript
let savedLocation: Location
beforeEach(() => {
  savedLocation = window.location
  Object.defineProperty(window, 'location', {
    value: { href: '', origin: 'http://localhost' },
    writable: true,
    configurable: true,
  })
})
afterEach(() => {
  Object.defineProperty(window, 'location', {
    value: savedLocation,
    writable: true,
    configurable: true,
  })
})

it('rejects external https body.next', async () => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ next: 'https://evil.com' }) })
  // ... render + submit ...
  await waitFor(() => expect((window.location as { href: string }).href).toBe('/dashboard'))
})
```

Required test cases for every auth redirect sink:
- `'https://evil.com/steal'` → fallback `/dashboard`
- `'javascript:alert(1)'` → fallback `/dashboard`
- `'//evil.com'` → fallback `/dashboard`
- `'/safe/path'` → accepted as-is

## Needs-build endpoint: feature-flag guard pattern

When a UI button or link points to a BE endpoint that is **needs-build** (not yet implemented),
DO NOT leave a dead-end (404 zsákutca). This is a Rule 9 violation and a QA FAIL.

Correct approach: hide the element behind a single-file constant flag.

```typescript
// In the component file, after imports:
// Flip to true when GET /v1/auth/oauth/google backend is live (needs-build card: <card-id>).
const GOOGLE_OAUTH_ENABLED = false

// In JSX, wrap the unreachable element:
{GOOGLE_OAUTH_ENABLED && (
  <>
    <div className="ln-oauth-divider" aria-hidden="true">
      <span>{t('auth.or')}</span>
    </div>
    <a href="/v1/auth/oauth/google" className="ln-oauth-btn">
      {t('auth.continueWithGoogle')}
    </a>
  </>
)}
```

Rules for this pattern:
- The constant is `false` until the BE card ships and is gate-passed.
- Name it `<FEATURE>_ENABLED` so a grep shows all pending feature flags in one go.
- The comment must name the card ID so the flip is traceable.
- When the BE card is done: one-line flip to `true`, remove the comment.
- DO NOT use `ENABLED=false` to silently remove a feature — it must still appear in the flow as `[needs-build]` in the IA artifact and have a planned BE card.
- Alternative for non-interactive elements (links, hrefs): hide the entire parent section, not just the `href`. A visible-but-disabled link is acceptable for discoverability if you add `aria-disabled="true"` and prevent navigation.

When to use vs. when NOT to use:
- USE: button/link with no connected BE endpoint yet.
- DO NOT USE: a feature you want to permanently hide (delete it). DO NOT USE when the BE exists but returns empty (show empty state instead). DO NOT USE for auth-gated features (use RBAC, not a constant).

## Pitfalls
- **Non-breaking space in format strings:** If an existing function has `'\xa0'` (U+00A0), the Edit tool may fail to match. Fix: use Python `open(...).read().replace(old, new)` to do the byte-level replace.
- **Shell cwd reset after dangerouslyDisableSandbox:** Always use absolute paths in subsequent commands.
- **`useState(null)` breaks optimistic mutations:** Guard every `setItems` call with `prev === null ? null : ...` to avoid overwriting null with stale data when the component is still loading.
- **`undefined` locale is NOT a violation:** `toLocaleDateString(undefined, opts)` means "browser default locale" — acceptable. Only hardcoded locale strings like `'hu-HU'` or `'hu'` are violations.
- **Network errors are TypeError, NOT `ApiError(status=0)`:** The else branch (non-ApiError) catches them correctly alongside 404. Guard: `err instanceof ApiError && err.status !== 404` for real errors; else = demo.
- **Offline fallback for 404+network only:** 5xx/400 must show error state, never demo.
- **Adapter pattern for shape mismatches:** If the real API shape lacks a field the UI component requires, add an adapter function (`toDisplayItem()`) that inserts the missing field as an empty default. Do NOT modify the UI component to handle `undefined`.
- **Duplicate testid in modal error zones:** A modal with both a load-error section (above the form) and a submit-error section (inside the form) will have BOTH visible at the same time when loading fails. Give them different testids (`modal-load-error` vs `modal-submit-error`). The test for the load-error case should use the load-error testid specifically.

## Verification
- [ ] Pre-ship i18n gate passed (grep shows no hardcoded locale)
- [ ] `tsc --noEmit` exits 0
- [ ] All tests green (loading / success / error / 403 / offline)
- [ ] No demo data shown on 5xx (role=alert visible, no data table)
- [ ] Retry button calls the API a second time (`toHaveBeenCalledTimes(2)`)
- [ ] `aria-busy="true"` on loading wrapper, `role="alert"` on error state
