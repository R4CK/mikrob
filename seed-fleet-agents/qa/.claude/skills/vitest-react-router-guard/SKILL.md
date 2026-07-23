---
name: vitest-react-router-guard
description: Write Vitest tests for React Router v6 auth/role guard components that render <Navigate>. Covers: infinite-redirect-loop pitfall, vi.hoisted mock pattern for useSession, nested vi.mock hoisting override, JSDOM aria-landmark pitfalls (<header> inside <main>), i18n translation value vs key mismatch. Trigger: "test a route guard", "test PortalAuthGuard / AuthGuard / PrivateRoute", "guard test hangs / infinite loop", "vi.mock useSession", "multiple elements with role banner", "getByRole banner fails".
---

# Vitest — React Router Guard Testing

## When to use
- Testing any component that renders `<Navigate>` based on auth/role state
- Testing guards that call `useSession()` / `useAuth()` and conditionally redirect
- Any guard test that hangs indefinitely (120s+ timeout)

## The core pitfall: infinite redirect loop

A guard rendered directly in `MemoryRouter` WITHOUT `<Routes>/<Route>` causes an
**infinite redirect loop**:

1. Guard renders `<Navigate to="/auth/verify?next=%2Fportal" replace />`
2. `MemoryRouter` updates location to `/auth/verify?next=%2Fportal`
3. Guard re-renders (still mounted, `isAuthenticated` prop unchanged)
4. New `location.pathname + location.search` = `/auth/verify?next=%2Fportal`
5. `next` param encodes to `%2Fauth%2Fverify%3Fnext%3D%252Fportal`
6. Guard renders `<Navigate to="/auth/verify?next=%2Fauth%2Fverify%3F...">`
7. Loop continues → 120s timeout / ENOMEM

**Wrong pattern (hangs):**
```tsx
// NEVER render a redirecting guard directly in MemoryRouter
await renderWithProviders(<PortalAuthGuard isAuthenticated={false} />, { route: '/portal' })
```

## The fix: always wrap in Routes/Route

```tsx
import { Routes, Route } from 'react-router-dom'

// Correct: guard only active on /portal/*, redirect unmounts it
const { container } = await renderWithProviders(
  <Routes>
    <Route path="/portal/*" element={<PortalAuthGuard isAuthenticated={false} />} />
  </Routes>,
  { route: '/portal' },
)
expect(container.textContent).toBe('')  // redirected -> nothing rendered
```

When the guard redirects to `/auth/verify?next=...`, `Routes` finds no matching
route and renders nothing. The guard unmounts and the loop never starts.

## Testing the "pass" case (outlet renders content)

Add a child route to verify the Outlet actually receives content:

```tsx
const { container } = await renderWithProviders(
  <Routes>
    <Route path="/portal/*" element={<PortalAuthGuard isAuthenticated={true} />}>
      <Route index element={<span>Portal content</span>} />
    </Route>
  </Routes>,
  { route: '/portal' },
)
expect(container.textContent).toContain('Portal content')
```

## Testing redirect destination

Add the target route to verify the redirect landed correctly:

```tsx
await renderWithProviders(
  <Routes>
    <Route path="/portal/*" element={<PortalAuthGuard isAuthenticated={false} loginPath="/auth/login" />} />
    <Route path="/auth/login" element={<span data-testid="login">Login page</span>} />
  </Routes>,
  { route: '/portal/dashboard' },
)
expect(screen.getByTestId('login')).toBeInTheDocument()
```

## Mocking useSession — use vi.hoisted (not async importOriginal)

`vi.mock` factories are hoisted before module initialization. `const mockFn = vi.fn()`
outside `vi.hoisted` causes `ReferenceError: Cannot access before initialization`.

```tsx
// Correct: vi.hoisted creates the variable in the hoisted scope
const { mockUseSession } = vi.hoisted(() => ({
  mockUseSession: vi.fn(() => null as ReturnType<typeof import('@/auth/session').useSession>),
}))

vi.mock('@/auth/session', () => ({
  useSession: mockUseSession,
  getSession: () => null,
  setSession: vi.fn(),
  clearSession: vi.fn(),
  subscribeSession: () => vi.fn(),
  parseRole: (v: unknown) => v,
  sessionFromVerifyResponse: () => null,
}))

afterEach(() => {
  mockUseSession.mockReset()
  mockUseSession.mockReturnValue(null)
})
```

Note: `async (importOriginal)` in the factory also works (used in LandingPage.test.tsx)
BUT can deadlock in some module graph configurations. Prefer the synchronous factory
above when mocking session — it's faster and never deadlocks.

## i18n key vs translated value mismatch

Tests run against the EN locale. Match the TRANSLATED value, not the i18n key.

