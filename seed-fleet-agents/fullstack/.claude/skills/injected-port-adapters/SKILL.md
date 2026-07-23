---
name: injected-port-adapters
description: Implement the app-layer ADAPTER for a pure domain's injected port (SDK/IO/crypto wiring) — the counterpart to tenant-pure-domain. Covers the thin-adapter pattern, per-category security constraints (output escaping for SVG/CSV/XML, deterministic lowercase-hex hashing, constant-time + no-secret-log signing, TTL-capped + pre-validated presigning, transient-vs-permanent error mapping), config/secret sourcing, and adapter testing against a real (or sandbox) dependency. Use when wiring a real SDK (Stripe, VIES, NAV, S3/R2, Graph/Gmail, bwip-js, sharp, node:crypto, jose) behind a domain port.
---
# Injected-port adapters (the SDK/IO wiring side)

The companion to `tenant-pure-domain`. Domains depend on injected PORT
interfaces; this skill is how to implement the **adapter** that satisfies a port
with a real dependency — correctly and safely — so the pure-domain guarantees
survive contact with the outside world.

## When to use
- A card that wires a real SDK/service behind an existing domain port:
  `EvidenceHasher`/`CaptureHasher` (SHA-256), `MetadataSigner`, `QrRenderer`/
  `QrGenPort` (bwip-js/qrcode), `Presigner`/`ObjectStoreClient`/
  `MultipartBackend` (S3/R2), `PaymentPort` (Stripe), `ViesPort` (EU VIES),
  `NavPort`/`NavReportPort` (NAV Online Számla), `MailPort` (Graph/Gmail),
  `Uploader`/`SyncPort`/`PendingStore` (PWA), image `sharp` processor.
- Triggers: "wire Stripe/VIES/NAV/S3/Graph", "adapter card", "implement the
  X port", "install the SDK and connect it".

## The adapter contract (universal)
1. **Thin, no business logic.** The adapter only translates: port call → SDK
   call → port-typed result. All validation/rules already happened in the domain
   BEFORE the port was invoked (the domain proved the key is in-tenant, the TTL
   is capped, the amount is positive). Never re-decide policy here.
2. **Honour the port's stated contract exactly** (it's in the port's doc
   comment). If it says "returns lowercase hex", normalise the SDK's output to
   lowercase hex. If it says "throws on transport error", let transport errors
   propagate (so the domain's retry/backoff fires).
3. **Secrets from config, never hardcoded.** Read keys/tokens from the config
   layer (env/secret manager) at construction; never log them, never put them in
   an error message or a returned object.
4. **Determinism where the port promises it.** A hasher/HMAC signer MUST be a
   pure function of its input bytes — same in, same out, forever (the chain/
   idempotency depends on it). Do not add timestamps/nonces unless the port says.
5. **Validate the SDK's OUTPUT before returning** it as the port type (e.g.
   assert the hex is 64 chars; the presigned URL is https; the intent id is
   non-empty), so a misbehaving SDK can't smuggle a malformed value past the
   domain's expectations.

## Per-category security constraints (the part that bites)

### Hashers — `EvidenceHasher`, `CaptureHasher`
- `node:crypto` `createHash('sha256').update(bytes).digest('hex')` → already
  lowercase hex; return as-is. WebCrypto on-device: `crypto.subtle.digest` →
  hex-encode lowercase. MUST be deterministic; no salt.

### Signers — `MetadataSigner`, token signers (jose)
- `sign` deterministic for HMAC; `verify` MUST be constant-time
  (`crypto.timingSafeEqual`), not `===`. Never log or return the key. Pin the
  algorithm; reject `alg:none`. Key strength: ≥256-bit HMAC / ≥2048-bit RSA.

### Renderers / serialisers — OUTPUT ESCAPING IS MANDATORY
- **SVG (QrRenderer/QrGenPort label):** the tenant-controlled label/caption is
  STORED XSS if dropped into `<text>` raw — escape with the domain's
  `escapeSvgText` (`& < > " '`). 
