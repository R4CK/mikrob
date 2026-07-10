---
name: tenant-pure-domain
description: Build a backend feature as a PURE, dependency-free domain module with injected ports (the IO/crypto/DB seam), a binding tenant-scope invariant, and non-vacuous tests (mutation-proof + negative controls + fail-closed). Use for any multi-tenant SaaS backend card/feature where persistence, HTTP, crypto, image/DNS/network IO are deferred to a later adapter — especially in a workspace where modules resolve via tsconfig paths / test aliases. Distilled from ~25 real multi-tenant SaaS domain cards.
---
# Tenant-scoped pure-domain module

The repeatable recipe for shipping a backend feature as a **pure domain** that is
correct-by-construction and fully unit-tested with **no database, no HTTP, no
crypto, no network** — the effectful parts are injected ports an adapter wires
later. Every shipped piece followed this and passed QA + Cybersec gates.

## When to use
- A backend card whose essence is RULES + SHAPE + STATE (entities, validation,
  money math, state machines, scoring, integrity checks, scheduling) and where
  DB/HTTP/SDK/crypto/image/DNS are explicitly "a later adapter card".
- Triggers: "pure-domain", "dep-mentes", "injektált port", "tenant-scope",
  "state machine / állapotgép", "validation domain", "X builds on Y domain".
- NOT for: the actual adapter (Drizzle/S3/jose/sharp wiring), UI, or anything
  needing a live external service. Those are separate cards.

## The four pillars

### 1. Pure domain core (no IO)
- One file = one cohesive domain (`offer.ts`, `attendance.ts`, `entitlement.ts`).
- Export: typed entities (`readonly` fields), `enum`s for closed sets,
  validating **factories** (`makeX`) that are the SINGLE source of a well-formed
  value, immutable update helpers (`{ ...x, field }`, bump `updatedAt`), and
  pure predicates/among.
- NO `Date.now()` / `Math.random()` inside logic that must be testable — inject
  `now: Date` (or epoch ms) as a parameter. (Convenience factories may default
  `now = new Date()`, but every transition/evaluation takes `now` explicitly.)
- Derive, never trust: totals/areas/hashes are COMPUTED from inputs, never
  accepted from the caller; add an `assertXConsistent` that recomputes and
  compares (defense in depth mirroring DB CHECKs).

### 2. Injected port = the seam (dependency inversion)
- The ONE non-deterministic/effectful dependency is an **interface** the domain
  depends on; the adapter implements it; tests pass a fake.
- Seen ports: `EvidenceHasher`/`CaptureHasher` (SHA-256), `MetadataSigner`,
  `QrRenderer`, `Presigner`/`PresignerBackend`, `ObjectStoreClient`,
  `MultipartBackend`, `Uploader`, `SyncPort`, `PendingStore<T>`.
- Contract in the doc comment: deterministic, lowercase-hex, etc. The domain
  never imports `node:crypto`, `@aws-sdk/*`, `sharp`, `indexedDB`.
- Validate inputs BEFORE calling the port; on a scope/permission failure, throw
  BEFORE the port is invoked (tests assert "backend never called on a bad key").

### 3. Tenant-scope invariant (binding)
- `tenantId` comes from the trusted context: `makeXForTenant(ctx, input)` uses
  `requireTenant(ctx)` — NEVER from `input`/body. A hostile `tenantId` in the
  body is structurally ignored.
- Guard every read/mutate with `assertXAccessible(ctx, x)` →
  `assertSameTenant(ctx, x.tenantId)` (throws `CrossTenantAccessError`, leaks no
  id).
- Object keys / sub-resources forced under `tenants/{tenantId}/`; reject
  traversal (`..`) and foreign prefixes.
- Same-tenant is NOT enough where rows are user-owned: add per-resource authz
  (owner / assignee / privileged-role) — see `resource-authz` to avoid IDOR.
- Aggregations group strictly by `(tenantId, …)` so two tenants never merge into
  one result; filter foreign rows out of any list input.

### 4. Non-vacuous tests (the gate-passing part)
A green suite is NOT evidence — magic-link shipped 151/151 green with 2 MAJOR
bugs. Each test must be able to FAIL for the right reason:
- **Mutation-proof:** assert the actual computed value (duration, totals,
  geoConfirmed boolean, hash), not just "did not throw".
- **Negative controls:** every validation/guard has a test that feeds the bad
  input and asserts the specific error type (`toThrow(SpecificError)`).
- **Fail-closed / default-deny:** unknown enum value, empty/への context, missing
  field, expired token → REJECT. Parametrize over several bad values
  (`it.each([...])`) so a future value can't silently pass (Cybersec FINDING-2).
