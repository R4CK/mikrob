---
name: cybered-gate-pattern
description: Full Cybered gate workflow for the CleanCore fleet: board scan for waiting+REVIEW cards in Cybered scope, assume-breach kill-chain evaluation per card, verdict posting, card status update, and MikroB notification. Use this whenever running SELF-ADVANCE (Rule 11) or executing a MikroB-dispatched gate. Complements white-hat-security-testing (per-finding proof) by adding the assume-breach frame, kill-chain chaining, and fleet workflow mechanics.
---

# Cybered Gate Pattern

## When to use

- SELF-ADVANCE (Rule 11): no active work -> scan board -> gate next Cybered-scope card
- MikroB dispatches a card for Cybered gate (inter-agent message with GATE-DISPATCH)
- After a NO-GO fix cycle: re-gate the remediated card

## Cybered scope (gate these, not the others)

Gate a card if it touches ANY of:
- **superadmin** - any endpoint under `/v1/admin/*`, session/account management for superadmin
- **auth/session** - login, token mint/verify, session revocation, magic-link, password, TOTP
- **internet-facing write paths** - public endpoints that accept untrusted input and mutate state
- **money/financial** - amounts, billing, settlement, consignment rounding
- **PII** - personal data at rest or in transit
- **file upload** - multipart, stored artifacts
- **multi-tenant** - anything that crosses tenant boundaries or touches tenantId-gating

NOT Cybered scope: pure backend domain logic with no new attack surface (warehouse read-side, i18n text, CSS, tsconfig).

## Procedure

### 1. Board scan (SELF-ADVANCE only)

```bash
TOKEN=$(cat /home/neon/marveen/store/.dashboard-token)
# The API, not the DB file: sqlite3 is not installed on a stock Linux (exit 127), and the
# table is not the supported interface.
printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -H @- -s http://localhost:3420/api/kanban | python3 -c "
import json,sys
rows=[c for c in json.load(sys.stdin) if c.get('status')=='waiting']
rows.sort(key=lambda c: c.get('updated_at') or 0, reverse=True)
for c in rows[:20]:
    print(c['id'], '|', (c.get('title') or '')[:70], '|', c.get('assignee'))
"
```

For each candidate:
```bash
printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -H @- -s "http://localhost:3420/api/kanban/$ID/comments" | python3 -c "
import json,sys
cs=json.load(sys.stdin)
has_review = any('REVIEW' in (c.get('content','') or '') for c in cs)
has_cybered = any('CYBERED' in (c.get('content','') or '').upper() and c.get('author')=='cybered' for c in cs)
print(f'REVIEW:{has_review} CYBERED:{has_cybered}')
"
```

Pick the oldest card where REVIEW:True AND CYBERED:False AND title/description matches Cybered scope.

### 2. Read the code — the COMMITTED code, not the working tree (BINDING)

Gate against the exact commit the REVIEW names, NOT the working tree. A fix's wiring can be
uncommitted (`git status` = ` M`) while the green suite runs on the working tree — the commit
that would deploy is INERT. This is a real reversal: 4d6a1148's durable-burn wiring
(`superadmin-login-plane.ts` burnWriter injection) was working-tree-only, NOT in commit 0b5ccbb
→ the committed code fell to the in-memory fallback → the reboot-replay window it was meant to
close stayed OPEN. A GO read from the working tree had to be reversed to NO-GO.

Procedure:
- Get the commit sha from the REVIEW comment.
- `git show <sha> --stat` — list the files ACTUALLY in the commit. Anything you rely on that is
  NOT in this list is suspect.
- Read every relevant file with `git show <sha>:path/to/file`, NEVER the plain Read/grep of the
  working tree, for anything that affects the verdict (especially the composition-root / wiring /
  injection point — the seam can be committed while the injection is not).
- `git status --short` — any ` M`/`??` on a file the fix depends on = the fix is not shipped.
- Read the test file(s); identify trust boundaries, auth checks, error paths, external I/O.
- If the wiring is uncommitted → NO-GO with "commit the wiring" as the fix (see Pitfalls).

### 3. Assume-breach kill-chain evaluation

