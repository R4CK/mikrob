---
name: defensive-security-analysis
description: Analyze code defensively for security weaknesses from the DEFENDER's seat — trust boundaries, input validation, authz/authn, injection sinks, secrets handling, fail-closed behavior, and safe output/serialization — and propose concrete hardening. Use when reviewing or writing code that touches untrusted input, auth, money, PII, multi-tenant scope, files, or crypto. Triggers on "security review", "is this safe", "harden this", "defensive analysis", "biztonsági elemzés", "sebezhető-e".
---
# Defensive Security Analysis

## When to use
On any code near a trust boundary: request handlers, auth/session, RBAC, multi-tenant queries,
money/billing, PII, file upload/serving, crypto, deserialization, template/SQL/shell/HTML
sinks. This is the DEFENDER lens (write it safe, prove it fails closed) — complementary to the
offensive `white-hat-security-testing` / `redteam` skills that try to break a running target.

## First: draw the trust boundary
Mark, in the code, where UNTRUSTED data crosses into TRUSTED execution (network body, query
params, headers, uploaded files, third-party webhooks, DB rows written by another tenant).
Every finding below is "what happens to untrusted data after it crosses". If you can't point
to the boundary, you can't secure it.

## The defensive checklist (per boundary)
1. **Input validation — allowlist, at the edge, server-side.** Validate type/shape/range/charset
   on entry; reject don't sanitize-and-hope. Reject C0/DEL/C1 control chars (U+0000-001F,
   007F-009F) and BIDI/RTL overrides (U+202A-202E, U+2066-2069) at canonical/signed/logged
   chokepoints — a whitespace-only filter lets NUL/RTL through. Cap sizes/counts (DoS).
2. **Authentication & authorization — from the session, never the caller.** The acting identity
   for any authz/ownership/SoD decision MUST come from `ctx`/session, NEVER a request-body
   field. Comparing two caller-supplied ids is not a control. Enforce on the SERVER even if the
   UI already hides the action (UI-hiding is defense-in-depth, not enforcement). Check both
   vertical (privilege) and horizontal (other tenant/user's object) escalation. **Fail closed:**
   missing/null/unknown -> deny, never "allow by default".
3. **Multi-tenant / object scope.** Every query filtered by `ctx.tenantId` (and ownership) —
   never trust a `tenantId`/`ownerId` from the body. Composite/tenant keys length-prefixed or
   strict-charset, never raw concatenation (ambiguity = cross-tenant leak).
4. **Injection sinks — parameterize / escape at the sink.** SQL (parameterized), shell (no
   string-built commands), HTML/JS (context-aware escaping / framework auto-escape, watch
   `dangerouslySetInnerHTML`), path traversal (`../`, absolute, prefix-confusion -> anchor to a
   tenant/entity prefix and verify), template injection, deserialization of untrusted data,
   SSRF on server-side fetch, open redirect.
5. **Derived & security-relevant values — recompute, don't trust.** Prices/totals/VAT, hashes,
   signatures, expiry/deadline gates: recompute server-side from source; a nullable gate value
   read as "permit forever" when null is a classic hole (fail closed, re-derive).
6. **Secrets & crypto.** No hardcoded secrets (env/secret-store, and not in logs or errors).
   CSPRNG for tokens (>=128-bit, unguessable, not time/seed-based); constant-time compare for
   secrets; verify webhook/JWT signatures (issuer+audience); no PAN/CVV/raw-PII stored or logged
   (tokenize, keep last4). Idempotency keys injective + tenant-scoped so replays can't double-charge.
7. **Output & serialization.** Escape for the destination (SVG/CSV/XML/HTML/JSON); don't leak
   internal detail/stack traces to clients; set correct status codes; strip secrets from
   responses and logs.
8. **Resilience / abuse.** Rate-limit (sliding window in prod; fixed-window allows boundary
   burst), timeouts + retries with caps on external calls, bounded work per request, tamper-
   evident append-only audit for privileged actions (hash-chain + head-anchor vs truncation).

## Procedure
1. Locate boundaries; for each, walk the checklist and record concrete findings as
   `path:line` + the exploit scenario + the fix. Severity by impact × reachability.
2. **Prove, don't assert.** A "green test" is not evidence of safety (a passing suite has
   hidden MAJOR authz bugs before). Construct the specific bypass input and show it is rejected
   — or that it isn't. Negative controls (the disallowed actor/tenant is BLOCKED) are the proof.
3. Give a concrete, minimal hardening for each finding; prefer reusing the codebase's canonical
   validator over a new weaker one.

## Pitfalls
- **UI-hiding mistaken for enforcement** — the server must reject the direct API call too.
- **Sanitizing instead of rejecting** — allowlist-validate; blocklists leak.
- **Actor from the body** — the recurring self-approval / IDOR root cause.
- **Trusting client-sent derived values** (amount, hash, tenantId) instead of recomputing/scoping.
- **Fail-open defaults** — the missing `else`/`default` that permits when it should deny.
- **Calling green tests proof** — write the negative control that actually attempts the bypass.

## Verification
- Every trust boundary is marked and walked; each finding has `path:line` + scenario + fix.
- Authz/scope findings include a negative control proving the disallowed actor is blocked.
- Fail-closed confirmed on missing/null/error inputs; no secret in logs/responses.

Related: [[code-comprehension]], [[function-explanation]], and the offensive
`white-hat-security-testing` / `redteam` skills for breaking a live target.
