---
name: menu-screen-backend-wiring
description: Systematically wire a frontend to its backend across the WHOLE app — connect every menu/submenu node, every screen surface, and every interactive control/function to the real backend endpoint it needs, as an optimized and logical data-wiring contract. The frontend agent uses this to turn a menu tree + screen inventory into a complete, no-dead-button, performance-optimized backend integration. Use after the menu system + screens exist and you must connect them to real APIs at scale (not one page). Triggers: "wire the frontend to the backend", "connect the menu/screens to the API", "kösd a menüt/screeneket a backendhez", "menü-backend bekötés", "surface-to-endpoint map", "no dead buttons", "optimize the data wiring", "wiring contract".
---

# Menu ↔ Screen ↔ Backend Wiring

Turn a menu/submenu tree + screen inventory into a COMPLETE, optimized, logical backend integration: every menu node, every screen surface, and every interactive control (button, form, tab, list, filter, action) is connected to the real endpoint it needs — with no dead buttons, no data waterfalls, and one clear source of truth per surface. This is the systematic, whole-app layer that sits between `menu-system-architect` (which builds the tree + screen links and marks nodes `wired`/`needs-wiring`/`needs-build`) and `react-page-api-wiring` (per-page mechanics). Use this to plan and drive the integration; use `react-page-api-wiring` for the concrete per-page code.

## When to use
- The menu system + screens are designed and you must connect them to real APIs across many screens, not one.
- You need a machine-checkable map of "which surface calls which endpoint" before/while building.
- You want the data layer optimized (no N+1, no waterfalls, cached, prefetched) and logical (one query owner per surface), not ad-hoc `fetch` scattered per component.
- QA/Cybersec is verifying that every control reaches a real, authorized function and nothing is decorative.

## Core principles
1. **Every interactive surface maps to exactly one backend contract** (or is explicitly client-only). A button/form/tab/list/filter/action with no endpoint is a dead control → wire it, or remove it, or raise a build card (rule 9 flow-connectivity). No implied-but-unwired feature.
2. **One source of truth per data surface.** A given piece of data is fetched by ONE owner (a query hook / loader), shared down — not re-fetched by three sibling components. Colocate the query with the surface that owns it.
3. **Optimized by construction, not retrofitted.** Parallelize independent loads, prefetch on navigation intent, cache + stale-while-revalidate, cancel on route change. Performance is designed into the wiring map, measured with numbers.
4. **Logical + typed contract.** A typed API client is the single boundary; components never hand-roll URLs or shapes. The contract mirrors the menu hierarchy so the wiring is discoverable.

## Procedure

### 1. Build the wiring map (the deliverable that drives everything)
From the menu tree (`menu-system-architect` output: nodes with `route`, `screen_id`, `feature_ref`) enumerate, per screen, EVERY interactive surface and its backend contract. Emit as structured data so it is diffable and gate-checkable:

```json
{
  "screen_id": "SCR-BILLING-INVOICES-LIST",
  "menu_node": "billing.invoices",
  "route": "/billing/invoices",
  "surfaces": [
    { "id": "invoice-list", "kind": "list",
      "endpoint": "GET /api/invoices", "query": {"page":"keyset","limit":50,"filters":["status","dateRange"]},
      "owner": "useInvoices()", "authz": ["owner","admin"], "states": ["loading","empty","error","permission-denied"],
      "cache": "swr", "prefetch": "on-nav-intent" },
    { "id": "invoice-row-download", "kind": "row-action",
      "endpoint": "GET /api/invoices/:id/pdf", "authz": ["owner","admin"], "optimistic": false },
    { "id": "new-invoice-btn", "kind": "action",
      "target_route": "/billing/invoices/new", "endpoint": null, "note": "navigation only, form on next screen" },
    { "id": "status-filter", "kind": "filter",
      "endpoint": "GET /api/invoices?status=", "debounce_ms": 300, "owner": "useInvoices()" }
  ]
}
```