Think as a determined threat actor who is ALREADY INSIDE. For each card, generate 3-5 kill-chains:

**Kill-chain template:**
```
Kill-chain N (name):
- Initial position: [what the attacker controls/has]
- Chain: TACTIC -> action -> outcome
- MITRE ATT&CK: T#### technique name
- Result: PASS / FAIL / INFO
- Evidence: [specific code path / line that proves the claim]
```

**Standard kill-chains by card type:**

*Superadmin session/auth:*
1. Revocation SLA: disable account -> next request blocked within acceptable window
2. TOCTOU: concurrent requests after revocation
3. Transient-error abuse: infra error -> fail-open vs fail-closed
4. Cross-restart persistence: process restart -> revoked tokens valid again?

*Session gen-counter:*
1. Session-revocation bypass: forge high gen claim, bypass HMAC
2. Token-replay after counter-bump: use old token after bump
3. Race on gen-counter: concurrent login bumps

*Dev seed / env gate:*
1. Prod-leakage: UNSET env -> gate 1 check; explicit truthy env -> gate 2 check
2. Credential utility: even if gate bypassed, is the credential usable on prod?

*Public write path:*
1. Tenant isolation: can request A affect tenant B's data?
2. Input injection: SQL/command/template injection via user input
3. Rate-limit bypass: normalized key? IP normalization?
4. Missing authz on sibling mutators: create is guarded, void/update is not?

### 4. Verdict

```
CYBERED GO / NO-GO - [card title]

[2-3 sentence executive summary in Hungarian for Peti]

Kill-chain results:
1. KC1 (name): PASS/FAIL - [evidence]
2. KC2 (name): PASS/FAIL - [evidence]
...

[If NO-GO: CRITICAL/HIGH/MEDIUM finding with reproduce steps + fix]
[Forward invariants: what will need re-gating when deferred work lands]
```

### 5. Post verdict as comment

```bash
TOKEN=$(cat /home/neon/marveen/store/.dashboard-token)
printf 'Authorization: Bearer %s\n' "$TOKEN" \
| curl -H @- -s -X POST "http://localhost:3420/api/kanban/$ID/comments" \
  -H "Content-Type: application/json" \
  -d "{\"author\":\"cybered\",\"content\":\"CYBERED GO -- [summary]. Kill-chain 1: PASS. Kill-chain 2: PASS. [etc]\"}"
```

**Control-char gotcha**: when the verdict text quotes an injection/control-char test (literal NUL, SOH, BIDI overrides copied from the test source), the Bash tool REJECTS the command ("contains control characters that would be hidden in the approval dialog"). Don't paste literal control chars into the verdict — describe them by name (`NUL`, `SOH`, `BIDI-override`). If the text unavoidably carries them, Write the verdict to a scratchpad file and POST via python instead of a `-d` heredoc:
```bash
python3 -c "import json,urllib.request; body=json.dumps({'author':'cybered','content':open('/path/verdict.txt').read()}).encode(); req=urllib.request.Request('http://localhost:3420/api/kanban/$ID/comments', data=body, headers={'Content-Type':'application/json','Authorization':'Bearer '+open('/home/neon/marveen/store/.dashboard-token').read().strip()}); print(json.load(urllib.request.urlopen(req)).get('id'))"
```


**Backtick gotcha (SILENT corruption, worse than the control-char one -- no rejection, just data loss)**: a verdict that names code symbols in backticks (a function name, a `{access:'full'}`-style literal) and is embedded INLINE inside a `python3 -c "..."` command is still exposed to bash's double-quote parsing, which expands backticks as command substitution BEFORE python ever sees the string. Each backtick-quoted snippet silently vanishes (replaced by the empty/failed-command output), and the shell prints "command not found" noise for each one -- but the call still exits 0 and posts, so nothing LOOKS like it failed. Real case: card 21f07ea6, comment 5599 -- a verdict citing several backtick-quoted function/value names inline in a `python3 -c "long string with backticks"` command posted with those identifiers stripped, leaving broken sentences (a "grep-eltem X-re NULLA talalat" with the X missing). Caught only by re-fetching and reading the posted comment back. **Rule: if the verdict text contains ANY backtick, ALWAYS Write it to a scratchpad file first and POST via the file-reading python one-liner above -- never inline backtick-containing content into a `python3 -c "..."` or `bash -c "..."` string.** After posting, re-fetch the comment by id and check that a couple of the backtick-quoted identifiers survived, especially after any correction post.

