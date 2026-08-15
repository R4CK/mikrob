# Recurring NO-GO classes (CleanCore fleet review, distilled)

Five defect classes that produced real HIGH/CRITICAL NO-GOs across many backend/fullstack
cards in one review. They recur because the *happy-path test is green* — the gap is the
un-tested case. Check these FIRST on any card touching money, tenancy, evidence/hashing,
free-text, or a lifecycle state machine. Each has a copy-paste PoC template.

---

## 1. Recompute derived/statutory values on the WRITE path (don't just check internal consistency)
**Smell:** a stored derived value (VAT, total, tax, gross) is validated only for *internal*
consistency (`gross == net + vat`) but never RECOMPUTED from its source (`net + mode`). A
wrong-but-internally-consistent value sails through — e.g. a 27% invoice with `vat=0`,
`gross=net`. For a signed/tax/NAV payload this is a falsified legal record.
**Fix:** recompute via the single-source function and reject any mismatch, fail-closed.
```ts
const expected = computeVat(netAmount, vatMode)               // the ONE authority
if (vatAmount !== expected.vatAmount || grossAmount !== expected.grossAmount)
  throw new DomainError('vat/gross do not match the statutory value for the mode')
```
**PoC:** `buildInvoice({net:1000, vat:0, gross:1000, mode:DOMESTIC_27})` MUST throw;
`{net:1000, vat:270, gross:1270}` builds. (CleanCore: fd276111, 26da06e9, 8d7be843.)

## 2. Tenant-scope guard on EVERY state-transition write, not just create
**Smell:** the create/issue path has `assertSameTenant(ctx, x.tenantId)` but a SIBLING mutator
(`markPaid`, `void`, `bind`, `unbind`, `retire`, `reassign`) was added later WITHOUT it — the
asymmetry is the bug. One forgotten mutator = full cross-tenant write (flip another tenant's
invoice to PAID, bind your label to their resource).
**Fix:** `assertSameTenant(ctx, entity.tenantId)` as the FIRST statement of every mutator; and
for cross-entity links assert `a.tenantId === b.tenantId` (mirror the transfer/attach guard).
**PoC:** for each exported mutator: `mutator(ctx('t1'), foreign{tenantId:'t2'})` → `CrossTenantAccessError`.
Grep the file: does every `export function`-that-mutates start with the guard? (CleanCore: 8d7be843, c816e410.)

