---
name: full-value-audit
description: Run a FULL-VALUE audit of an app -- inventory EVERY frontend + backend function (every page, button, form, endpoint, module), test every user flow at every RBAC level (positive AND negative authz), walk superadmin flows end-to-end, test every API and every DB operation, optimize with numbers, and cover security/WCAG/i18n/observability/resilience/regression, ending in an audit report with three-gate (QA + Cybersec + Cybered) sign-off. Use whenever "teljes értékű audit", "teljes audit", "auditáld végig", "full audit", "audit everything", "minden gombot/funkciót tesztelj" comes up, or before a release / major milestone. Nothing implicit: un-inventoried or un-tested = treated as broken until proven otherwise.
---

# Full-Value Audit

The bar for calling an audit "done". Partial coverage is NOT a full-value audit -- do not report it as complete. This mirrors the "Teljes értékű audit" rule in the project CLAUDE.md.

## When to Use
- Any request for a "teljes értékű audit", "teljes audit", "auditáld végig", "full audit", "audit everything".
- "Minden gomb / minden funkció legyen tesztelve", "test every button/feature".
- Before a release, major milestone, or handoff to production.
- When verifying that a whole app (not one card) is actually shippable.

## Core Principle
**Nothing is implicit.** Anything not on the inventory and not tested is treated as BROKEN until proven otherwise. Every claim needs evidence: a repro step, a test output, a screenshot, a log line. A green test suite alone is NOT proof (the magic-link auth was 151/151 green and still hid 2 MAJOR bugs that QA + Cybersec caught). No silent gaps: if you did not test something, list it explicitly as "NOT tested / why".

## Procedure

### 1. Full feature inventory (frontend + backend)
- Enumerate and LIST every **frontend** element: each page/route, component, **every button**, link, form, field, menu item, modal, drawer, toast, table action, and each state (loading/empty/error/success). Every button and every function goes on the list with an ID.
- Enumerate and LIST every **backend** function: each module, service, handler, use-case, background job/cron, queue consumer, webhook.
- The inventory is the coverage baseline: every item gets a test result attached. Silent omission is forbidden.