- **CSV (pay/data export):** a cell starting with `= + - @ TAB CR` is a FORMULA
  INJECTION — the domain's `csvField` apostrophe-prefixes it; the adapter must
  use that, not hand-roll CSV. Always quote + double embedded quotes (RFC 4180).
- **XML (NAV Online Számla):** escape `& < > " '` in every text node/attr; build
  via a real XML builder, never string concat. Validate against the NAV XSD
  before submit. Sign with the NAV-mandated XML signature.
- **HTML/email bodies:** escape or sanitise; never interpolate user text raw.

### Presigners / object store — `Presigner`, `ObjectStoreClient`, `MultipartBackend`
- The domain already proved the key is in-tenant + the TTL ≤ cap. The adapter
  must NOT widen scope: sign exactly that key, that TTL, that method. Bucket/IAM
  policy pins credentials to the `tenants/{id}/` prefix as defense-in-depth.
- Never presign DELETE. Multipart: pass the part number/range through unchanged
  (the plan is deterministic so retries reuse the same range).

### External services — `PaymentPort` (Stripe), `ViesPort`, `NavPort`/`NavReportPort`, `MailPort`
- **Error mapping is the key decision:** map a TRANSIENT failure (5xx, network,
  rate-limit, NAV "PROCESSING") to a THROW / retriable outcome so the domain's
  backoff/retry handles it; map a PERMANENT failure (4xx validation, VIES
  "invalid", NAV "ABORTED") to the domain's terminal/`valid:false` result. Do
  not retry a permanent error; do not swallow a transient one as success.
- **Idempotency:** forward the domain's content-based idempotency key (Stripe
  `Idempotency-Key`, upload key) so a retried call dedupes server-side.
- **OAuth (Graph/Gmail MailPort):** refresh tokens via the provider flow; store
  refresh tokens encrypted; never log access tokens. Honour the provider's delta
  cursor — return it as the port's `nextCursor` so the domain advances correctly.
- **Money (Stripe):** charge in the minor units the domain computed (cents); do
  not re-derive amounts.

### Image processor (`sharp`)
- Normalise + **strip EXIF** (privacy, docs/04 §5) on the master; produce the
  derivatives; compute the stored-master SHA-256 the evidence chain commits to.
  `sharp` is an optionalDependency loaded ONLY by this adapter — never by the
  pure domain or its tests.

## Dependency / build hygiene
- Installing the SDK is the ONE place a real dependency + lockfile change is
  allowed — but only on an explicit adapter card. Add it to that package's
  `package.json`, run the workspace install, commit the lockfile delta. Native
  deps (sharp/libvips) go in the pnpm `onlyBuiltDependencies` allowlist.
- The adapter lives in the app/infra layer, NOT in the pure-domain package, so
  the domain's tests stay dependency-free.

## Procedure
1. Read the port interface + its doc contract (and the domain that uses it).
2. Add the SDK dependency to the ADAPTER package (explicit card; lockfile delta
   expected here, unlike pure-domain cards).
3. Implement the adapter: construct with config-sourced secrets; one method per
   port method; translate + apply the category constraints above.
4. Validate SDK output to the port type before returning.
5. Test: unit-test the translation with the SDK mocked/stubbed (error mapping is
   the highest-value test — assert transient→throw, permanent→typed result);
   add one integration/sandbox test where a sandbox exists (Stripe test mode,
   VIES test VAT ids, NAV test environment).
6. Wire the adapter into the composition root (DI) so handlers get the live port.

## Verification checklist
- [ ] Adapter is thin; no policy/validation duplicated from the domain.
- [ ] Output escaped per category (SVG/CSV/XML) — XSS/formula/injection closed.
- [ ] Secrets from config; never logged or returned; verify is constant-time.
- [ ] Transient vs permanent errors mapped to the port's retriable vs terminal contract.
- [ ] Idempotency key forwarded; money in domain-computed minor units.
- [ ] SDK output validated to the port type; presign scope/TTL not widened.
- [ ] SDK dep added to the adapter package only; domain stays dependency-free.