### 6. Update card status to waiting

```bash
printf 'Authorization: Bearer %s\n' "$TOKEN" \
| curl -H @- -s -X PUT "http://localhost:3420/api/kanban/$ID" \
  -H "Content-Type: application/json" \
  -d '{"status":"waiting"}'
```

(Card was already waiting; this ensures the PUT registers correctly after the comment)

### 7. Notify MikroB

```bash
printf 'Authorization: Bearer %s\n' "$TOKEN" \
| curl -H @- -s -X POST http://localhost:3420/api/messages \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"cybered\",\"to\":\"mikrob\",\"content\":\"CYBERED GO -- kartya $ID [brief]. [Summary]. Kartya waiting, te zarhatod.\"}"
```

For NO-GO:
```
CYBERED NO-GO -- kartya $ID [brief]. [SEVERITY] finding: [what breaks + how to reproduce]. Re-dispatch szükséges a felelős agentnek.
```

### 8. Log to daily log

```bash
printf 'Authorization: Bearer %s\n' "$TOKEN" \
| curl -H @- -s -X POST http://localhost:3420/api/daily-log \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"cybered\",\"content\":\"## $(date +%H:%M) -- CYBERED GO $ID\\n[summary]\"}"
```

### 9. Continue SELF-ADVANCE

After each gate, immediately scan for the next Cybered-scope waiting+REVIEW card. Ping MikroB when board is clean.

## Pitfalls

- **API list vs DB**: `/api/kanban?status=waiting` may return stale/done cards. Use `sqlite3 store/claudeclaw.db` for the authoritative waiting-card list.
- **CYBERED-VERDICT:False means different things**: my verdict not found in CURRENT agent's comments != no verdict ever. Check last comment from `mikrob` - if it says "DONE" with "Cybe Red GO", the card is already closed.
- **In-memory store volatility**: process restart resets gen-counters to 0 -> previously revoked tokens valid again until TTL. This is a forward-invariant for all session-revocation cards (DB-backed store needed). Don't re-gate it unless the DB store ships.
- **Composition root precedence**: old dev seeds can shadow new ones via `??`. Functional gap is NOT a security issue if the shadowed seed is MORE restrictive.
- **Missing MikroB notification**: always send the inter-agent message AFTER posting the comment. The comment going in without the notification stalls MikroB's reconciliation.
- **Working-tree GO (the reversal trap)**: reading the wiring/injection from the working tree instead of `git show <sha>:file` gives a GO on code that is not in the commit. The seam (the function that accepts the dep) is often committed while the injection (the composition-root call that passes it) is NOT → the committed code silently falls to the safe-but-inert fallback branch, and the fix ships dead. ALWAYS `git show <sha> --stat` and confirm every wiring file the verdict depends on is in the commit; `git status --short` any ` M` on those files = NO-GO. The fix for this class is trivial and specific: "commit the already-written wiring in <file>", then re-gate against the new sha. (Real case: 4d6a1148 GO→NO-GO, login-plane.ts burnWriter uncommitted.)
- **No-op / stub dep passed a security store (trace the wiring, not the call)**: seeing a security-relevant call — `deps.sessionGenerations.bump(user.id)`, `deps.revoke(...)`, `deps.audit.record(...)` — proves NOTHING about whether the dep is the REAL store or an inert stub. STANDING PROBE on every injected guard/store/revoke/audit/burn dep: trace it to the composition root (`git show <sha>:main.ts` / the `load*Config` / `startServer` wiring) and confirm the SAME real singleton the enforcement path checks is what's injected. An inline literal (`{ bump: () => 0 }`, `new Map()` never shared, `() => true`, `{ record: () => {} }`) at the injection site is the smell → the mechanism is DEAD while the green suite (which tests the flow in isolation against a fresh store) still passes. Real case: 46d87ac9 OAuth GO→NO-GO — the OAuth deps got `sessionGenerations: { bump: () => 0 }` (main.ts:415), NOT the real `SessionGenerationStore` singleton (server.ts:351) that `assertSessionGeneration` checks and password/magic-link bump → the OAuth login neither rotated nor revoked → single-active-session violated + born-revoked session for mixed-login users. The fix: inject the real singleton (thread it from the stage that creates it). Grep `git show <sha>:main.ts` for the dep name; if the value is an inline no-op, NO-GO + new card. Same class as [[gate-committed-not-working-tree]] and the Cybersec wire-guard-into-live-path pattern.

