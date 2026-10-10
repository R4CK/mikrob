---
name: be-endpoint-param-extension
description: Extend an existing REST endpoint with a new optional enum/typed param that routes to a second code path — backward compat, strict allowlist, injection-proof, gated by the same existing lock/guard. Triggers: "add repo param", "extend endpoint with mode", "add a second code path to existing handler", "new param same endpoint", "backward-compat endpoint extension".
---

# BE Endpoint Param Extension (Backward-Compat, Strict Allowlist)

## When to use
- An existing endpoint does one thing. Now it must do a SECOND, related thing.
- The second thing shares the same auth/guard/preflight as the first.
- The caller chooses which path via a new body param: `{ mode: 'a' | 'b' }`.
- The first callers must keep working unchanged (default to old behavior).

## When NOT to use
- The two operations have different auth requirements → separate endpoint.
- The new operation is significantly more dangerous → separate endpoint + RBAC.
- You have more than 2-3 variants → REST resource model (POST /resource?type=X).

## Procedure

### 1. Identify the extension point

Find where the existing handler parses its body:
```bash
grep -n "readBody\|JSON.parse\|body\." src/web/routes/<handler>.ts
```
You will add your new param parse ALONGSIDE the existing one — one `JSON.parse`, one structured type, all defaults set.

### 2. Parse and validate with strict allowlist

Parse the body ONCE. Return 400 for any value outside the allowlist.

```typescript
let existingParam = false          // existing param keeps its type+default
let newParam: 'option-a' | 'option-b' = 'option-a'   // default = backward-compat
try {
  const buf = await readBody(ctx.req)
  if (buf.length > 0) {
    const parsed = JSON.parse(buf.toString()) as { existing?: unknown; newParam?: unknown }
    existingParam = parsed.existing === true
    if (parsed.newParam === 'option-b') {
      newParam = 'option-b'
    } else if (parsed.newParam !== undefined && parsed.newParam !== 'option-a') {
      // Reject unknown values immediately — never silently default
      json(res, { error: 'Invalid newParam. Must be "option-a" or "option-b".', reason: 'invalid-param' }, 400)
      return true
    }
  }
} catch { /* empty/invalid body → defaults */ }
```

**Why return 400 for unknown values?** A caller sending `{ newParam: "admin" }` should get an immediate, actionable error — not a silent fallback to the default path. Unknown values are often caller bugs or injection attempts.

### 3. Branch AFTER shared guard/lock/preflight

Keep ALL shared logic (auth, lock, preflight) BEFORE the branch:

```typescript
// shared lock / preflight runs first ↓
const lock = acquireLock(...)
const preflight = runPreflight(git)
if (!preflight.ok) { releaseLock(); json(res, ..., 409); return true }

// branch at the last moment ↓
if (newParam === 'option-b') {
  // new synchronous path
  try {
    doTheThing()
    releaseLock()
    json(res, { ok: true })
  } catch (err) {
    cleanUp()
    releaseLock()
    json(res, { error: ..., reason: 'option-b-failed' }, 500)
  }
  return true
}

// existing async path unchanged ↓
spawnDetached(...)
```

### 4. No command injection — array args only

If the new path calls OS commands, use `execFileSync` with an ARRAY of arguments, never template strings:

```typescript
// SAFE: each element is a separate argv, no shell interpolation
execFileSync('/usr/bin/git', ['merge', 'upstream/main', '--no-edit'], { cwd: ROOT })

// DANGEROUS: do not do this
exec(`git merge ${userInput}`)
```

For any user-controlled value that reaches an OS command: it must pass through the strict allowlist above and NEVER be interpolated into a string passed to a shell.

### 5. Synchronous vs async new path

If the new path is short and synchronous (< 30s), run it inline and return the result directly. No background spawn needed. Use a try/catch that aborts partial state before returning the error.

If the new path is long (involves a restart, rebuild, or background job): model it after the existing async spawn + pidfile/polling pattern — don't invent a new async mechanism.

### 6. Cleanup on error

Always release shared locks even on the error path:
```typescript
try {
  doWork()
  releaseLock()
  json(res, { ok: true })
} catch (err) {
  abortPartialState()   // e.g. git merge --abort
  releaseLock()
  json(res, { error: ..., reason: '...' }, 500)
}
```

### 7. Backward-compat verification

Before shipping: call the endpoint WITHOUT the new param and confirm it behaves identically to before. The default value must reproduce the old behavior exactly — no side effects from the new code path.

### 8. New i18n keys (FE side)

For each new outcome the FE must show (success toast, error message, confirmation dialog), add i18n keys to ALL configured locales in the same namespace as the existing keys for this endpoint. Never hardcode strings.

## Checklist

- [ ] `JSON.parse` done exactly once, unknown param values → 400
- [ ] Default param value reproduces old behavior exactly
- [ ] Branch is AFTER shared lock/preflight, not before
- [ ] OS commands use array args (no template string interpolation)
- [ ] Partial-state cleanup (abort/undo) on error before releasing lock
- [ ] `lock.release()` called on EVERY exit path (success and all errors)
- [ ] New i18n keys added to ALL configured locales (full parity)
- [ ] Without the new param, old callers get the same response as before

## Pitfalls

- **Allowlist on unknown values not 400**: silently defaulting to the first option when the caller sends `"adminmode"` hides caller bugs and potential injection attempts. Reject explicitly.
- **Branch before shared lock**: if option-b skips the lock, two concurrent requests can race. Always acquire shared guards before branching.
- **Cleanup missing on error**: a merge-abort or file-delete in a finally{} block prevents the working tree from getting stuck in a bad state between requests.
- **Shell injection via template string**: even a "safe" string like `upstream/main` can be subverted if the param comes from user input. Always use argv array.
- **New i18n key only in one locale**: the parity guard will catch it, but it's a QA FAIL. Add to all locales in the same edit.