```tsx
// BAD: key name ≠ translation
screen.getByRole('button', { name: /retry/i })   // key is 'common.retry'
// but t('common.retry') = "Try again"  -> test fails

// GOOD: use the actual EN translation
screen.getByRole('button', { name: /try again/i })
```

Check `packages/i18n/messages/en.json` for the actual string before writing
`getByRole` / `getByText` queries against translated content.

## RBAC gate testing with useSession

When a component gates UI on role (e.g. invite button only for admin/dispatcher):

```tsx
const { mockUseSession } = vi.hoisted(() => ({
  mockUseSession: vi.fn(() => ({ role: 'admin' as const })),  // default: admin
}))

beforeEach(() => {
  mockUseSession.mockReturnValue({ role: 'admin' })
})

afterEach(() => {
  vi.clearAllMocks()
  mockUseSession.mockReturnValue({ role: 'admin' })  // reset to safe default
})

// RBAC: admin sees the gate
it('admin sees invite button', async () => {
  mockUseSession.mockReturnValue({ role: 'admin' })
  // ... render and assert
  expect(screen.getByRole('button', { name: /invite/i })).toBeInTheDocument()
})

// RBAC: restricted role does not
it('crew_lead does NOT see invite button', async () => {
  mockUseSession.mockReturnValue({ role: 'crew_lead' })
  // ... render and assert
  expect(screen.queryByRole('button', { name: /invite/i })).toBeNull()
})
```

## Pitfalls

- **Hang with no mock at all**: even without mocking `useSession`, the component
  still calls it (real `useSyncExternalStore`). This does NOT cause a hang by itself.
  The hang is ALWAYS the redirect loop. Fix: `Routes`/`Route` wrapper.
- **`getByRole` ambiguity**: `/add zone/i` also matches "add zones later" (substring).
  Use word boundaries: `/\badd zone\b/i`.
- **Session shape**: `AuthSession` has NO `id` or `tenantId` fields. Valid roles:
  `admin | dispatcher | crew_lead | crew | inspector | warehouse | finance | client`.
  Mock with only fields that exist.
- **`renderWithProviders` uses `MemoryRouter`** (not `BrowserRouter`) — no actual
  navigation, but location still updates on `<Navigate>`, enabling the redirect loop.
- **Nested `vi.mock` inside `describe` OVERRIDES the outer mock for the whole file:**
  vitest hoists ALL `vi.mock()` calls to module top — even those inside `describe` blocks.
  A second `vi.mock()` for the same module in a nested scope replaces the first one,
  so ALL tests use the inner mock, not just the one test you intended.
  Fix: use ONE `vi.mock` at module level with a mutable variable, and override in the
  test body:
  ```tsx
  let nextScanPath = '/t/acme/a/eq-001'  // default for all tests
  vi.mock('@/features/scan/MobileAssetScanner', () => ({
    MobileAssetScanner: ({ onScan }: { onScan: (p: string) => void }) => (
      <button data-testid="mock-scanner" onClick={() => onScan(nextScanPath)}>scan</button>
    ),
  }))
  // In the individual test that needs a different value:
  nextScanPath = '/t/evil-tenant/a/eq-001'
  await user.click(screen.getByTestId('mock-scanner'))
  ```

## JSDOM ARIA landmark pitfalls

### `<header>` inside `<main>` still gets `role="banner"` in JSDOM

In real browsers, `<header>` has implicit `role="banner"` ONLY when it is NOT nested
inside `<main>`, `<article>`, `<section>`, `<aside>`, or `<nav>`. Nested headers get
`role="generic"`.

JSDOM / `aria-query` (used by testing-library) does NOT implement this context check —
ALL `<header>` elements get `role="banner"` regardless of nesting depth.

**Symptom:** `screen.getByRole('banner')` throws `Found multiple elements with the role
"banner"` — even though visually there is only one top-bar.

**Root cause:** A page-section header inside `<main>`:
```tsx
// Dashboard.tsx
return (
  <main className="db-page">
    <header className="db-header">   {/* ← this ALSO gets banner role in JSDOM */}
      <h1>...</h1>
    </header>
  </main>
)
```

**Fix — use `<div>` for page-section headers inside `<main>`:**
```tsx
// <div> has no implicit landmark role; semantically correct inside <main>
<div className="db-header">
  <h1>...</h1>
</div>
```

Only use `<header>` at the top level of the shell (one per page, outside `<main>`).
For section headers inside content areas, use `<div>` or a heading element directly.

## Verification

```bash
# Should complete in < 60s, NOT hang:
npx vitest run apps/web/src/features/client-portal/PortalAuthGuard.test.tsx --reporter=verbose
```
