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

### 2b. Action-button RBAC capability verification (BLOCKING — for any write/action button)
Before wiring an ACTION button (claim, approve, assign, delete, invite, ...), verify
the target **actor role actually holds the required RBAC Action** in `rbac.ts` /
`RBAC_MATRIX`. A button whose backend action the user's role can't reach is a
**dead action** (rule 9): it renders, the user clicks, the server fail-closes (403),
and the feature is product-level non-functional even though the FE code + tests are green.

```bash
# What Action gates the endpoint, and which roles have it?
grep -rn "<Action>\b" packages/control-plane/src/rbac.ts   # e.g. SchedulesWrite
# -> confirm the actor role (Crew, CrewLead, ...) is in RBAC_MATRIX[role] for that Action
```
If the actor role lacks the capability: STOP and escalate to MikroB — it needs an
RBAC decision (new scoped Action, or the button is manager-only), NOT a silent ship.
Real case (F1 open-shift): the crew "claim" button was wired to `SchedulesWrite`
(admin+dispatcher only) — every crew claim 403'd. Fix was a new `ShiftClaim` action
granted to crew, decided before the FE could close. Gate on the *Action → role* grant,
not on the button rendering.

### 2c. Endpoint readiness has FOUR states, not two (BLOCKING — check before deciding wire-vs-gate)
A "needs-build" comment in the FE (§ Needs-build endpoint pattern below) can be **stale in
either direction**: the backend may have shipped since the comment was written (wire it),
or the backend may look done but isn't actually reachable yet (gate it, don't wire it).
`grep`-ing `route-policy.ts` alone answers neither question — a route can be POLICIED
without being CODED, CODED without being MOUNTED, and MOUNTED-in-source without being
CONFIGURED at runtime. Walk all four before wiring:

```bash
# 1. POLICIED — an authz entry exists (says nothing about whether it works)
grep -n "'/sites/:id'" apps/api/src/route-policy.ts

# 2. CODED — a real handler function exists (not a stub/no-op)
grep -n "export function updateSiteHttp" apps/api/src/sites-write.ts

# 3. MOUNTED — router.register() actually wires the handler to the path
grep -n "router.register('PATCH', '/sites/:id'" apps/api/src/http-guard.ts

# 4. CONFIGURED — if the mount is conditional, is the dependency actually set in server.ts?
grep -n "if (deps\.workOrderProofPresign)" apps/api/src/http-guard.ts   # the conditional
grep -rn "workOrderProofPresign" apps/api/src/server.ts                # is it ever assigned?
```

Step 4 is the trap that's easy to miss: `router.register` can appear inside an
`if (deps.someAdapter)` block for a route that reads as "done" in a REVIEW comment
("mounted only when a presigner is configured"), while `server.ts` never actually
constructs that adapter — the route is real code, gated by config, and simply isn't
live in this deployment. Building FE for it produces the exact "advertises a surface
nobody can reach" defect the backend explicitly avoided on its own side. Two real
cases from the same session: `PATCH /sites/:id` was POLICIED+CODED+MOUNTED+unconditional
→ safe to wire (only the FE was stale). `POST /work-orders/:id/proof/presign` was
POLICIED+CODED+MOUNTED-but-conditional, and `grep -rn "workOrderProofPresign"
apps/api/src/server.ts` returned nothing → NOT safe to wire yet, despite a backend
REVIEW comment describing the endpoint in full. When state 4 fails: leave the FE gated
(§ Needs-build pattern below), note in the card which of the 4 states blocks it, and
don't re-check until a NEW backend card confirms the adapter is configured.

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

### 3a. Cursor/keyset pagination: Load More pattern

When the BE endpoint returns `{ items, nextCursor }` (keyset newest-first), accumulate pages in state and append on "Load More". Do NOT use offset (`page`, `skip`) with a cursor endpoint — they're different pagination contracts.

```typescript
// API client (cursor endpoint)
export function listConversations(
  cursor?: string | null,
  limit = 50,
): Promise<ApiResourceCursorPage> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  return apiFetch<ApiResourceCursorPage>(`/api/v1/conversations?${params.toString()}`)
}

// Component state
const [items, setItems] = useState<DisplayItem[]>([])
const [nextCursor, setNextCursor] = useState<string | null>(null)
const [loading, setLoading] = useState(true)
const [loadingMore, setLoadingMore] = useState(false)
const [error, setError] = useState<string | null>(null)

// Initial load
const load = useCallback(() => {
  setError(null)
  setLoading(true)
  listConversations(null, 50)
    .then(({ items, nextCursor }) => {
      setItems(items.map(toDisplayItem))
      setNextCursor(nextCursor)
      setLoading(false)
    })
    .catch((err: unknown) => {
      setError(t('feature.loadError'))
      setLoading(false)
    })
}, [t])

useEffect(() => { load() }, [load])

// Load More (append)
const loadMore = useCallback(() => {
  if (!nextCursor || loadingMore) return
  setLoadingMore(true)
  listConversations(nextCursor, 50)
    .then(({ items: newItems, nextCursor: nc }) => {
      setItems((prev) => [...prev, ...newItems.map(toDisplayItem)])
      setNextCursor(nc)
      setLoadingMore(false)
    })
    .catch(() => {
      // Load More errors are non-fatal: don't wipe the list
      setLoadingMore(false)
    })
}, [nextCursor, loadingMore])
```

