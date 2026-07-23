# Injection & Web attack playbook

## Injection
- **SQL/NoSQL**: parameterized queries everywhere; try `' OR 1=1--`, `${}`/`$where`, operator injection (`{"$gt":""}`); ORM raw fragments with interpolation.
- **Command**: any shell-out with user input; try `; id`, `$(...)`, backticks, newline injection.
- **Template (SSTI)**: user input rendered by a template engine; try `{{7*7}}`, `${7*7}`.
- **Path traversal**: file paths from input; try `../../etc/passwd`, encoded `%2e%2e`, null bytes, absolute paths; object-store keys must be tenant-prefixed and traversal-safe.
  - **DECODE-BEFORE-CHECK** (real case, a green suite hid this MEDIUM): a guard that only bans the LITERAL `..` segment + the `%2e%2e` substring is bypassed by the OTHER WHATWG double-dot forms the browser also normalizes to `..`: `%2e.`, `.%2e`, and via encoded slash `%2f`. `new URL("/root/%2e./%2e./x", base).pathname` → escapes the root. Rule: percent-DECODE first (`decodeURIComponent`, malformed `%` → fail-closed reject), then run the structural check on BOTH the raw AND decoded form, and match the allowed-root on the DECODED path. Verify empirically with `new URL()` (the browser follows WHATWG) — string heuristics under-match the parser. Backslash `\`/`%5c` is the sibling bypass (see the URL-sanitizer note below).
- **SSRF**: server fetches a user-supplied URL; try `http://169.254.169.254/` (cloud metadata), `localhost`, internal ranges, redirects, DNS rebinding, alternate schemes (`file://`, `gopher://`).
- **XXE / deserialization**: XML parsers with external entities enabled; native deserialization of untrusted data.
- **Mass assignment / prototype pollution**: binding request bodies straight to models; `__proto__`/`constructor` keys.

## Web output
- **XSS by context**: HTML-body (`<script>`), attribute (`" onmouseover=`), JS (`</script>`), URL (`javascript:`), and DOM sinks (`innerHTML`, `dangerouslySetInnerHTML`). Verify the escaper matches the SINK context — HTML-escaping is wrong inside an attribute or JS string. Don't rely on a single encoder (e.g. URL percent-encoding) as the sole guard if the surrounding context changes.
- **CSRF**: state-changing requests need anti-CSRF tokens or SameSite cookies; check that GET never mutates.
- **Open redirect**: `?next=`/`?return=` not validated against an allow-list.
- **Tenant URL in an outbound HTML/email sink → beacon/exfil** (real case): a tenant-controlled URL (branding `logoUrl`, avatar, webhook) placed into an OUTBOUND HTML sink — auth email, notification, PDF — with only https+syntax validation loads an attacker host when the recipient opens it: tracking beacon (recipient IP / open-tracking) + phishing image in a trusted message. HTML-escaping does NOT constrain the host. Require a HOST ALLOWLIST (tenant CDN + platform asset origin, exact hostname, userinfo/`@` and trailing-dot rejected); with no allowlist configured, DROP the URL (text fallback), never render an untrusted remote resource. Check that the mitigation is actually WIRED at the email/HTML caller, not just available as an optional arg.
- **URL-sanitizer string-heuristic bypass**: any relative-URL / same-origin / host allowlist guard built with string checks (`startsWith('/')`, `!startsWith('//')`) is weaker than the parser. Classic bypasses: backslash `/\evil.com` (browser normalizes `\`→`/` → protocol-relative off-origin), `%2e` dot-segments, userinfo `good.com@evil.com`. Delegate to `new URL()` and check `.origin`/`.hostname`, don't hand-roll.
- **Clickjacking**: missing `X-Frame-Options`/`frame-ancestors`.
- **CORS**: reflected `Origin`, `Access-Control-Allow-Origin: *` with credentials, trusting `null` origin.
- **Security headers / CSP**: missing or weak CSP, no `Strict-Transport-Security`, permissive `Content-Type` sniffing.

## API-specific
- Authn/authz on EVERY endpoint (not just the UI-reachable ones); verb tampering; missing object-level checks on bulk endpoints; GraphQL introspection/depth/alias abuse; verbose errors leaking internals.

## Probes to try
- Inject context-appropriate XSS payloads into each rendered field; confirm escaping per sink.
- Feed traversal/SSRF payloads to any path/URL parameter.
- Replay a state-changing call without the CSRF token / from another origin.
