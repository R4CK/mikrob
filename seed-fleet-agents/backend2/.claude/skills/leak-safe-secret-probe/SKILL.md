---
name: leak-safe-secret-probe
description: Validate a secret (API key/token) against a live third-party API without ever letting it leak into a URL, log, argv, or error string — fail-closed, with fixed-code error classification and hermetic tests. Use when storing/rotating/health-checking any API key, bot token, or bearer credential before or after persistence. Triggers -- "validate this API key", "probe-call before storing", "token health-guard", "check the key against the provider", "kulcs ellenorzese proba-hivassal".
---

# Leak-safe secret probe

The repeatable recipe for calling a third-party API to check a secret is
valid — before storing it (a config/settings PUT) or periodically after (a
health-guard) — **without ever letting the secret escape** into a URL, a log
line, a process's argv, or an error message. Used twice independently in the
same codebase (a bash bot-token health-guard and a TypeScript config-API
validator) with the identical shape; distilled here so the next one doesn't
reinvent it.

## When to use
- A PUT/POST config endpoint that accepts an API key/token and should reject
  an invalid one BEFORE persisting it (fail-closed).
- A periodic watchdog/health-check that re-validates an already-stored
  credential and needs to distinguish "the credential is dead" from "the
  network/provider is having a bad moment" (very different remediation).
- NOT for: validating input SHAPE (regex/length — that's free, do it first,
  no network call needed) or business-logic authz (this is purely "does the
  provider accept this secret").

## The four rules

### 1. The secret goes ONLY where it can't be logged
- **HTTP header, never the URL.** URLs get logged by proxies, load balancers,
  access logs, and browser history; headers don't. In fetch/axios/etc., put
  the secret in a header (`Authorization: Bearer …`, `x-api-key`, whatever the
  provider's convention is) — never as a query string.
- **In bash/curl, never on argv.** `curl "https://api/x?token=$SECRET"` or
  even `curl -H "Authorization: Bearer $SECRET"` puts the secret in
  `/proc/<pid>/cmdline`, visible to any other process on the host (`ps aux`,
  procfs). Feed curl a **stdin config** instead:
  ```bash
  printf 'url = "%s"\nheader = "Authorization: Bearer %s"\n' "$URL" "$SECRET" \
    | curl -sS -K - -w '%{http_code}'
  ```
  `printf` is a shell builtin (no fork, never appears in any process list);
  `curl -K -` reads the config from stdin, so the secret never touches argv.

### 2. Fixed-code error classification, never the raw error
Map every outcome to a **small closed set of codes** the caller can safely
render as a user message or log — never pass through the raw
exception/response body, which can itself contain the request that carried
the secret (some HTTP client error messages echo the request URL/headers).
A good split:
- `ok` — 200 / provider confirms the credential works.
- `invalid` — 400/401/403 (or the provider's "auth failed" shape) — the
  credential itself is wrong/revoked/expired. Actionable: get a new one.
- `unexpected` — any other non-2xx status. The PROVIDER is misbehaving, not
  the key — do not tell the user "your key is wrong" (that's a lie that sends
  them on a wild goose chase).
- `network` — the call itself failed (DNS, connection refused, TLS, or a
  timeout/abort). Transient — don't treat as a confirmed-bad credential.

### 3. Fail-closed with a hard timeout
Never let the probe hang the caller. Use `AbortController` (TS) with a
`setTimeout(() => controller.abort(), timeoutMs)`, cleared in a `finally`; in
bash, `curl --max-time N`. On timeout/abort, classify as `network` (not
`invalid` — an unreachable provider is not proof the key is bad) — this keeps
a transient network blip from wrongly wiping out a good stored credential.

### 4. Injectable transport for hermetic tests
- **TypeScript:** accept an optional `fetchImpl?: typeof fetch` (default the
  global `fetch`) and `baseUrl?: string`. Tests pass a `vi.fn` stub that
  returns a canned `Response` — zero real network, and you can assert the
  secret never appears in the constructed URL/error string.
- **Bash:** put a stub `curl` earlier on `$PATH` in the test that records its
  argv (should be secret-free) AND stdin (where the secret legitimately
  lands, proving the probe ran off-argv), and returns canned output based on
  an env var the test sets.

## Reference shape (TypeScript)

```typescript
export async function validateSecret(
  key: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; baseUrl?: string },
): Promise<{ ok: boolean; error?: 'invalid' | 'unexpected' | 'network' }> {
  const doFetch = opts?.fetchImpl ?? fetch
  const base = opts?.baseUrl ?? 'https://api.provider.example'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 10_000)
  try {
    const res = await doFetch(`${base}/whoami`, {
      headers: { Authorization: `Bearer ${key}` }, // header, NEVER the URL
      signal: controller.signal,
    })
    if (res.status === 200) return { ok: true }
    if ([400, 401, 403].includes(res.status)) return { ok: false, error: 'invalid' }
    return { ok: false, error: 'unexpected' }
  } catch {
    return { ok: false, error: 'network' } // includes AbortError (timeout)
  } finally {
    clearTimeout(timer)
  }
}
```

## Reference shape (bash)

```bash
probe_secret() {
  local secret="$1" resp code body
  resp="$(printf 'url = "%s/whoami"\nheader = "Authorization: Bearer %s"\n' "$BASE" "$secret" \
    | curl -sS --max-time 15 -K - -w $'\n%{http_code}' 2>/dev/null)" || resp=""
  [[ -z "$resp" ]] && { echo network; return 0; }
  code="$(tail -n1 <<<"$resp")"
  case "$code" in
    200) echo ok ;;
    400|401|403) echo invalid ;;
    *) echo unexpected ;;
  esac
}
```

## Wiring it into a store (fail-closed PUT)

```
validate FIRST -> if not ok: return the mapped status/message, do NOT call the store's write
                -> if ok: THEN persist (encrypted-at-rest if the store supports it), return masked value
```
Never persist speculatively and validate after — a bad key would sit in
storage until the next probe cycle notices.

## Non-vacuous test checklist
- Each classification (`ok`/`invalid`/`unexpected`/`network`) has its own
  test with a distinct fixture (status code / thrown error / abort).
- **No-leak assertions** (the part that actually catches regressions):
  - the constructed URL string does NOT contain the secret;
  - every returned/logged string across ALL error branches does NOT contain
    the secret (loop over the branches, not just one);
  - (bash) the stub curl's recorded ARGV does not contain the secret, while
    its recorded STDIN does (proves the probe ran, off-argv).
- Timeout/abort classifies as `network`, not `invalid` (a slow provider must
  never look like "this key is confirmed bad").
- The write-path test: an `invalid`/`network` result asserts the store's
  write function was **never called** (mock/spy the store, don't hit a real
  DB/vault file in the test).

## Pitfalls
- Logging `err` (the raw caught exception) "just for debugging" — some HTTP
  client errors embed the full request (including headers) in their message.
  Log only the classification code + a static field name, never the error
  object.
- Using `?token=` in the URL because the provider's docs show it that way —
  most APIs that document a query-string token ALSO support a header; use the
  header even if the query-string form is documented as the "simple" option.
  If a provider genuinely only accepts the secret in the URL, that URL must
  never be logged/echoed anywhere (still keep the rest of the discipline).
- Treating a timeout as proof the key is bad — this silently breaks a working
  integration through no fault of the key holder. Always `network`, never
  `invalid`, on timeout.
- Forgetting `clearTimeout` in a `finally` — leaks a timer per call under load.
