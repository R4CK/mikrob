---
name: guarded-rowscoped-read-endpoint
description: Wire a tenant-scoped, RBAC-row-scoped GET (list + by-id) endpoint behind a fail-closed guarded router, with an injected read-store port, no cross/intra-tenant existence oracle, keyset pagination, and non-vacuous tests. Use when adding a read route to a framework-agnostic API that has a central route-policy + guardRoute layer and a domain package exposing an entity but no HTTP handler.
---
# Guarded row-scoped read endpoint

## When to use
Adding a `GET /things` (+ `GET /things/:id`) read endpoint to an API where:
- a central route-policy table + `guardRoute` already enforce shell/action/row-scope BEFORE handlers, and
- the domain package exposes an entity (with `id` + `tenantId`) but no HTTP handler yet.

## Screen first (build only if all pass; else escalate, don't guess)
1. **Dep-ready:** the domain package is ALREADY a dependency of the API app. If not, wiring needs a package-manager lockfile change -- blocked in a shared checkout; escalate.
2. **Unambiguous entity:** exactly one obvious listable entity (with `id`+`tenantId`), exported from the package index. Multiple candidate aggregates or no clear entity => design task, escalate.
3. **No active owner:** no in-flight card/agent owns that route's domain (collision).

## Procedure
1. **New handler file** `things-read.ts`:
   - Define a read-store PORT (don't reuse a CAS/write store if it lacks a tenant list): `listByTenant(tenantId): readonly T[]` + `getById(tenantId, id): T | null` (returns null for foreign tenant -- no oracle).
   - If the action is row-scoped for some role, define an injected scope reader (e.g. `assignedIds(tenantId, userId): ReadonlySet<string>`). In-memory default returns EMPTY => a non-All caller fail-closes to nothing (never the whole tenant). The real DB adapter is a follow-up.
   - `list…Http(ctx, rawPath, deps)`: `const scope = authorizeScoped(ctx, Action.XRead)` (self-authorize, defense-in-depth even though guardRoute already ran); filter `listByTenant(ctx.tenantId)` by `tenantId === ctx.tenantId && inScope(...)`; sort by id; `paginate(rows, pageParamsFromQuery(rawPath), r => r.id)`.
   - `get…Http(ctx, id, deps)`: resolve scope; `getById(ctx.tenantId, id)`; if null OR not-in-scope throw `XNotFoundError` -- the SAME error for absent / foreign-tenant / out-of-scope, so there is NO existence oracle in either direction (this pre-empts the classic 403-vs-404 intra-tenant oracle finding).
   - `inScope`: `scope === All` => true; else membership in the injected set (or `userId === ctx.userId` for self-scoped rosters).
   - Export in-memory adapters (`createInMemoryXStore(seed=[])`, `createInMemoryXAssignmentReader(seed=new Map())`).
   - Name the not-found `XNotFoundError` so a `*NotFoundError` status convention maps it to 404 automatically.
2. **Wire into the app router** (`assembleAppRouter`): add the store(s) to `AppDeps`; `register('GET', '/things', …)` + `register('GET', '/things/:id', (ctx, req) => get…Http(ctx, lastSegment(req.path), deps))`. register() is fail-closed -- it throws if the route has no policy, so the policy must already exist.
3. **Composition root** (`server.ts` or equivalent): wire the in-memory adapters into the real deps.
4. **Update every AppDeps construction site** (server + all test factories) with the new required fields, or the type-check breaks.
5. **Docs:** if the app has a README endpoint table, add the new routes (README must not lie -- same commit).

## Tests (non-vacuous)
- `All`-scope caller lists every tenant row, keyset-paginated (`limit=2` -> 2 items + truthy `nextCursor`; follow cursor -> remainder + null).
- Row-scoped caller with NO assignment => empty (fail-closed); WITH assignment => ONLY the assigned rows.
- by-id: reads a seeded row; absent id AND out-of-scope existing id BOTH throw the same NotFound (assert no oracle).
- RBAC negative: a role denied by the guard (e.g. a portal role on a manager-shell route) throws ForbiddenError BEFORE the handler.
- route-inventory: the new routes are registered (and any sibling routes like `/things/:id/sub` are intact -- anchored patterns don't clash).
- Fixtures: if the handler only reads `id`/`tenantId`/scope, a minimal `{id,tenantId} as unknown as T` cast is honest and avoids constructing irrelevant nested value objects.

## Pitfalls
- A CAS/versioned domain store often has NO tenant-list method -- define a dedicated read-port, don't force it.
- Don't trust `req.scope` alone; re-`authorizeScoped` in the handler (the guard and handler both enforce = defense in depth).
- Never derive tenant from body/path; always `ctx.tenantId`.
- For an auth-critical roster/PII entity, verify no secret fields are exposed and confirm the action's row-scope model (is it in the row-scoped set?) before shipping.
- Adding a required `AppDeps` field breaks EVERY factory (server + tests) -- update them in the same change or type-check fails.

## Verify
`tsc` clean under strict settings (`exactOptionalPropertyTypes`: type optional deps as `T | undefined` or omit-when-absent), the endpoint's own test file green, and the full app test suite green (no regression). Author does not sign off own work -- hand to the review gate.