```tsx
{/* Load More button — only when more pages exist */}
{!loading && nextCursor && (
  <button
    type="button"
    onClick={loadMore}
    disabled={loadingMore}
    className="load-more-btn"
  >
    {loadingMore ? t('common.loading') : t('common.loadMore')}
  </button>
)}
```

**Pitfall — cursor state reset on retry:** If the user hits Retry after an error, call `load()` (the initial load function, cursor=null), NOT `loadMore()`. `load()` resets cursor and replaces items; `loadMore()` appends from the current cursor. Mixing them duplicates entries.

**Pitfall — optimistic append vs. real-time:** If new items can arrive server-side (e.g. a new message was sent), a "load more older" cursor (newest-first) will NOT show new items — refresh with `load()` to reset to the latest page.

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

## Detail view (fetch-by-ID, no demo fallback)

When the page fetches a single entity by URL param (`useParams`), NOT a list, there is
**no demo/offline fallback** -- an offline detail view has no meaningful cached state.
Use the nonce pattern below with explicit cleanup:

- `loading` starts `true` (shows skeleton/loading message immediately).
- On error: show `role="alert"` + retry button (no demo data).
- On success: render entity fields.
- On not-found (404): show `role="status"` notAvailable message, not an error alert.

The test file omits the `offline` describe block for detail views. Instead add a
`not-found` test:
```typescript
it('shows notAvailable status when API returns 404', async () => {
  vi.mocked(api.getEntity).mockRejectedValue(new ApiError(404, null, 'Not found'))
  await renderWithProviders(<EntityDetailPage />)
  await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
})
```

If you need to distinguish 404 (not found) from 5xx (server error), use:
```typescript
.catch((err: unknown) => {
  if (!cancelled) {
    if (err instanceof ApiError && err.status === 404) {
      setVisit(null); setLoading(false)  // stays on "notAvailable" branch
    } else {
      setErr(true); setLoading(false)    // shows error+retry
    }
  }
})
```
Otherwise, a simpler "all errors → error state" is fine for detail views where 404
is unexpected (the parent list page only links to valid IDs).

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

## HttpOnly cookie auth shell pattern (SUBCON-4 tanulság)

When a portal (e.g. partner/subcontractor) uses HttpOnly cookies for session (set by the server, not readable by JS), the FE cannot check auth state by reading `localStorage` or a cookie value. Correct pattern:

```tsx
// PartnerShell.tsx -- auth probe on mount
useEffect(() => {
  listAssignedWork()           // any authenticated endpoint works as a probe
    .then(() => setAuthState('authed'))
    .catch(() => {
      setAuthState('unauthed')
      navigate('/partner/login')
    })
}, [])
```

Rules:
- The probe call MUST be a real endpoint the session cookie authenticates (any 200 = session valid, any error = redirect to login)
- `clearPartnerToken()` / "logout" client-side is a **no-op** for HttpOnly cookies -- only a server-side `POST /v1/partner/auth/logout` (which clears the cookie via `Set-Cookie: ...; Max-Age=0`) actually logs out
- `credentials: 'include'` is required on every fetch so the browser sends the cookie automatically
- NEVER attempt to read the cookie with `document.cookie` -- HttpOnly cookies are not accessible from JS by design

QA gate check:
```bash
# 1. credentials: include on every partner fetch?
git show <sha>:apps/web/src/features/subcontractor/*Api.ts | grep "credentials"
# Expect: credentials: 'include'

# 2. No Authorization header on partner calls (would be null/undefined from unreadable cookie)?
git show <sha>:apps/web/src/features/subcontractor/*Api.ts | grep "Authorization"
# Expect: 0 results on partnerFetch

# 3. Logout is server-side?
git show <sha>:apps/web/src/features/subcontractor/PartnerShell.tsx | grep "clearPartnerToken\|logout\|cookie"
# If clearPartnerToken() is a no-op comment explaining why -> PASS
# If it tries document.cookie manipulation -> finding (ineffective)
```

