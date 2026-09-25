---
name: tamper-evident-worm-chain
description: Build a tamper-evident, append-only (WORM) hash-chain over records that a privileged INSIDER must not be able to edit undetected -- an audit/attendance/receipt/ledger trail. Add a SELF-VERIFY (recompute-and-compare) AND an EXTERNAL ANCHOR (off-box head commitment) so even a consistent full-rewrite is caught. Trigger words: "tamper-evident", "WORM", "append-only ledger", "hash-chain", "audit trail integrity", "insider can't edit undetected", "external anchor", "anti-INSIDER".
---

# Tamper-evident WORM hash-chain (+ external anchor)

## When to use
- Any record set where a privileged insider (owner/superuser/DBA who can disable a
  DB trigger) editing/deleting/reordering a row UNDETECTED is a real threat:
  attendance/payroll rows, money/receipt ledgers, custody transfers, audit logs.
- The prevention layer (a fail-closed WORM DB trigger) stops a bug/SQLi at runtime,
  but does NOT stop an insider who can turn the trigger off. This adds DETECTION on
  top of prevention.
- NOT for: ordinary data with no insider-tamper threat (a plain updated_at is fine),
  or where you only need prevention (a trigger) not detection.

## The core idea (two layers -- you need BOTH)
1. **Self-verify (recompute-and-compare):** an append-only hash-chain over the rows.
   Re-verifying the CURRENT rows against the stored chain catches an edit, a row
   substitution, a reorder/insert, and a truncation.
2. **External anchor:** self-verify CANNOT catch a CONSISTENT FULL-REWRITE -- an
   insider who rewrites BOTH the rows AND every stored chainHash produces a fully
   self-consistent chain (`selfVerify === true`). The defence is to publish the
   chain HEAD to an INDEPENDENTLY-BREACHABLE trust-domain (separate credential/key),
   append-only. The insider would have to compromise BOTH domains to match the
   last-anchored head. The caller runs `selfVerify AND verifyAgainstAnchor`.

## Procedure