## Forward invariants to track

After gating session/auth cards, record invariants that need re-gating when deferred work lands:

- In-memory gen-counter -> DB-backed: re-gate when `SessionGenerationStore` PG adapter ships (cross-restart revocation now broken)
- SuperadminLiveAccountCheck -> wired via `config.magicLink`: re-gate if login-plane wiring changes
- Dev-seed `buildPasswordLoginDeps` vs `buildDevPasswordLoginSeed` precedence: re-gate when old dev path removed

## Verdict format (copy-paste template)

```
CYBERED GO -- [kártya ID] [kártya rövid neve]

[Executive summary magyarul, 2-3 mondat]

Kill-chain 1 ([name]): PASS - [evidence, file:line or behavior]
Kill-chain 2 ([name]): PASS - [evidence]
Kill-chain 3 ([name]): PASS/INFO - [evidence]

[If any INFO: Forward invariant: [what to re-gate when X lands]]
```

## RLS-migration gate: run the e2e LIVE yourself (don't trust the backend's claim)

For a deploy-critical RLS PG-adapter card (tenant/owner/crew isolation), the migration + adapter code review is necessary but NOT sufficient — the decisive proof is the RLS policy ENFORCING live against the exact threat (a compromised non-superuser app-role). The card's e2e is env-gated on `PG_E2E_URL` and self-bootstraps its schema (applies the prereq migrations + creates roles in `beforeAll`). Spin up an embedded PG18 yourself and run it — do not rubber-stamp the backend's "7/7" claim.