## Pitfalls
- **Non-breaking space in format strings:** If an existing function has `'\xa0'` (U+00A0), the Edit tool may fail to match. Fix: use Python `open(...).read().replace(old, new)` to do the byte-level replace.
- **Shell cwd reset after dangerouslyDisableSandbox:** Always use absolute paths in subsequent commands.
- **`useState(null)` breaks optimistic mutations:** Guard every `setItems` call with `prev === null ? null : ...` to avoid overwriting null with stale data when the component is still loading.
- **`undefined` locale is NOT a violation:** `toLocaleDateString(undefined, opts)` means "browser default locale" — acceptable. Only hardcoded locale strings like `'hu-HU'` or `'hu'` are violations.
- **Network errors are TypeError, NOT `ApiError(status=0)`:** The else branch (non-ApiError) catches them correctly alongside 404. Guard: `err instanceof ApiError && err.status !== 404` for real errors; else = demo.
- **Offline fallback for 404+network only:** 5xx/400 must show error state, never demo.
- **Adapter pattern for shape mismatches:** If the real API shape lacks a field the UI component requires, add an adapter function (`toDisplayItem()`) that inserts the missing field as an empty default. Do NOT modify the UI component to handle `undefined`.
- **Keyset cursor != offset:** cursor-paginated endpoints return `nextCursor`, NOT `page`/`total`. Passing `page=2` to a keyset endpoint silently returns nothing or the first page again. Always check the BE handler to confirm which pagination contract it uses before writing the API client.
- **Load More cursor reset on retry:** when the user retries after a load error, call the initial load function (cursor=null, items replaced), NOT the load-more function (which appends from a stale cursor). Mixing them creates duplicate rows.
- **Duplicate testid in modal error zones:** A modal with both a load-error section (above the form) and a submit-error section (inside the form) will have BOTH visible at the same time when loading fails. Give them different testids (`modal-load-error` vs `modal-submit-error`). The test for the load-error case should use the load-error testid specifically.
- **"REVIEW says it's done" ≠ live:** a backend REVIEW comment describing a finished endpoint can still be conditionally mounted on an unconfigured adapter (§ 2c). Grep `server.ts` for the dependency, not just `http-guard.ts` for the route.

## Gate-comment exhaustion before posting REVIEW

When re-opening a card that has gate comments (QA FAIL / Cybersec NO-GO / Cybered NO-GO / MikroB
reconciliation):

1. **Read ALL gate comments** — oldest first. Extract EVERY separate requested change as a concrete
   item: file path + exact old value → new value. Do NOT rely on the card description or title;
   the comments contain the precise requirements that previous attempts may have partially missed.

2. **Distinguish crash-fix from value-fix.** A gate may have two distinct requirements: (a) "fix the
   crash/404 fallback" AND (b) "change the fallback value from X to Y for fail-closed". Fixing (a)
   does NOT implicitly satisfy (b). Track each as a separate checkbox.

3. **Verify the exact change is in the commit before posting REVIEW:**
   ```bash
   # Confirm the specific value change is in the HEAD commit, not just in the description:
   git show HEAD:<file> | grep "<new-value>"
   # If output is empty: the change was NOT committed. Do not post REVIEW.
   ```

4. **Gate-specific artifact**: include the commit SHA and the exact diff line in the REVIEW comment,
   e.g. `billingApi.ts:179 access changed from 'full' to 'billing_only' (commit dea6457)`. This
   lets the gate verify a specific diff, not a description.

Anti-pattern (card 21f07ea6, 2026-07-25): fron-ted posted "Bug already fixed" after a crash-fix
commit, but the gate's second requirement (changing `access:'full'` to `access:'billing_only'` for
fail-closed semantics) was never committed. Tests were green (the crash was fixed), but the gate
requirement was distinct. Lesson: green tests ≠ all gate requirements satisfied.

## Mutation with hardcoded demo-ID interception: form-phase pattern

When a write API call currently passes **hardcoded DEMO_\* constants** as real API arguments,
intercept with a **form-phase**: extend the phase state machine so the button opens a form that
collects the real ID(s), then call the real API on submit.

Full pattern with component code, test template, and i18n checklist:
`references/mutation-form-phase.md`

## Verification
- [ ] Pre-ship i18n gate passed (grep shows no hardcoded locale)
- [ ] `tsc --noEmit` exits 0
- [ ] All tests green (loading / success / error / 403 / offline)
- [ ] No demo data shown on 5xx (role=alert visible, no data table)
- [ ] All gate-comment requirements verified in committed code (git show HEAD:<file> | grep <value>)
- [ ] Retry button calls the API a second time (`toHaveBeenCalledTimes(2)`)
- [ ] `aria-busy="true"` on loading wrapper, `role="alert"` on error state