- **Boundary cases:** off-by-one on expiry (`>=` inclusive), exactly-zero,
  exactly-at-threshold, last-part-smaller, terminal-state transitions rejected.
- **Tamper/forgery:** flip a byte/field and assert verification now fails.
- **Determinism:** same input → same output; immutable update returns a NEW
  object and leaves the original untouched.
- **Allowlist > blocklist:** test the invariant, not the current enum (prove
  `!= Active → reject`, not `== Disabled → reject`).

## Procedure
1. **Move the card to `in_progress`** (kanban) and read the domain it builds on
   (grep the package) to MATCH its house style and REUSE its types/guards — do
   not duplicate an existing spine; layer on top of it.
2. **Place it:** add to the existing module if it extends one; else a new
   `packages/<...>/` package. In a paths/alias monorepo a new internal package
   resolves via `tsconfig.base.json` paths + the vitest alias and the root
   `include` glob — so it typechecks & tests WITHOUT `pnpm install`. For any
   dependency you reach for, follow the **Shared-checkout dependency protocol**
   below (workspace-dep = commit yourself; real npm-dep = STOP, flag the exact
   spec to the orchestrator, never `pnpm add`).
3. **Write the domain file** (4 pillars). Header comment: what it owns, what is a
   later adapter, the tenant rule, doc-refs.
4. **Export** from the package `index.ts` (named exports; avoid barrel clashes).
5. **Write the test file** (4th pillar). Aim for thorough negative coverage.
6. **Verify (evidence before assertions):** run the package tests, run root
   `tsc --noEmit`, run `prettier --write` on your files. All green + clean.
7. **Commit ONLY your own files** (shared working tree → never `git add -A`;
   `git add <explicit paths>`). End message with the Co-Authored-By trailer.
8. **Finish:** result comment on the card + move to `waiting` (REVIEW). NEVER
   self-`done` — QA PASS + Cybersec GO close it (author-cannot-verify rule).
9. Only ping the orchestrator when BLOCKED or the whole assigned row is done.

## Pitfalls
- **Generic record construction** `{ ...record, field } as T` for `T extends
  Union` — TS rejects the bare spread as `T`; use a small `as T` cast helper, or
  operate on a concrete union, or on the sub-object (e.g. `SyncMeta`) directly.
- **Type-only imports** across packages erase at runtime (`import type`), so a
  cross-package TYPE dep needs no runtime resolution; a VALUE import does (still
  fine via alias, but declare the dep in package.json for honesty).
- **Cross-tenant before per-resource:** in a combined guard, check tenant FIRST
  (throw `CrossTenantAccessError`, no leak), THEN per-resource (403). Order
  matters for no-leak.
- **Spec hidden in the card title/late message:** e.g. "(+/-300s)" or a Cybersec
  FINDING revealed after you started — reconcile the implementation to it even if
  the card was already `waiting`; it is pre-gate, a follow-up commit is correct.
- **Money:** integer cents, half-up (`Math.round(x + Number.EPSILON)`); never
  float-accumulate across many lines.
- **Idempotency keys / queue ids:** derive from CONTENT (tenant + logical id +
  hash), not the local row id, so the same logical thing dedupes everywhere.
- A long commit message / API comment may trip an over-eager governance hook —
  keep them short (single `-m`), put detail in code + file-header comments.

## Shared-checkout dependency protocol (workspace-dep vs npm-dep)
Many agents share ONE working tree + ONE `pnpm-lock.yaml`. Adding a dependency is
where a solo instinct (`pnpm add`) corrupts everyone. Classify FIRST, then act:

- **Workspace cross-package dep (`@app/*`)** — e.g. proof needs
  `@app/evidence`/`@app/sites`. Add `"@app/x": "workspace:*"`
  to YOUR package.json's `dependencies`; it resolves via `tsconfig.base.json`
  paths + the vitest alias, so tsc + tests pass with **NO `pnpm install` and NO
  `pnpm-lock` change**. Commit the package.json yourself. Mention it to the
  orchestrator as an FYI, but it does NOT need the batch install.
- **Real external npm dep** (`@zxing/browser`, `jose`, `sharp`, …) — writes the
  SHARED `pnpm-lock`. **NEVER `pnpm add` / `pnpm install`.** STOP and hand the
  orchestrator an EXACT spec so they run the single clean batch install on a
  quiet tree:
  - package name + **semver range**, and the **target package.json** (which
    `packages/…` or `apps/…`, `dependencies` vs `devDependencies`);
  - **peer-compatibility** — resolve the compatible pair yourself, don't assume
    "latest". Real case: `@zxing/browser@0.2.0` peer-requires
    `@zxing/library@^0.22.0`, so pinning `@zxing/library@latest` (0.23.0) BREAKS
    the peer — the correct pin is `^0.22.0`. Check `npm view <pkg> peerDependencies`
    before quoting versions.
