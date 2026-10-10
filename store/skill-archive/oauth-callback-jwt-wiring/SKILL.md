---
name: oauth-callback-jwt-wiring
description: Wire an OAuth callback page that receives a JWT in the URL fragment. Covers fragment reading, history erasure, session init, AND setApiToken (the non-obvious part that breaks all authenticated API calls if missed). Trigger: "OAuth callback", "Google login FE", "OAuthCallback", "social login callback page".
---
# OAuth Callback JWT Wiring

## When to use
- Building or reviewing a client-side OAuth callback page (e.g. `/auth/oauth/callback`).
- The backend delivers a JWT in the URL fragment: `#token=<JWT>` / `#error=<code>`.
- The page must handle: success, user-cancel, server-error, and malformed-JWT flows.

## The critical non-obvious step: BOTH session AND Bearer token

A completed OAuth login needs **two** pieces of state:

| Store | What it holds | Used for |
|-------|--------------|----------|
| `auth/session.ts` (`setSession()`) | Decoded JWT claims (role, tenantSlug, userId, exp) | UI routing, role-based visibility |
| `api/tokenStore.ts` (`setApiToken()`) | Raw JWT string | `Authorization: Bearer` header in every API call |

**Missing `setApiToken()`** = the user sees `/dashboard` (UI session set) but EVERY authenticated API call returns 401, and the 401 handler logs them out. The OAuth login appears to work but fails on the first real API call. This is a **rule-9 flow-connectivity break**, not a security issue.

## Procedure

### 1. Read token from fragment (NEVER from query string)

```tsx
const hashParams = new URLSearchParams(location.hash.slice(1))
const errorCode = hashParams.get('error')
const token = hashParams.get('token')
```

The fragment (`#`) is **not sent to servers** in the Referer header — no token leak.

### 2. Erase the fragment immediately after reading

```tsx
history.replaceState(null, '', window.location.pathname + window.location.search)
```

Call this synchronously before any async work. This prevents the JWT from lingering in browser history.

### 3. Decode JWT and set BOTH stores

```tsx
const session = sessionFromPasswordLoginJwt(token) // decode -> AuthSession
if (session === null) { setState('error'); return }

setSession(session)

// CRITICAL: also wire the raw JWT into the Bearer-token source
const expiresInMs = session.expiresAt !== undefined
  ? Math.max(0, session.expiresAt - Date.now())
  : 3_600_000  // fallback 1h if exp unavailable
setApiToken(token, expiresInMs)

setState('success')
```

Note: in CleanCore, JWT `exp` is already in **milliseconds** (not Unix seconds) — see `session.ts:129`.

### 4. Error flow

```tsx
if (errorCode !== null) {
  history.replaceState(...)  // erase fragment even on error
  setState(USER_CANCEL_CODES.has(errorCode) ? 'denied' : 'error')
  return
}
if (!token) { setState('error'); return }
```

### 5. Open-redirect guard for ?next=

```tsx
const fallback = getSession()?.role === 'client' ? '/portal' : '/dashboard'
const target = safeInternalPath(params.get('next'), fallback)
```

The `?next=` guard stays in the query string — NOT the fragment.

## Tests that must exist

```tsx
it('sets the API Bearer token after a successful OAuth login', async () => {
  await renderWithProviders(<OAuthHarness />, {
    route: `/auth/oauth/callback#token=${VALID_TOKEN}`,
  })
  await waitFor(() => expect(getSession()).not.toBeNull())
  expect(getApiToken()).not.toBeNull()  // this is the non-obvious regression guard
})

it('erases the fragment from browser history after reading the token', async () => {
  const replaceSpy = vi.spyOn(history, 'replaceState')
  await renderWithProviders(...)
  await waitFor(() => expect(getSession()).not.toBeNull())
  expect(replaceSpy).toHaveBeenCalledWith(null, '', expect.not.stringContaining('#'))
})

it('malformed JWT is NOT a login (fail-closed)', async () => {
  await renderWithProviders(<OAuthHarness />, { route: '/callback#token=notvalid' })
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(getSession()).toBeNull()
  expect(getApiToken()).toBeNull()
})
```

## Buktatók

- **Missing `setApiToken()`**: the most common miss. Session sets UI state, but Bearer source stays null -> 401 on every API call after login.
- **Fragment NOT erased**: JWT lingers in browser history, visible to JS extensions.
- **Erasing too late**: do `replaceState` BEFORE any async `await` to prevent the fragment from being bookmarked.
- **?next= in fragment**: `next` must stay as a query param (`?next=...`) not in the hash.
- **JWT exp units**: in CleanCore, `exp` is in ms (not Unix seconds). Check your project's session.ts convention.
- **Gate trap**: QA can pass on the committed code even if `setApiToken` is missing, because unit tests mock the session and don't verify end-to-end API call authorization. The RedHat gate's flow-connectivity check catches this.

## Ellenőrzés

- `getApiToken()` is non-null in the test after successful login (non-vacuous guard)
- `history.replaceState` called with no `#` in the URL (fragment erasure)
- Fail-closed: malformed JWT / unknown role -> error state, no session, no Bearer token
- i18n guard clean (no `toLocaleString('hu-HU', ...)` in the component)
- CSP guard clean (no `style={}` in the component)
