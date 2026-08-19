---
name: contract-first-codev
description: Build a user-facing feature's BACKEND and FRONTEND simultaneously (lockstep), not backend-then-frontend, by defining the API contract FIRST and letting the FE build against a mock of it in parallel. Also decides page placement — extend an existing page (compose a feature/widget slice) vs create a new route — by Feature-Sliced Design + IA, so "more functions on a page" doesn't blindly spawn new pages. Use when planning/dispatching any BE+FE feature, or deciding where a new function lives. Triggers: "build backend and frontend together", "contract-first", "API-first", "parallel BE/FE", "egyszerre épüljön a frontend", "hova kerüljön az új funkció", "új oldal vagy bővítés", "feature-sliced".
---

# Contract-First Co-Development (BE + FE in lockstep)

Make the backend feature AND its frontend build **at the same time**, against a shared contract, instead of backend-first-then-frontend. Two industry-established practices combined: **API-first / contract-first** (parallel BE+FE via a mock server) and **Feature-Sliced Design** (a page is composed of feature/widget slices, so adding a function extends a page rather than blindly spawning a new one). This is the execution mechanism for the fleet's rule 8 (frontend-pairing) and rule 9 (flow-connectivity), and it composes with `menu-system-architect` (IA), `menu-screen-backend-wiring` (the surface→endpoint contract), and `react-page-api-wiring` (the mock→real swap).

## When to use
- Planning/dispatching ANY user-facing feature that has both a backend and a frontend part.
- Deciding whether a new function gets a NEW page/route or EXTENDS an existing page.
- Reviewing that a BE and FE were genuinely built in lockstep (not FE bolted on late).

## Part A — Contract-first parallel build

### 1. Define the contract FIRST (before either side codes)
The contract is the single source of truth both sides build against. Capture, as a typed spec (OpenAPI / shared TypeScript types / the `menu-screen-backend-wiring` wiring-map):
- Endpoint(s): method + path, mirroring the IA hierarchy.
- Request + response schema (typed), field by field.
- Error codes + their meaning (and the rule-12 message per error).
- Authz: which roles, tenant/row-scope, entitlement/plan gate.
- Pagination / idempotency-key / rate-limit shape if relevant.
This contract is written INTO the paired cards (below) so BE and FE reference the identical spec. A contract that lives only in one dev's head defeats the whole method.

### 2. Create the paired cards and dispatch them TOGETHER
When a user-facing feature card is created, MikroB immediately creates BOTH:
- the **backend card** (implement the endpoint(s) per the contract), and
- the paired **Fron Ted frontend card** (build the UI + user-flow per the contract),
and dispatches them **simultaneously** to backend + fron-ted — not FE-after-BE. Both cards quote the same contract (§1) and cross-reference each other with a **stated, queryable line** (rule 8a), not prose alone: `Pair-FE: <card>` on the backend card, `Pair-BE: <card>` on the frontend card, filled in by MikroB at CREATION time. (Rule 8 makes the FE card automatic; this skill makes it *concurrent*; rule 8a makes the pairing *queryable*.)

A fleet measurement (card d03b3eea, 2026-08-16) found the concurrency itself already works when a pair is created together (3/3 sampled pairs overlapped in build time) — the actual gap was that most pairs were linked only by a mention in the description text (11/14) rather than a structural, greppable field (10/29 even had `parent_id`), so compliance with rule 8 could not be queried, only estimated. The `Pair-FE:`/`Pair-BE:` line closes that gap; it does not change the timing guidance, which the measurement showed does not need fixing.

### 3. Frontend builds against a MOCK of the contract (does not wait for the backend)
Fron Ted does NOT wait for the live endpoint. It:
- writes the typed API client against the contract's shapes, pointing at a **mock** (MSW / a stub module / demo constants returning contract-shaped data);
- builds the full UI + every state (loading / empty / error / offline) + i18n + responsive (rule 13) against that mock;
- so the entire frontend is finished in parallel with the backend.
When the backend lands, the FE **swaps the mock for the real endpoint** — a small change, not a rebuild (this is exactly `react-page-api-wiring`: replace the DEMO_/mock source with the real API call, keep the states). The mock is contract-shaped, so the swap is mechanical.

### 4. Integration gate at the join
When both sides land, QA runs an **integration pass** verifying the FE↔BE contract holds end-to-end (rule 9 flow-connectivity): every UI action calls the real endpoint, shapes match, error paths render the right state, authz holds both directions. A green FE-against-mock plus a green BE-in-isolation is NOT proof the join works — walk it end to end.

### 5. Contract change = BOTH cards move together
If the contract must change mid-build, the BE and FE cards are updated in the **same** step, and any already-"done" side re-opens to match. (Live example: a backend idempotency fix added a required `movementId` field → the paired FE card was bound-blocked until it mints+sends that field. The mechanism caught the drift instead of silently breaking the join.) Never let one side change the contract unilaterally and leave the other stale.