- **Stay unblocked meanwhile:** the whole feature except the thin adapter needs
  no new dep. Define the **port interface** in your own file and build + fully
  test the component/domain against a FAKE (the ZoneScanner + BarcodeScanner port
  shipped 100%-tested while `@zxing` was dep-blocked). Land the thin real adapter
  (the ONLY file importing the lib) in a follow-up commit AFTER the batch lands;
  keep the card `[NN% - DEP-BLOKK]` in `waiting`, not `done`.

## Pre-REVIEW self-check: the Cybersec HIGH classes (catch these BEFORE `waiting`)
These three re-gate NO-GO classes recur; green tests routinely hide them. Audit
every card against all three before you move it to `waiting`.

1. **Fail-closed on a null/missing gate value — null is never "allow forever".**
   A nullable field that gates a state transition or access decision must NEVER be
   read as infinite/permitted when null. Re-DERIVE it from its source, and if that
   is also absent, fall to the SAFE (closed) state. Real case: `graceEndsAt` gated
   `Grace -> Suspended`; a null value (from a DB reload) left a non-paying tenant
   read-only forever. Fix: derive the deadline from `trialEndsAt`, else force
   `Suspended` (7c0db72e). Grep your branches for `x !== null && <expiry check>` —
   the missing `else` is the hole.
2. **Persistence round-trip — if you STAMP a derived value, it must survive reload.**
   When the domain computes+returns a derived field (deadline, computed status,
   hash), there must be (a) a DB column, (b) the interface field, and (c) a caller
   that writes ALL derived fields back tenant-scoped — not just `status`. Prove it
   with a test that RELOADS the row from the stored shape, not one that feeds the
   in-memory result straight back (that masks a missing column, exactly what let
   14 green tests pass over an unreachable lockout). Add the migration + a
   schema-guard test in the same card.
3. **Recompute derived / legally-binding values; reject smuggled control chars.**
   Never trust a self-consistent caller value (VAT: recompute from net+mode,
   fail-closed on mismatch; area/deadlines: derive, never accept as input). And at
   any canonical/signed/hashed or transport chokepoint (email, ids, audit rows)
   reject C0/DEL/C1 controls (U+0000-001F, 007F-009F) and BIDI/RTL overrides (U+202A-202E, U+2066-2069) — a whitespace-only
   filter lets NUL/DEL/RTL through (ec089d56 F1). Reuse the canonical validator;
   never hand-roll a weaker copy.
4. **The ACTOR of an authz / SoD decision comes from ctx/session — NEVER a caller param.**
   For any Segregation-of-Duties or "X may not act on their own Y" rule, the acting
   identity MUST be bound to `ctx.userId` (or the session actor), not passed in as a
   parameter the caller controls. Comparing two caller-supplied ids (e.g.
   `if (employeeId === reviewerId) throw`) is NOT a control: the caller sets both, so
   they just supply a different id and walk through. This recurred TWICE and both
   times 20+ green tests hid it: supply-request approval (`approverId` param, requester
   self-approves — 5d03d0bb) and performance self-review (`reviewerId` param, employee
   reviews self — e9ce895c). Fix pattern: `const actor = ctx.userId; if (actor === targetId) throw SoDError;`
   and use `actor` as the recorded approver/reviewer — do NOT accept a caller-supplied
   actor id for the authz decision. Grep every SoD/`!==`/`===` identity guard: if both
   sides trace to the request body/args rather than ctx, it's a bypass. The domain takes
   the actor as an explicit arg the ADAPTER fills from ctx — never trusts a body field.

## Verification checklist (before `waiting`)
- [ ] Package tests green; new tests include mutation-proof + negative + fail-closed.
- [ ] Fail-closed on every nullable gate value (null != allow); safe-state default proven by test.
- [ ] Every STAMPED/derived field has column + interface field + write-back + a RELOAD round-trip test.
- [ ] Derived/binding values recomputed server-side; control-chars rejected at hashed/signed/transport chokepoints.
- [ ] Root `tsc --noEmit` clean.
- [ ] `prettier --write` clean on changed files.
- [ ] `tenantId` from ctx (never body); `assertXAccessible` guard present + tested.
- [ ] No `node:crypto`/SDK/IO import in the domain; the effectful dep is an injected port.
- [ ] Any new dep classified: workspace-dep committed by you; real npm-dep flagged (exact range + target + peer-compat) to the orchestrator, `pnpm-lock` untouched.
- [ ] Only your files staged (no `git add -A`); Co-Authored-By trailer.
- [ ] Card: REVIEW comment + `waiting`. Not `done` — QA PASS + Cybersec GO close it (author-cannot-verify: you never sign off your own build).