## 3. Reject control + BIDI chars on every free-text / email field
**Smell:** free-text (name, email, description, id, objectKey, takenBy) validated only for
non-empty / a loose `[^\s@]`-style regex. `\s` does NOT cover NUL(0x00), C0/C1, DEL, or bidi
overrides. Consequences: NUL truncation in C-backed sinks, log/terminal injection, U+202E
homograph spoofing of a displayed email/recipient, non-injective identity keys, and (if the
value is later canonicalized — see #4) separator injection.
**Fix, fail-closed, at the validating factory:**
```ts
const FORBIDDEN = /[\x00-\x1f\x7f-\u009f\u202a-\u202e\u2066-\u2069]/
if (FORBIDDEN.test(value)) throw new DomainError(`${field} must not contain control/bidi chars`)
```
**PoC:** for `code of [0x00,0x08,0x1f,0x7f,0x85,0x202e,0x2066]`: `validate('admin'+String.fromCharCode(code)+'x@a.com')` → reject; clean value passes. (CleanCore: ec089d56, 253eb268, 6d8cfabc.)

## 4. Hash-chain / signed-canonicalizer separator-injection COLLISION
**Smell:** a canonical form joins fields with a separator (US `\x1F` / LF) and a comment claims
"our values never contain these" — but nothing ENFORCES it. A field carrying `\n` + a forged
`field\x1Fvalue` fragment shifts a field boundary, so two DISTINCT records produce byte-identical
canonical strings → the SAME hash. This defeats the whole tamper-evidence guarantee: `verifyChain`
AND the signed head-anchor both accept the forgery (attacker needs no key). Same class in
signed-metadata blobs (one blob, two tenant meanings).
**Fix:** reject `[\x00-\x1f\x7f]` in EVERY free-text field at the ONE canonicalization
chokepoint (so every producer — append AND verify AND future callers — is covered). Also make
`verify` never-throw: a control-char record returns an invalid verdict, not an uncaught exception.
**PoC (real sha256):**
```ts
const A = rec({ capture:{ taskCompletionId: 'REAL\ncapture.taskCompletionId\x1fFORGED' } })
const B = rec({ capture:{ taskCompletionId: 'FORGED' } })
// pre-fix: canonical(A) === canonical(B) and hash(A) === hash(B)  ← collision
// post-fix: canonicalize/append(A) THROWS; B is clean; they can never collide
```
(CleanCore: 65b2db5e CRITICAL, 253eb268.) Related: non-injective `tenant:key` — always
length-prefix each segment (`up1:<len>:<val>...`), never a bare `:` join (66b0336a, d1d16771).

## 5. Fail-closed on a null / missing deadline in a lifecycle state machine
**Smell:** a lifecycle deadline field can be `null` (legacy row, a value never persisted, a row
reloaded from the DB before a column existed). The code reads `null` as "no deadline → stays in
this state forever," so the terminal/lockout state is STRUCTURALLY UNREACHABLE for the exact
data shape production actually produces. Fail-open (a non-paying tenant never locks out). The
green test masks it by keeping a stamped value in memory and never round-tripping through persistence.
**Fix:** a null deadline must mean *already expired* → fail-closed to the restrictive state;
derive the deadline from the prior instant if possible, else Suspend. Persist the derived value
(column + model field + the sweep writes BOTH status and deadline back). Test with the data
shape the PRODUCTION model produces, not a fabricated literal.
```ts
const deadline = row.graceEndsAt ?? (row.trialEndsAt ? deriveGraceEnd(row.trialEndsAt) : null)
if (deadline === null) return { status: SUSPENDED }               // null != "forever"
return now >= deadline ? { status: SUSPENDED } : { status: GRACE }
```
**PoC:** `evaluate({status:GRACE, graceEndsAt:null, trialEndsAt:set}, now=+9999d)` MUST be
SUSPENDED (not perpetual GRACE); `{both null}` → SUSPENDED. (CleanCore: 7c0db72e, 2× NO-GO.)

## 6. Async floating-promise = silent authz/audit bypass (CRITICAL class)
**Smell:** a sync→async migration of a guard/audit function leaves a call site that does NOT
`await` the result. A Promise that rejects (= deny) is silently swallowed; the synchronous
control flow continues past the "guard" and the privileged operation runs UN-DENIED, UN-LOGGED.
tsc alone CANNOT catch this: a `Promise<void>` returned from an async `authz()` call is
type-correct whether awaited or not. The suite stays green (the non-async test path still passes).
**Scope:** any auth, authz, audit, burn, revoke, or idempotency-mark function turned async.
The failure mode applies to EVERY call site — ~300 sites in the CleanCore superadmin plane
(8deac0b2 CRITICAL, reverted; the TOTP-burn async cascade 4d6a1148 is the current live instance).
**Fix (non-negotiable):**
1. `@typescript-eslint/no-floating-promises: error` + `@typescript-eslint/no-misused-promises: error` in ESLint CI config, enforced on EVERY PR. Without this the defect is invisible.
2. `await` EVERY authz/audit/burn/revoke/mark call, mechanically, across ALL call sites in the chain (not just the 5 you changed — grep the downstream callers).
3. Durable-before-ack: for state-changing guards (burn, revoke, mark-as-used) the `await` MUST resolve BEFORE the success response is emitted; fail-closed: `AlreadyUsed/conflict → deny`.
4. Per-path regression: a test that asserts the guard-ON path DENIES must FAIL if the `await` is removed (use a spy that returns a rejecting Promise).
**PoC template:**
```ts
// Make the guard return a rejected Promise
jest.spyOn(deps, 'burnTotpStep').mockReturnValue(Promise.reject(new Error('AlreadyUsed')))
// If the await is missing, login still succeeds (BYPASS). With await it throws.
await expect(superadminLogin(creds, deps)).rejects.toThrow()
```
**Standing probe (run on EVERY async migration of a guard fn):**
`command grep -rna 'burnTotpStep\|authorizeSuperadmin\|assertSession\|revoke\|markUsed' --include='*.ts' | command grep -v 'await '`
— any hit that is NOT `await`-prefixed and NOT inside an already-async chain tail is a candidate bypass. (CleanCore: 8deac0b2 CRITICAL; pattern confirmed in async-refactor-fail-open-guard skill.)
`command grep`, not bare `grep`, and that is not stylistic — see #7: a bare `grep` in an agent's own
shell silently skips gitignored paths and binary-looking files.

---

## 7. A grep you TYPED is not the grep you think — an agent's shell shims it
**Smell:** a sweep whose evidence is "`grep` found 0 hits", run by typing `grep` in an agent's Bash
tool. Most damaging on a SECRET sweep, but it applies to any "the codebase does not contain X" claim.

**Mechanism (measured, not recalled — read it with `declare -f grep`):** the Claude Code interactive
shell defines a bash FUNCTION named `grep` that runs `ugrep` through the claude binary and prepends
its own flags to yours:
`-G --ignore-files --hidden -I --exclude-dir=.git --exclude-dir=.svn ...`
`--ignore-files` makes it honour `.gitignore`; `-I` makes it skip files that look binary. Neither is
something the caller asked for, and neither is visible in the command they wrote.

**Measured on a three-file tree (clean file / file with a NUL / gitignored file, same token in all
three), 2026-08-15:**

| invocation | found |
|---|---|
| `grep -rl` (shim) | 1 of 3 — misses the NUL file AND the ignored one |
| `grep -ral` (shim) | 2 of 3 — `-a` recovers the NUL file only |
| `grep -ral --no-ignore-files` (shim) | 3 of 3 |
| `command grep -ral` | 3 of 3 |

**So `-a` alone is NOT the fix.** It closes the half that matters least. Secrets do not live in binary
blobs; they live in `.env`, `store/`, `agents/` — the paths a `.gitignore` names, which is the half
`-a` leaves shut.

**THE TWO AXES HAVE DIFFERENT SCOPE, and conflating them is how a reader talks themselves into
trusting a 0-hit (Cybersec NO-GO on the first version of this section, which did exactly that).**
`--ignore-files` only prunes the TRAVERSAL, so the path blind spot depends on the root: a recursive
search at or above the `.gitignore` misses the target, while starting from inside the ignored
directory finds it. `-I` applies to EVERY invocation, including a named file: a file containing a NUL
is not read even when you name it by hand. Measured on a two-file fixture, no recursion:

| named file | shim `grep -l` | `command grep -l` |
|---|---|---|
| `plain.txt` | found | found |
| `withnul.txt` | **no output, rc=1** | found |

So the root fixes half the problem, not all of it. "I named the file, so I saw it" is false, and the
fleet has documented NUL-carrying files (card ee01f7ce), so a `grep 'sk-' <file>` returning 0 is a
real false negative, not a hypothetical one. Review a sweep's ROOT **and** whether it can read a
binary-looking file.

**And you cannot infer the coverage from reading the `.gitignore`, because which of its rules apply
depends on how the ROOT IS SPELLED.** Same directory, same ignore file, measured:

| rule in `.gitignore` | root `.` | root `/abs/path` |
|---|---|---|
| `scripts/` (bare directory name) | skipped | skipped |
| `*.sh` (basename glob) | skipped | skipped |
| `scripts/helper.sh` (path-anchored) | skipped | **searched** |
| `/scripts/` (rooted) | skipped | **searched** |

So "I checked the ignore file, only X is excluded" is not a sound inference either. Measure the
actual invocation.

**On the fleet's own tree, measured (filenames only, no content printed):** `grep -rl <marker> .`
from `{{INSTALL_DIR}}` misses `agents/backend2/CLAUDE.md` and `store/autonomy-config.json` — it
returns only the tracked `seed-*` copies, which looks like a plausible complete answer rather than a
truncated one. `command grep -rl` returns those plus `store/claudeclaw.db`. Note `store/*` is ignored
but `!store/*.sh` un-ignores the scripts, so SOME of `store/` is visible and some is not: a spot check
on one file there proves nothing about the rest.

**Blast radius, measured — this does NOT reach shell scripts:** the shim is a function and it is not
exported (`BASH_FUNC_grep` is absent from the environment). Inside a script run as a subprocess
`type -t grep` reports `file`, and the same search finds all three. So:

| path | shimmed? |
|---|---|
| `grep` typed in the agent's Bash tool | YES |
| `$(grep ...)` command substitution | YES |
| a snippet `source`d into that shell | YES |
| `./script.sh`, `bash script.sh`, `bash -c 'grep ...'` | no |
| `subprocess.run(['grep', ...])`, `sh -c 'grep ...'`, `xargs grep` | no |

Which cuts both ways: a script's sweep is NOT quietly narrowed, and a `bash -c` wrapper does not
inherit whatever hardening you added to the typed form either.

Do not "fix" the fleet's `*.sh` sweeps for this; they were never affected. Fix what agents type.

**Fix, in order of preference:**
1. Do not sweep for secrets with `grep` at all — walk the filesystem and read bytes, so no ignore
   file and no binary heuristic can hide a match. `store/secret-shape-scan.py` already does this
   (`os.walk` + `open(..., 'rb')`), and its own binary skip is a DELIBERATE scope match to what
   repomix packs, documented in its header — not this defect.
2. If it must be grep: `command grep -ra ...` (bypasses the function entirely), or
   `grep -ra --no-ignore-files ...` if you want ugrep's speed.
3. Never accept a bare `grep` 0-hit result as evidence — yours or another agent's. Ask which form
   produced it.

**PoC (rebuild it rather than trusting this table — the shim can change):**
```bash
mkdir -p /tmp/p/ig && cd /tmp/p && printf 'ig/\n' > .gitignore
printf 'TOK\n' > a.txt; printf 'x\0TOK\0y\n' > b.bin; printf 'TOK\n' > ig/c.env
grep -rl TOK . ; grep -ral TOK . ; grep -ral --no-ignore-files TOK . ; command grep -ral TOK .
```
(Fleet: card ee01f7ce found the `-I` half; cec36660 measured that `--ignore-files` is the larger
half. The fleet's own `.gitignore` names `.env`, `store/*` and `agents/` — i.e. exactly where its
tokens live.)

---

### Meta-lesson for the whole class
Every one of these passed its author's test suite. The defect is always the *un-imagined input*:
the wrong-but-consistent number, the sibling mutator, the control char, the boundary-shifting
separator, the null the model actually produces. When gating: **write the PoC for the case the
author did NOT write a test for**, and grep for the asymmetry (guard on function A, missing on
sibling B). Prefer reusing the one canonical validator (sanitizer, key-guard, VAT math) — a
hand-rolled second copy is where the two drift and the hole opens.
