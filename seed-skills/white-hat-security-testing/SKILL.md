---
name: white-hat-security-testing
description: Offensive white-hat security testing methodology for AUTHORIZED targets (this team's own product). Use when security-reviewing, threat-modeling, or pentesting a feature/codebase before it ships. Grounded in OWASP ASVS + Top 10, STRIDE threat modeling, and per-domain attack playbooks. Triggers on "security review", "pentest", "threat model", "is this exploitable", "biztonsagi teszt".
---

# White-hat Security Testing

The disciplined process for breaking your own product's security, proving the break, and closing it. Authorized targets only (your own code/infra). Output is always defensive: finding + proof + fix + regression test.

## When to use
- A security-relevant card is "claimed done" and needs the mandatory Cybersec gate.
- Designing/reviewing auth, multi-tenancy, payments, file handling, PII, or any trust boundary.
- After QA passes functionally — you test what QA's happy-path/edge tests do not: the adversary's path.

## The procedure

### 1. Scope & authorization check
Confirm the target is this team's own product. Identify the trust boundaries (what an attacker controls vs what the server controls). Never touch third-party systems or real user data; use synthetic data in a scratch dir.

### 2. Threat-model with STRIDE
Enumerate per component: **S**poofing, **T**ampering, **R**epudiation, **I**nformation disclosure, **D**enial of service, **E**levation of privilege. Map each threat to concrete code paths. This produces your attack hypotheses.

### 3. Attack — work the checklists
Run the domain playbooks in `references/` against the hypotheses. For each, try to construct a concrete violating input. Prefer a runnable probe (script in scratch, exercising the REAL exported functions/endpoints) over reasoning alone.

### 4. Prove
A finding requires: exact input + expected behavior + actual behavior. Capture the probe and its output. No proof → it is a hypothesis to flag, not a confirmed finding.

### 5. Rate & fix
Severity (CRITICAL/HIGH/MEDIUM/LOW/INFO) with CVSS-style reasoning (attack vector, complexity, privileges, impact on C/I/A). Give the concrete fix and a regression test that fails before the fix and passes after.

### 6. Verdict & gate
Explicit **GO / NO-GO**. NO-GO if any unresolved CRITICAL/HIGH. You are one of the two mandatory gates (with QA); both must PASS before DONE. Never sign off on code you authored.

## Core attack domains (detail in references/)
- **Authentication** → `references/auth-authz.md` (token forgery/confusion, expiry, single-use, enumeration, disabled-user-still-authenticates).
- **Authorization / multi-tenancy** → `references/auth-authz.md` (IDOR, horizontal/vertical privilege bypass, RBAC holes, server-side enforcement).
- **Injection & web** → `references/injection-web.md` (SQLi/NoSQLi/command/template, path traversal, SSRF, XSS contexts, CSRF, CORS/CSP).
- **Rate-limit & abuse** → `references/rate-limit-crypto-data.md` (key non-normalization, IP rotation, TOCTOU/races, resource exhaustion).
- **Crypto, secrets, data/GDPR** → `references/rate-limit-crypto-data.md` (weak hashing, predictable randomness, secrets in logs/URLs, PII leakage, signed-URL scope, tamper-evidence integrity).
- **Fleet-proven recurring NO-GO classes** → `references/recurring-no-go-classes.md` (5 defect classes that produced real HIGH/CRITICAL across many cards, each with a copy-paste PoC: derived/statutory-value recompute on write, tenant-guard on every mutator, control+BIDI reject, canonicalizer separator-injection collision, fail-closed null-deadline). **Check these first** on money / tenancy / evidence-hashing / free-text / lifecycle cards.

## Highest-yield instincts (these catch the most real bugs)
1. **"Checks membership but not the user."** Status/lifecycle on one entity is enforced while a related entity's disabled/revoked state is ignored (offboarded user keeps access). Always trace EVERY status field that should gate access.
2. **"Key isn't normalized."** Rate-limits, dedupe, identity keyed on raw user input (email/host) → bypass via case/whitespace/unicode/trailing-dot. Normalize before any security decision.
3. **"Trusts the client's claim."** Tenant id, role, price, quantity taken from request/JWT without server-side cross-check against the source of truth.
4. **"The read is the guard."** Single-use/locking enforced by a read-then-write instead of an atomic conditional write → TOCTOU race lets two requests both win.
5. **"Fails open."** On error or missing field, the code defaults to allow (e.g. `[undefined]` role that some check happens to pass). Security must fail CLOSED.
6. **"Opaque to the user, verbose to the attacker."** Distinct error messages / timing for exists-vs-not-exists → enumeration oracle.
7. **"Encoded once, in the wrong context."** Output escaped for HTML-body but interpolated into an attribute/JS/URL context, or relying on one encoder as the sole XSS guard.
8. **"Guarded on create, forgotten on the sibling."** The create/issue path checks tenant/derived-value/consistency, but a later-added mutator (`markPaid`, `void`, `bind`) or a null-deadline branch skips it. Grep for the asymmetry: every write-path mutator must carry the same guard. Also: canonical/hashed/free-text fields that never reject control+BIDI chars → separator-injection collision, homograph, NUL truncation. See `references/recurring-no-go-classes.md` for the 5 concrete forms + PoCs.
9. **"Same action, different scope per role."** A read action (`sites:read`) is blanket for staff but must be row-scoped (own/assigned) for a field-worker or a portal client — yet the scope model is per-ACTION (one global `ROW_SCOPED_ACTIONS` flag), so the scoped role silently gets the blanket grant → intra-tenant data leak. And a matrix cell that grants a read with NO backing RBAC action leaks the same way once wired. Check every read for a per-ROLE scope decision + an enforceable action; fix = split `x:read:all`/`:assigned`/`:own`. (See `references/auth-authz.md`.)
10. **"String-checked a URL the parser will re-normalize."** A same-origin / traversal / host guard built from `startsWith`/`includes` is weaker than `new URL()`: backslash `/\evil.com`, `%2e`/`%2f` dot-segments, and userinfo `good.com@evil.com` all slip a string heuristic but the browser normalizes them off-root/off-origin. Percent-decode before the check (malformed `%` → fail-closed), verify with `new URL()`, and host-allowlist any tenant URL that lands in an outbound email/HTML sink. (See `references/injection-web.md`.)
11. **"The absent case defaults permissive."** A security decision silently passes when its backing entry is MISSING, not just when it evaluates false. Two real forms caught behind green suites: (a) a UI button / matrix row names an action (`sa:impersonate`) that has NO code-level authz enum member → the highest-risk action ships UN-GATED (undefined gate ≠ deny). Grep every UI/doc/matrix action against the code enum; a name present in one and absent from the other is an authz hole. (b) A tamper-evidence verifier degrades a MISSING anchor/signature to a "vacuously valid / UNANCHORED" state → strip-the-anchor + truncate-the-tail passes. The absent artifact must be INVALID when the data is non-empty (`chain.length>0 && anchor==null → reject`), and rollback needs an INDEPENDENT WORM watermark (not the same store you're verifying). PoC discipline: a tamper/authz test is only real if it is NON-VACUOUS — prove the guard-OFF path PASSES and the guard-ON path FAILS (e.g. replay succeeds with `watermark=null`, fails with the real watermark); a test that never exercises the passing case proves nothing. STANDING PROBE (run on EVERY verify/guard/authorize fn): feed the protected arg as null / empty / missing (anchor, watermark, signature, role, scope, list) AND a truncated body — if the result stays valid/allowed, that is the bypass. This one probe catches the whole "null-argument degradation" class (e.g. 848bd2da: `verify(chain, anchor=null)` → UNANCHORED → valid) at the first gate.

## Defensive remediation patterns (pair every finding with its fix)
A gate's deliverable is finding + FIX. When you flag a hole, hand the engineer the correct shape below, not just the break. These are the shapes proven across the fleet's own cards.

- **Access control / RBAC.** Default-DENY allow-lists, fail-CLOSED (an ungranted or error path denies, never `[undefined]`-passes). Decide per-(role, action); row-scope (All/Assigned/Own) is chosen per ROLE, not one global flag — split `x:read:all`/`:assigned`/`:own`. Enforce SERVER-SIDE on EVERY write-path mutator (`create` AND `markPaid`/`void`/`bind`), not just create. Recompute derived/authority/price/statutory values server-side; never trust a client-supplied tenantId/role/amount. Gate on EVERY status that should block: user AND membership AND tenant-lifecycle (an allow-LIST of permitted states, so a new state fails closed). Every UI/matrix action needs a code authz-enum entry + a parity test (a doc/UI action with no enum = undefined gate).

- **CSRF.** Prefer bearer-token-in-`Authorization`-header APIs (no ambient cookie ⇒ CSRF-immune by construction). If you use cookie/session auth: `SameSite=Lax` (or `Strict`) on the session cookie + a synchronizer or double-submit CSRF token verified server-side on EVERY state-changing request + an `Origin`/`Referer` allowlist check. GET/HEAD must be side-effect-free. Never accept auth from a query param.

- **Security headers / CSP.** Set at the edge on every response, fail-closed: `Content-Security-Policy: default-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'` (NO `unsafe-inline`/`unsafe-eval` — use nonces/hashes); `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`; `X-Frame-Options: DENY`. Cache-control `no-store` on authed/PII responses.

- **OAuth2 / OIDC.** Authorization Code + PKCE (`S256`) for ALL clients; never implicit/password grant. On callback validate `state` (CSRF) AND `nonce` (replay); exact-match `redirect_uri` allowlist (no wildcard/prefix/substring). Verify the ID token: signature via the IdP's JWKS, `iss`+`aud` EXACT, `exp`/`nbf`, alg pinned to an allowlist (reject `none`/HS-RS confusion — the accepted alg is OURS, never the token header). Short-lived access token + rotating refresh; tokens server-side / httpOnly cookie, never `localStorage`.

- **Session management.** High-entropy (≥128-bit) opaque id, or a signed token on a pinned alg (HS256 ≥32-byte key, `timingSafeEqual` verify, separate keys per token type). ROTATE the id on every privilege change (login / step-up) to kill fixation. Idle + absolute timeout. Server-side revocation for logout/rotation — a stateless JWT needs a `jti` blacklist (Redis) or it can't be revoked. Cookies `httpOnly; Secure; SameSite`; scope claims to ONE tenant. Magic-link / password-reset / email-verify tokens: single-use + short TTL, stored as a HASH, burned by an ATOMIC conditional write (`SET used_at WHERE used_at IS NULL`), never read-then-write (TOCTOU). Opaque failure (unknown = expired = used) so the endpoint is no enumeration oracle.

## Pitfalls
- Don't rubber-stamp green tests — they cover the author's imagination, not the attacker's. Hunt the gap. A full green suite is NOT proof: real examples where an all-green suite hid live MEDIUMs/CRITICALs — 151/151 green masked 2 MAJOR auth bugs; a 791/791 green branding card hid a `%2e` URL-traversal AND a magic-link email exfil (1beb0ed9); 717/717 green hid the grace-lockout fail-open. ALWAYS write and run your OWN adversarial PoC-probe against the real exported function; only a runnable input→observed-output pair is evidence.
- Don't paste live secrets/tokens into reports; reference by name.
- Don't leave probe scripts in the repo or commit anything when in read-only/parallel mode.
- A "theoretical" finding with no exploit path today still gets logged as hardening (with honest severity), not silently dropped.

## Verification (of your own pass)
- Did you map all six STRIDE categories to code paths?
- Did every confirmed finding get a runnable proof and a regression test?
- Did you give an explicit GO/NO-GO and list what you verified as solid?