## Part B — Page placement: extend vs new page (Feature-Sliced Design)

"I want more functions on this page" does **not** automatically mean a new page. Decide by IA + Feature-Sliced Design (FSD):

- **A page is a composition, not a monolith.** Under FSD a page (routable screen) is assembled from **widgets** (independent UI blocks) built from **features** (a user action/capability) and **entities** (domain objects). Adding a function = adding a feature/widget **slice** into the page, not gutting it.
- **Default: EXTEND the existing page** by composing the new feature/widget slice into it, when the new function serves the **same user goal / context** the page already owns (a new section, tab, panel, or card on that page).
- **Create a NEW route/page only when** the function is a **distinct job-to-be-done** — a different user goal, a different entry point, or a different authorization boundary. Then it gets its own canonical home in the nav.
- **The IA (menu system) makes this call, not ad-hoc.** Run `menu-system-architect`: every feature has exactly ONE canonical home, grouped by user goal. It decides extend-vs-new-route and where the slice/route lives. Depth stays ≤3 (+tabs); a page that accretes unrelated features until nobody can find anything is the FSD anti-pattern ("just add one more feature" rot) — split it when cohesion drops.
- **Cohesion test:** if the new function shares data/flow/role with the page's existing content → extend (same page, new slice). If it would force the page to serve two unrelated jobs → new route.

## Roles in the fleet
- **MikroB:** writes the contract into paired BE+FE cards, dispatches them concurrently, runs the IA placement decision (extend vs new route), holds the integration gate, coordinates contract changes across both cards.
- **Backend:** implements the endpoint(s) exactly to the contract; flags any needed contract change to MikroB (never changes it unilaterally).
- **Fron Ted:** builds the full FE against the contract mock (all states, i18n, responsive), composes the feature as an FSD slice into the right page; swaps mock→real when the BE lands.
- **QA:** the integration gate — verifies the end-to-end join (flow-connectivity), not just each side in isolation.

## Pitfalls
- **No contract, "we'll align later"** → the join breaks in integration; the whole parallelism collapses into rework. Contract first, always.
- **FE waits for the BE** → sequential, not parallel; defeats the method. FE builds against the mock. (Measured to be rare once a pair is actually created together — the more common failure is the next one.)
- **The pair is never created together** → a FEAT card ships BE-only, and the FE half only appears later as a follow-up card after a gate or a human notices — this reads as "sequential," but it is really a missing pairing step at dispatch time, not a timing violation once the pair exists. Fix at the source: MikroB creates both cards and both `Pair-*` lines in the same step (§2), not as a later patch.
- **Pairing lives only in prose** → "see card X" in a description is not queryable at scale; a compliance sweep has to grep free text and estimate. Use the `Pair-FE:`/`Pair-BE:` line (§2) so it's a field, not a sentence.
- **Mock drifts from the contract** → FE passes against a fantasy shape, fails at the real swap. The mock must be contract-shaped; when the contract changes, the mock changes.
- **One side changes the contract silently** → the other goes stale. Contract changes move both cards (§5).
- **Every new function spawns a new page** → nav bloat, orphan routes, users lost. Default to extending via an FSD slice; new route only for a distinct job (Part B).
- **A page accretes unrelated features** → low cohesion, unfindable. Split by user goal when cohesion drops.
- **Integration skipped** ("both are green") → a green mock-FE + green isolated-BE is not a working join. Gate the end-to-end.

## Verification (QA gate)
- **Contract exists** and both cards reference the identical spec (endpoints, shapes, errors, authz).
- **Pairing is a field, not a sentence:** the backend card carries `Pair-FE: <card>` and the frontend card carries `Pair-BE: <card>`, pointing at each other, filled in when the cards were created.
- **Parallelism happened:** the FE was built against a mock (has all states/i18n/responsive) before/independent of the live BE — not bolted on after.
- **Swap is real:** the FE now calls the real endpoint (no leftover mock/demo on non-network paths; rule-12 error states wired), verified end to end.
- **Integration (rule 9):** every UI action hits the real function, shapes match, error/empty/permission paths render correctly, authz holds both directions (UI-hide + server-enforce).
- **Placement (Part B):** the feature lives in ONE canonical home; extend-vs-new-route was an IA decision (not ad-hoc); page cohesion is intact; depth ≤3 (+tabs); reachable ≤3 clicks.
- **Contract-change discipline:** if the contract changed mid-build, both cards moved together and neither side is stale.

## Sources (established practice)
- API-first / contract-first + mock-server parallel dev: OpenAPI-driven design-first methodology (frontend+backend point at a contract, integration conflicts caught at design time).
- Feature-Sliced Design: pages ← widgets ← features ← entities ← shared; a page is composed of slices, added features are slices, new routes only for distinct jobs.
(See `frontend-design-research` for current UI patterns; `menu-system-architect` for the IA/placement call; `menu-screen-backend-wiring` for the surface→endpoint contract; `react-page-api-wiring` for the mock→real swap.)