Rules the map must satisfy:
- **Every surface has one of:** a real `endpoint`, or a `target_route` (pure navigation), or `client_only: true` with a reason. Anything else = dead control → fix.
- **`owner`** names the single hook/loader responsible; sibling surfaces that need the same data reference the same owner (no duplicate fetch).
- **`authz`** lists the RBAC values allowed — and this is the CLIENT hint only; the server is the real gate (see §5).
- **`states`** every data surface declares loading/empty/error/permission-denied (offline for PWA).

### 2. Verify the backend contract exists (evidence, before wiring)
For each `endpoint` in the map, confirm it EXISTS in the backend (grep the router/handlers) with the assumed method, request shape, response shape, pagination style (offset vs keyset — verify, don't assume), and authz. Mark each `wired` / `needs-wiring` (endpoint exists, FE not connected) / `needs-build` (endpoint missing). A `needs-build` surface does NOT get a fake wire — raise a build card and leave the control in a disabled/coming-soon state, honestly. Never invent an endpoint shape from the UI's wish.

### 3. Typed client, organized by menu hierarchy
One typed API module per feature area, mirroring the menu tree (so wiring is discoverable and the contract is the single boundary). Follow `react-page-api-wiring` for the client file + `encodeURIComponent` on path segments + never interpolate raw input into URLs. Each module exports a flow-connectivity manifest comment listing `METHOD /path -> fn() [wired|needs-...]`. Components import functions, never build URLs.

### 4. Optimize the data wiring (designed in, with numbers)
Apply per surface, and record the before/after where it matters:
- **Kill waterfalls:** independent loads run in parallel (`Promise.all` / parallel loaders), never sequential awaits that could be concurrent. A screen needing template-list + site-list fetches both at once.
- **Avoid N+1 on the client:** a list + per-row detail must use a batch/list endpoint, not one request per row. If the backend forces N+1, raise a backend card for a batch endpoint.
- **Cache + stale-while-revalidate:** cache per route/key; show cached instantly, revalidate in background. Dedupe in-flight identical requests (one request for N subscribers).
- **Prefetch on intent:** prefetch a node's primary data on nav hover/focus/route-intent so the screen paints fast; prefetch the next page of a list near the scroll end.
- **Code-split per menu section:** each top-level tree/section lazy-loads its bundle; the shell + primary nav load first (matches the shell-first screen order).
- **Debounce/throttle** search + filter inputs (~300ms); **cancel** stale/aborted requests on route change or new keystroke (AbortController), guard against setState-after-unmount.
- **Pagination:** keyset/cursor for large or hot lists; never fetch-all-then-paginate-on-client. Payloads lean — request only the fields the surface renders.
- **Optimistic mutations** for fast-feedback actions, with rollback on failure (guard `null` state per `react-page-api-wiring`).
Give real numbers (requests saved, TTI/payload before→after), not "feels faster".

### 5. Authz is server-side; the wire is fail-closed
- The `authz` list in the map hides/disables controls in the UI — this is presentation only. The SAME action MUST be authorized server-side; a user who forges the request (URL-type, curl) is rejected (403/402). Never treat UI-hide as the gate. Cross-tenant/horizontal access fails closed.
- Mutations that change server state re-validate on the server (never trust client-sent totals/ids/tenantId); the wire sends intent, the server recomputes truth.

### 6. Error + empty + offline on EVERY wired surface (rule 12)
Every wired surface renders loading / empty(with CTA) / error(descriptive, i18n, retry) / permission-denied, and PWA offline fallback where applicable. Error copy is descriptive + i18n-keyed + wired into the flow at the right place (inline/toast/error-screen with the correct next action), never a raw status/stack. Follow `react-page-api-wiring` §3–6 for the state machine, the "no demo data on 5xx" rule, and the i18n gate. A wired control whose failure path is a raw error or a dead-end = FAIL.

### 7. Test the wiring
Per surface: loading / success / error(5xx→error not demo) / 403(forbidden) / offline, and retry re-fetches. For mutations: optimistic apply + rollback on failure. Use the `react-page-api-wiring` test template. The wiring map is the checklist — every surface row has a test.

## Output artifacts
1. **Wiring map** (JSON/YAML) — screen × surface → endpoint/owner/authz/states/cache/prefetch (§1). The master contract.
2. **Contract-existence report** — each endpoint `wired`/`needs-wiring`/`needs-build` with evidence (§2), + build cards for gaps.
3. **Typed client modules** organized by menu hierarchy, with flow-connectivity manifests (§3).
4. **Optimization notes** — the perf decisions per surface with before→after numbers (§4).
5. **Test matrix** — surface × (loading/success/error/403/offline/retry/rollback) (§7).
Keep the wiring map living: adding a screen/control updates it in the SAME work.

## Pitfalls
- **Dead buttons / no-op controls:** a surface with no endpoint, no target route, and no client-only reason. The #1 flow-connectivity failure. Every surface resolves to something real.
- **Duplicate fetching:** three sibling components each fetching the same list. Assign ONE owner, share down.
- **Data waterfalls:** sequential awaits for independent data. Parallelize.
- **Client N+1:** one request per row. Use a batch/list endpoint (or raise a backend card).
- **Fabricated endpoint shapes:** wiring the UI to an endpoint that doesn't exist or whose shape you guessed. Verify against backend source first (§2).
- **UI-hide as security:** hiding a control without server authz → URL/curl bypass. Server is the gate.
- **No cancellation:** stale responses overwrite fresh state on fast nav; setState-after-unmount warnings. AbortController + cancel flag.
- **Fetch-all then client-paginate** on a hot list → huge payload. Keyset pagination server-side.
- **Raw error surfaced:** a wired control failing to a stack/status instead of a descriptive, flow-wired, i18n error (rule 12).
- **Scattered `fetch` + hand-rolled URLs** in components instead of the typed client boundary → drift, injection risk, untestable.
- **Retrofitting perf:** wiring everything naively then "optimizing later". The map designs parallel/cache/prefetch in from the start.

## Verification (QA/Cybersec gate)
Treat the wiring as failing until all pass:
- **Completeness:** every interactive surface on every screen appears in the wiring map and resolves to a real endpoint OR a navigation target OR an explicit client-only reason. Zero dead controls.
- **Contract truth:** every `endpoint` exists in backend source with the mapped method/shape/pagination/authz (evidence); `needs-build` gaps have build cards and honest disabled UI (no fake wire).
- **One owner per surface:** no duplicate fetching of the same data by siblings; shared via a single owner.
- **Optimized:** no waterfalls (independent loads parallel), no client N+1, caching + prefetch on the hot paths, keyset pagination on large lists, debounced inputs, cancellation on route change — with before→after numbers.
- **Authz both directions:** UI hides/disables per role AND the server rejects the forged request (403/402), verified by actually calling the API as an unauthorized role; cross-tenant fails closed; mutations recompute server-side (no trusted client totals/tenantId).
- **States on every wired surface:** loading/empty/error/permission-denied(+offline PWA), error copy descriptive + i18n + flow-wired with the correct next action (rule 12).
- **Tested:** each surface has loading/success/error/403/offline/retry tests; mutations test optimistic apply + rollback.
- **Responsive:** wired controls usable on mobile + desktop (rule 13), touch targets ≥44px, no horizontal scroll.
A green build is NOT sufficient — exercise each surface end to end, as each role, and confirm the real request fires, is authorized correctly, and every failure path lands somewhere useful.

## Notes for a multi-tenant SaaS fleet
- Tenant scope comes from host/JWT server-side; the wire never sends a trust-bearing `tenantId` the server obeys.
- Entitlement-driven: a disabled module's controls disappear because the menu tree filters them (menu-system-architect §6), and the server 402s if forged.
- Composes with: `menu-system-architect` (tree + screen inventory upstream), `react-page-api-wiring` (per-page code), `guarded-rowscoped-read-endpoint` / `injected-port-adapters` (backend side of the contract), `async-refactor-fail-open-guard` (mutation authz async wiring).