**WHICH repo root (card 843abd91): NEVER your own `CleanCore-worktrees/<you>` in place, and NEVER
`store/agent-worktree.sh <assignee> --path`.** The second one resolves the CARD OWNER's own live,
uncommitted working tree (backend's, if you are gating backend's card) — checking out the gate sha
there detaches HEAD out from under whatever they are mid-editing, silently, with no error to either
side (this is the exact shape measured on backend's worktree right after e0a4bb3a's gate: HEAD went
from `agent/backend/work` to a detached `709aa3db`, and it was not backend's own action). Use a
throwaway, process-scoped worktree off the shared clone instead — same shape as
`store/cleancore-pregate.sh` — and remove it when done:
```bash
CC_MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
WT="$HOME/cybered-gate-<sha>-$$"
git -C "$CC_MAIN" worktree add --detach "$WT" <sha>
ln -s "$CC_MAIN/node_modules" "$WT/node_modules"   # + per-package links if the suite needs them
cd "$WT"
# ... run the runner below from $WT ...
cd - >/dev/null; git -C "$CC_MAIN" worktree remove --force "$WT"
```

Runner (run from `$WT` above, never from an agent's own worktree; the module resolves there):
```js
// rls-e2e-runner.mjs
import EmbeddedPostgres from 'embedded-postgres'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const pg = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(),'pg-')), user:'postgres', password:'postgres', port:55443, persistent:false })
await pg.initialise(); await pg.start(); await pg.createDatabase('cctest')
const url = 'postgresql://postgres:postgres@127.0.0.1:55443/cctest'
const r = spawnSync('npx', ['vitest','run','<the-rls-e2e-file>','--reporter=basic'],
  { encoding:'utf8', env:{ ...process.env, PG_E2E_URL:url } })
await pg.stop(); process.exit(r.status ?? 1)
```
Run with the native lib on `LD_LIBRARY_PATH` (else `libicudata.so.60` fails):
```bash
NATIVE="$(pwd)/node_modules/.pnpm/@embedded-postgres+linux-x64@*/node_modules/@embedded-postgres/linux-x64/native/lib"
LD_LIBRARY_PATH="$NATIVE:$LD_LIBRARY_PATH" node rls-e2e-runner.mjs 2>/dev/null | grep -E 'Tests |passed|failed'
rm -f rls-e2e-runner.mjs   # never leave the runner in the repo
```
The `ERROR: new row violates row-level security policy` lines in PG's log are the EXPECTED fail-closed test cases (unset/empty GUC → INSERT rejected), not failures — confirm the vitest summary is `Tests N passed (N)`.

What the RLS e2e must prove (map to the card's isolation dimension): FORCE-RLS on the table; cross-tenant invisibility as `cleancore_app` (non-superuser); the app-predicate scope (owner / crew) pushed into SQL, live-blocked; fail-closed on unset AND empty-string GUC (NULLIF → 0 rows + INSERT rejected); keyset+LIMIT bounded (no full-fetch); migration idempotent. RLS enforces TENANT only — owner/crew scope is the app-predicate, so it's a FORWARD-INVARIANT that every future query on that table carries it (a forgotten predicate leaks intra-tenant; RLS won't catch it). Real cases: client_requests/0022 (e9b42273), crew_members/0023 (beafac74) — both live-proven 7/7.


## URL-validation guards: verify empirically with Node's URL class, not source-reading alone

A hand-rolled string-prefix/regex guard against foreign-origin URLs (`url.startsWith('/') && !url.startsWith('//') && ...`) looks airtight from source-reading but can miss normalization steps the REAL URL parser (browser fetch(), same WHATWG URL Standard) applies before deciding relative-vs-absolute. The concrete, empirically-confirmed class: the WHATWG URL parser strips every ASCII TAB (0x09), LF (0x0A), CR (0x0D) from the input string -- ANYWHERE in the string, not just leading/trailing -- BEFORE parsing. A guard that checks `!url.startsWith('//')` on the RAW string passes a crafted `/` + TAB + `/evil.com` (does not literally start with `//`), but the browser strips the TAB and resolves the remainder as protocol-relative -- foreign origin, token leaks if the client attaches a Bearer token.

**Don't just reason about this from the spec -- verify it with Node, which implements the same WHATWG URL Standard as browsers:**
```js
// write to a scratchpad .mjs file (control chars in the command itself get rejected by Bash) and run with `node file.mjs`
const base = 'https://app.example.com/dashboard'
const candidate = '/' + String.fromCharCode(9) + '/evil.com/x'  // '/' + TAB + '/evil.com/x'
console.log(new URL(candidate, base).origin)  // -> https://evil.com, NOT app.example.com
```
Real case: card abb69117 (`assertSameOriginPath` in `apps/web/src/api/client.ts`, @d75e434) -- correctly rejected literal `//`, `\`, `http://`, `javascript:`, but the raw-string prefix check let `/` + TAB/CR/LF + `/evil.com` through; empirically proven the exact same guard logic passes it while `new URL()` resolves it to a foreign origin. Fix: reject any URL containing an embedded TAB/CR/LF BEFORE running the prefix check (no legitimate API path ever needs these characters) -- 3 lines, no architecture change.

**When to apply:** any time a card's fix/hardening is "check that a caller-supplied path/URL string stays same-origin" (open-redirect guards, CSRF-adjacent origin checks, any token-bearing fetch wrapper). Reproduce the ACTUAL runtime URL-resolution behavior with Node's `URL` class rather than trusting that a string-prefix check is equivalent to what the browser will do -- WHATWG normalization (tab/newline stripping, backslash-to-slash for special schemes, and other quirks) routinely defeats naive prefix/regex validators. This is the same "run it live, don't trust the read" discipline as the RLS-e2e section above, applied to client-side URL parsing instead of Postgres.


## Prod static-asset/SPA verification: HTTP 200 + valid HTML is NOT proof the RIGHT app is served

A `curl GET /some-spa-route -> 200` plus a plausible-looking HTML/script payload feels like proof
a deployed frontend is live, but an nginx/traefik SPA-fallback route (`try_files $uri $uri/
/index.html`) will answer 200 with the SAME fallback HTML for ANY path that doesn't match a real
static file — including a path that was NEVER actually deployed. A dedicated app (e.g.
`apps/superadmin`) that was never built into the image, or never given its own nginx `location`
block, is INDISTINGUISHABLE from a working deploy using only a status-code check: the tenant app's
own SPA-fallback silently answers on its behalf.

**The tell, and how to catch it:** compare the candidate route against a KNOWN-DIFFERENT sibling
route byte-for-byte (ETag, Content-Length, or a hash of the body) — if they're identical, AND an
obviously-nonexistent path under the same prefix (`/superadmin/totally-made-up-xyz`) ALSO returns
the identical response, you're looking at a fallback, not the real app. Then confirm by grepping
the served JS bundle for app-specific markers (a distinctive global var, an import path, a string
literal unique to that app) — their total absence is the definitive proof, not the status code.

```bash
curl -sI "$HOST/"           | grep -i etag   # tenant root
curl -sI "$HOST/superadmin" | grep -i etag   # candidate -- SAME etag = fallback, not the real app
curl -sI "$HOST/superadmin/totally-made-up-xyz" -o /dev/null -w "%{http_code}\n"  # 200 here too = confirmed fallback
curl -s "$HOST/superadmin" | grep -o 'src="[^"]*\.js"' # find the served bundle path, then:
curl -s "$HOST/<bundle-path>" | grep -c "APP_SPECIFIC_MARKER"  # 0 = wrong app served
```

**Real case (card 2134471a, 2026-07-25):** both QA and Cybered's own first-pass GO relied on
`GET /superadmin -> 200 + HTML+script bundle` as proof the superadmin SPA was live. Cybersec's
deeper re-check found `GET /`, `GET /superadmin`, and `GET /superadmin/made-up-xyz` all returned
the IDENTICAL ETag/Content-Length, and the served bundle had zero occurrences of
`__CC_SA_API__`/`__CC_SA_TOKEN__`/`"superadmin"` — the `apps/superadmin` build was never deployed
at all; nginx's tenant-app SPA-fallback was answering every unmatched path. The DONE had to be
reopened. This directly corrects this skill's own earlier verdict on that card — Cybered's own
prior GO was the one that missed it, not just QA's.

**Rule: for any prod SPA/static-frontend deploy-verification gate, NEVER accept a bare 200 as
proof of app identity.** Always do the byte-diff-against-a-sibling-route + fake-path + bundle-
marker check above before crediting a "the frontend is live" claim, your own included.


## Writing ABOUT control characters can itself emit them -- describe, never notate

Trying to type a literal unicode-escape NOTATION (backslash-u followed by four hex digits) as prose inside a verdict, to describe a regex range, can itself get rendered as the ACTUAL raw byte instead of the intended printable escape text -- the same failure class as the backtick/control-char gotchas above, but self-inflicted at AUTHORING time rather than at shell-quoting time. Real case: while writing the abb69117 re-gate verdict (describing a control-character-rejecting regex), the notation itself came out as raw 0x00-0x1F/0x7F bytes in the scratchpad file, making `file` report it as "data" instead of text -- caught only by explicitly grepping the just-written file for those byte ranges before posting.

**Rule: when a verdict needs to describe a control character or a unicode-escape range, NEVER type the escape notation itself -- describe it in words** ("the C0 control-character range, from the null character through unit-separator, plus DEL" instead of the backslash-u notation; "TAB / CR / LF" instead of backslash-t/r/n). This is the SAME rule as `[[hungarian-orthography-rule]]`'s sibling for security prose: name the character class, don't notate it.

**Always verify a just-written scratchpad file before posting**, especially after describing any control-character finding:
```bash
file /path/to/verdict.txt   # must say "text", never "data"
python3 -c "
with open('/path/to/verdict.txt','rb') as f: data=f.read()
import re
print('control-byte matches:', len(list(re.finditer(rb'[\\x00-\\x08\\x0e-\\x1f\\x7f]', data))))
"
```
Both must come back clean (`file` says a text encoding, zero matches) before the `python3 -c` POST step. If either check fails, rewrite the file using the descriptive-words approach above -- do not try to hand-edit out individual bytes.
