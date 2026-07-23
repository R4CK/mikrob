# Rate-limit, Crypto, Secrets & Data-protection playbook

## Rate-limiting & abuse
- **Key non-normalization**: limiter keyed on raw input → bypass via case (`FOO@x.com`), whitespace/trailing dot, unicode equivalents, or `+tag` aliases. Normalize (lowercase/trim/NFC) before keying.
- **Dimension gaps**: per-email but not per-IP (or vice versa); strictest dimension must win; distributed/rotated IPs.
- **Window correctness**: fixed-window edge bursts (2x at boundary); reset timing; ensure the store owns atomic increment+expiry.
- **TOCTOU / races**: single-use/locking enforced by read-then-write instead of an atomic conditional write (e.g. `UPDATE ... WHERE used_at IS NULL`). Fire two concurrent requests; exactly one must win.
- **Resource exhaustion / DoS**: unbounded input size, zip/JSON bombs, expensive regex (ReDoS), N+1, missing pagination caps, unbounded fan-out.

## Crypto & randomness
- **Hashing**: passwords with bcrypt/scrypt/argon2 (not MD5/SHA-1/plain); tokens hashed at rest; constant-time comparison for secrets/MACs.
- **Randomness**: tokens/ids/jti from a CSPRNG (`crypto.randomBytes`), never `Math.random()`; sufficient entropy (>=128 bits).
- **Tamper-evidence**: hash-chain canonicalization is stable (fixed field order/serialization) so a hash can't drift; verification pinpoints the first broken link; chain detects content edits, reordering, and seq gaps.
- **Transport/at-rest**: TLS enforced; sensitive fields encrypted at rest where required.

## Secrets
- No hardcoded secrets/keys in code or config committed to git; secrets from env/secret-manager.
- Secrets never in logs, error messages, URLs/query strings, analytics, or client bundles.
- Rotation possible; least-privilege scoping of keys.

## Data protection / GDPR
- **PII leakage**: not in logs/responses/error bodies/stack traces; minimal collection; field-level scoping in API responses.
- **Signed URLs**: scoped to the object + tenant, short expiry, not guessable, not cacheable by shared caches.
- **Retention / erasure**: defined retention, working delete/erasure path, no orphaned copies (thumbnails, backups, caches).
- **Access logging / repudiation**: security-relevant actions audited (who/what/when) without logging the sensitive payload itself.

## Probes to try
- Exhaust a limiter, then hit it with a normalized-equivalent key.
- Launch concurrent requests at a single-use resource; assert one success.
- Grep the codebase/logs for secrets and for PII written to logs.
- Tamper one field in a hash-chained record; assert verification flags the exact index.