### 1. The chain link (bind everything tamperable)
Each link binds `(position, rowId, contentHash, prevHash) -> hash`:
- `position` (0-based seq): IN the hash, so reordering two rows is detectable.
- `rowId` (the row's stable id): IN the hash, so a row cannot be swapped for a
  different id at the same position.
- `contentHash` = hash of the row's **canonical ALL-FIELD projection**. Missing ONE
  field here = that field can be edited without breaking the chain (a silent-tamper
  hole). The projection MUST list every tamperable field.
- `prevHash` = the previous link's `hash` (a genesis sentinel for the first). Makes
  it a CHAIN, not a set.
- `hash` = hash over the canonical `(position, rowId, contentHash, prevHash)`.

Canonical projection rules:
- Use a **length-prefixed / injective** serializer (no two distinct field-tuples
  share an encoding -- guards against `"a"+"bc"` vs `"ab"+"c"` collisions).
- **Reject C0/DEL/C1 control chars + BIDI overrides** (U+0000-001F, 007F-009F,
  U+202A-202E, U+2066-2069) at the hashed chokepoint (smuggling a field boundary).
- Booleans/numbers -> a stable canonical form (`'true'`/`'false'`, `String(n)`),
  NEVER a locale string. Nullable -> an unambiguous sentinel (e.g. `''` when a real
  value is always non-empty).
- The **hasher is an INJECTED port** (`(input:string)=>string`, SHA-256 hex in prod;
  a real `createHash` fake in tests). The pure domain never imports `node:crypto`.

### 2. Self-verify (return the FIRST divergence, with a reason)
Rebuild the chain from the CURRENT rows; compare link-by-link to the stored chain:
- `rowId` differs -> `row_substituted`
- `contentHash` differs -> `content_edited`
- `hash` differs (cascaded prevHash) -> `reordered_or_inserted`
- length differs -> `length_mismatch`
Return the first divergence (a break cascades; the first is the actionable one).

### 3. External anchor (the consistent-rewrite defence)
- Anchor = `{ count: chainLength, headHash: head.hash }` (a `seq` if your links
  carry one).
- `anchor(chain, publisher)`: publish the head to the independent store; return null
  for an empty chain (nothing to anchor -- not an error).
- `verifyAgainstAnchor(chain, anchor)`:
  - **null anchor -> INVALID (FAIL-CLOSED).** A chain with nothing anchored is NOT
    trusted by default. This is the single most-forgotten rule.
  - chain length `< anchor.count` -> false (truncated below the anchor).
  - the link at the anchored position must carry `anchor.headHash` (a consistent
    rewrite changed it) -> else false.
- `verifyFull = selfVerify(rows) && verifyAgainstAnchor(chain, anchor)`. The caller
  ALWAYS runs both.
- The anchor publisher is an INJECTED port; the real adapter writes to a store with
  its OWN credential (independently breachable) and is itself **append-only** (a
  prior anchor still convicts even if the latest is forged).

### 4. Scope everything by the owner (tenant/account)
The chain + anchor are per scope-owner (tenant). `verify`/`anchor` take the owner
from the trusted context, filter to it, and sort by a stable order `(at, id)` so the
anchored position is deterministic. A foreign-owner row is ignored (never merged).

### 5. Make-live persistence invariants (re-gate when the DB adapter lands)
- The chain rows are **INSERT-only** -- no UPDATE/DELETE grant to the app role (that
  IS the WORM property at the DB layer).
- The anchor store is append-only + its own credential (not the app DB credential).
- **Concurrent append must not fork the chain:** read-tail + build-link + append must
  be atomic -- `FOR UPDATE` on the tenant chain head, OR a `UNIQUE(owner, prev_hash)`
  / `UNIQUE(owner, seq)` so a fork is rejected. (In-memory single-process is
  naturally serialized; the PG adapter is where the fork risk is real.)

## Non-vacuous tests (the gate-passing part)
- **Field-coverage (THE security test):** mutate EACH tamperable field of a row
  individually (`it.each`) -> every one breaks self-verify at that position with
  `content_edited`. A field you forgot in the projection FAILS this test.
- Row substitution, reorder, insert, truncation each detected with the right reason.
- **The consistent-rewrite test (THE anchor test):** build the original chain, anchor
  it; rebuild a FULLY self-consistent chain over EDITED rows -> `selfVerify(rewritten)
  === true` BUT `verifyAgainstAnchor(rewritten, originalAnchor) === false`, and
  `verifyFull === false`. Without this test the anchor could be a no-op and pass.
- **null-anchor -> INVALID** even for a self-consistent chain (fail-closed).
- Truncation below the anchored count -> false.
- Anchor publisher is append-only (successive anchors retained per owner).
- Scope isolation: a foreign-owner row is ignored by verify + anchor.
- Reject a control/BIDI char at the canonical chokepoint (throws).

## Pitfalls
- **Projection misses a field** -> that field is silently editable. The field-coverage
  test is what catches it; write it FIRST.
- **Anchor in the SAME trust-domain as the chain** (same DB, same credential) -> an
  insider with DB access rewrites both -> the anchor is useless. It MUST be
  independently breachable (separate store + credential).
- **null anchor treated as valid** -> the whole external defence is off for any
  un-anchored chain. Fail-closed: null == INVALID.
- **Only running self-verify** -> the consistent-full-rewrite walks through. Always
  run `verifyFull` (both).
- **Concurrent appends fork** without tail-serialization in the PG adapter.
- **Direct crypto import in the domain** -> not testable/portable. Inject the hasher.
- **Green self-verify is not proof of the anchor** -> the consistent-rewrite test is
  the only thing that proves the anchor bites.

## Verification checklist
- [ ] Canonical projection lists EVERY tamperable field (field-coverage test green).
- [ ] Injected hasher; no `node:crypto` in the pure domain.
- [ ] Self-verify returns the first divergence + a reason; all 4 tamper classes tested.
- [ ] External anchor: consistent-rewrite test PASSES (self-verify true, anchor false).
- [ ] null anchor == INVALID (fail-closed) proven by test.
- [ ] `verifyFull` = self-verify AND anchor; caller uses it.
- [ ] Scoped per owner (from trusted ctx); foreign rows ignored.
- [ ] Make-live invariants documented: rows INSERT-only, anchor store append-only +
      own credential, concurrent-append serialization -- flagged for the DB-adapter
      re-gate.