### 2. User flows at EVERY RBAC level
- List ALL roles / permission levels from the actual enum (e.g. anon, user, manager, admin, superadmin) -- not from memory.
- For each end-to-end flow build an **authz matrix**: which role may do what. Test BOTH directions:
  - **Positive:** the authorized role completes the whole flow (every step, every button).
  - **Negative (fail-closed):** the unauthorized role is BLOCKED -- hidden/disabled in the UI AND rejected by the server. UI-hiding is not enough; hit the API directly. Vertical and horizontal privilege escalation (other tenant / other user's data) must be denied.

### 3. Superadmin flows
- Identify and walk EVERY superadmin / elevated-privilege flow end-to-end: login (MFA/TOTP), tenant management, impersonation, feature-flags/config, audit log, dangerous ops (delete, data export).
- Verify: every elevated action is audited (tamper-evident), fail-closed, no DEV-only bypass in prod, and impersonation never leaks across tenant boundaries.

### 4. Every API tested
- For EVERY endpoint: happy path; input validation (missing / wrong type / boundary / injection); authz (step 2); error handling and correct status codes; idempotency; rate-limit; pagination; versioning. Check the tenant-scope invariant on every query (never trust body tenantId).
- **FE/BE path contract check (KIOSK-4/SUBCON-4 pattern):** when a frontend "needs-wiring" card has its paired backend card landed, verify EVERY endpoint: (a) path prefix matches exactly (check server route constants via `git show <sha>:apps/api/src/*.ts | grep isXxxPath\|PATH =`), (b) no Vite proxy stripping (`apps/web/vite.config.ts` -- if no proxy, `/api/v1/...` never reaches `/v1/...`), (c) auth mechanism matches (Bearer header vs HttpOnly cookie vs body token -- structurally incompatible). A FE calling `/api/v1/...` when the server only responds to `/v1/...` will silently fail every request.
- **Factory vs hand-mock (SUBCON-3 pattern):** if an in-memory store has a `createInMemoryXxx()` factory, tests MUST use the real factory -- not a hand-written stub. A stub that always finds the record will hide index-population bugs (e.g. `byEmail` map never filled). Green tests through a mock do NOT prove the real composition works.

### 5. Every DB operation tested
- CRUD on every entity; constraints and FKs; transaction atomicity and rollback; uniqueness / race conditions; migrations up+down and idempotency; tenant isolation; presence of indexes on hot queries; server-side recomputation of derived values (never trust a client-sent total/hash).

### 6. Optimization (performance + scalability)
- Measure and fix: slow / N+1 queries, missing indexes, unnecessary re-renders, oversized payload/bundle, missing cache, memory leaks, O(n^2) hotspots (cap them). Give before/after numbers -- not "feels faster".

### 7. Completeness cover (to be truly full-value)
- **Security:** STRIDE + OWASP Top 10 / ASVS walked (the Cybersec gate), not just happy path.
- **Data integrity / multi-tenant isolation:** tenant-scope invariant provably holds (negative control).
- **Frontend edge cases:** loading/empty/error/offline/long-text/small-screen states.
- **Accessibility (WCAG AA):** keyboard nav, focus trap, contrast, aria.
- **i18n/l10n:** every user-facing string from keys, no hardcode. **Full parity across ALL configured locales** (check `SUPPORTED_LOCALES` or the `packages/i18n/messages/` directory -- not just HU+EN). Run a flatten+set-diff on every locale pair. New keys must land in ALL locales in the same commit (no deferred translations).
- **Observability:** key ops logged/metered, alerts on critical errors, no secrets in logs.
- **Resilience:** external-dependency failure handled (timeout, retry, fail-closed), input caps against DoS.
- **Regression / test pyramid:** unit + integration + e2e; every fix gets a regression test.
- **Secrets/config:** no hardcoded secrets, sourced from env, prod/dev separated.
- **Documentation:** inventory + results + found bugs + repro captured reproducibly (the audit report).

## Execution & sign-off (fleet)
- Split the work by role, and no one verifies their own work:
  - Inventory + optimization: engineering agents + `codebase-auditor` / `performance-optimizer`.
  - Functional testing: `qa-engineer`.
  - Offensive testing: `cybersecurity-redteam` (Cybersec, `white-hat-security-testing` skill).
- MikroB orchestrates: decompose into Phase/Task/subtask kanban cards (see `project-workflow`), dispatch to role-agents via inter-agent messages (never a subagent for fleet work), each finisher goes `waiting` + "REVIEW".
- **Three mandatory gates:** every completed piece passes QA (functional), Cybersec (per-finding security), and Cybered (adversarial red-team: assume-breach, kill-chain, active defense). DONE = QA PASS + Cybersec GO + Cybered GO. No gate verifies its own work.

## Pitfalls
- **Reporting partial as full:** if the inventory is not 100% covered (tested, or explicitly skipped with a reason), it is NOT a full-value audit. Do not claim done.
- **Trusting green tests:** a passing suite is not evidence of correctness. Require repro + adversarial testing. Specifically: tests through hand-written mocks hide factory-level bugs; tests that skip the real `createInMemoryXxx()` factory do not prove the live composition works.
- **Auth mechanism drift:** FE `Authorization: Bearer <localStorage>` and BE `HttpOnly cookie` are structurally incompatible -- FE can never read an HttpOnly cookie. Verify both sides use the SAME mechanism before calling an auth flow complete.
- **UI-only authz check:** hiding a button is not access control. Always test the server/API directly for the negative case.
- **Fabricated optimization wins:** never say "faster" without before/after numbers.
- **Silent truncation:** if you sampled or capped coverage (top-N endpoints, skipped a module), log exactly what was dropped -- silent omission reads as "covered everything" when it wasn't.

## Verification
- The audit report lists the FULL inventory with each item marked PASS / FAIL / NOT-tested (+reason).
- Every role has a completed authz matrix (positive + negative).
- Every found MAJOR/critical issue has a reproducible entry AND a kanban fix/optimization card.
- All three gates signed off (QA PASS + Cybersec GO + Cybered GO) on the tested work.

## Examples
**Example 1:**
Input: "Csinálj egy teljes értékű auditot a terméken."
Output: A Phase/Task kanban tree; a feature inventory (every page/button + every backend handler); per-role authz matrices tested positive+negative; every endpoint + DB op tested; perf before/after numbers; an audit report with PASS/FAIL/NOT-tested per item and fix cards for every MAJOR finding; QA + Cybersec + Cybered sign-off.

**Example 2:**
Input: "Minden gomb, minden funkció tesztelve legyen a dashboardon."
Output: Frontend inventory enumerating every button/form/menu/state with IDs, each exercised and marked PASS/FAIL, edge/empty/error states covered, WCAG + i18n checked, findings turned into cards.
