---
name: menu-system-architect
description: Build the COMPLETE multi-level menu + submenu (navigation) system of an app from its USER flow AND its ADMIN/superadmin flow, grounded in the project's actually-implemented features + product description, then wire every menu node to a real screen and drive Stitch/Claude-design screen generation from it. The menu is the SPINE that shapes every screenshot. Use when you must turn flows + a feature set into a logically-structured, deep navigation tree and connect it to the designs. Triggers: "build the menu system", "menü és almenü", "menü rendszer", "almenü", "többszintű navigáció", "navigációs fa", "kösd a menüt a designhoz/screenekhez", "admin menü", "user + admin flow menu", "menu-driven screens".
---

# Menu System Architect

Turn an app's **user flow** and its **admin/superadmin flow** into a single, logically-built, multi-level **menu + submenu** system, where every node is grounded in a REAL implemented feature and wired to a REAL screen — and then let that menu tree DRIVE the Stitch/Claude-design screen generation. The menu is not decoration bolted on at the end; it is the navigational spine that shapes every screenshot (active item, breadcrumb, siblings, depth).

This skill is CONSTRUCTIVE (it produces the tree + the screen linkage). Its sibling `user-flow-menu-design` covers the broader IA/flow design + QA gate; use this one when the flows already exist (or you can derive them) and the deliverable is the concrete, deep, design-linked menu tree. Compose with `frontend-design-research` (visual direction), `ui-visual-design-styles` (look), and the Stitch handoff.

## When to use
- You have (or can derive) the user journeys AND the admin journeys, and need the navigation structure.
- The app has ≥2 role trees that must NOT be flattened into one menu (end-user app vs admin/superadmin console).
- A feature set exists in code/spec and you need each feature to have exactly one logical home in the nav.
- You are about to generate screens (Stitch/Claude design) and want the menu to drive per-screen context so the chrome is consistent across all screenshots.
- QA is checking that the menu is complete, logical, deep-enough-but-not-too-deep, and every node reaches a real function.

## Core principle: two trees, derived not invented, screen-linked
1. **Two (or N) parallel trees, never one flattened menu.** The **user/app tree** serves the product's jobs-to-be-done. The **admin/superadmin tree** serves platform/cross-tenant operations. They have different shells, different entry points, different RBAC. Design them side by side; a shared component may render both, but the STRUCTURE is separate. (More trees if the product has distinct surfaces: e.g. app, client-portal, field-PWA — each gets its own tree.)
2. **Menu = f(flows, implemented features, role, entitlement).** Every menu node traces to a real, shipped feature (evidence required — see §1). Every implemented user-facing feature has exactly ONE canonical home (plus optional shortcuts). No orphan features, no nodes leading nowhere.
3. **The menu drives the screens.** Each leaf node maps to a screen; each screen inherits its position (breadcrumb, active state, sibling tabs) FROM the tree. The tree is generated first, then feeds the per-screen design prompt.

## Procedure

### 1. Ground truth: harvest the REAL feature set (evidence, not memory)
Never build the menu from the product pitch alone. Enumerate what actually exists, with a source per item:
- **Routes / pages**: grep the router(s) and page/route files — the app's real URL surface.
- **Backend capabilities**: handlers, use-cases, endpoints, background jobs, module catalog / feature-flags / entitlement table.
- **Roles / RBAC enum**: the real permission enum (anon, user, manager, admin, superadmin — whatever the code says, not fabricated).
- **Product description**: read the project README / spec for the intended jobs-to-be-done and the naming language (so menu labels match the product's vocabulary).
Output a **feature inventory table**: `feature | user goal | primary role(s) | required permission | required module/plan | data entity | evidence (file:line)`. A feature with no evidence is a candidate to build or to drop — flag it, don't silently menu it. A feature with evidence but no menu home is an orphan to place.

### 2. Split by tree, then by flow
For EACH tree (user, admin, + any extra surface):
- List the flows that live in that tree (from the user flow / admin flow you were given or derived). User tree: onboarding, core task loop(s), settings/account, billing, search→detail. Admin tree: tenant management, impersonation, feature-flags/config, audit log, dangerous ops (delete/export), platform metrics, MFA/step-up.
- Every flow's every step must land on a node in that tree. A flow step with no menu/route home = missing node → add it or raise a build card.

### 3. Group logically (the "logically built" requirement — this is the heart)
Structure is never arbitrary. Apply these rules IN ORDER and record WHY each group exists:
- **Group by user goal / mental model, NOT by database table.** "Scheduling", "Billing", "Team" — not "rows in table X". The user's task decides the group.
- **Miller's law: 5–9 top-level items per tree.** More than ~9 → introduce a grouping level or move rarely-used items to Settings/utility. Fewer than 3 → probably under-grouped.
- **Frequency + criticality ordering.** Most-used job first; destructive/rare (danger zone, billing) last or in Settings.
- **Depth: 3 primary levels, 4th only for tabs/actions.** L1 Section → L2 Group/Sub-section → L3 Item (a real screen) → L4 in-page tab / row-action. Core jobs reachable in **1 click**, ANY feature in **≤3**. If something needs level 5, the grouping is wrong — re-group.
- **Utility ≠ primary.** Account, notifications, help, search, workspace/tenant switcher live in the top-bar utility cluster, never in the primary nav.
- **Contextual ≠ global.** Actions on the current object (edit, delete, the object's sub-tabs) are contextual (breadcrumb + in-page tabs), not global menu items.
- **One canonical home per feature.** Cross-links/shortcuts are allowed but each feature is "owned" by exactly one node. Document duplicates as shortcuts, not second homes.
- **Consistency of language.** A feature is named identically in the menu, breadcrumb, page title, and search. Match the product's own vocabulary from §1.

Write down, per group, a one-line rationale ("why this cluster, why this order"). If you cannot justify a group in one sentence, it is not logical yet.

### 4. Emit the menu tree as a machine-checkable spec
Produce the tree as structured data (JSON/YAML), one node object per menu entry, so it can be diffed, filtered by role, and consumed by both the renderer and the design step. Suggested node schema:

```json
{
  "id": "billing.invoices",
  "tree": "user",                 // user | admin | portal | field | ...
  "level": 2,                     // 1..4
  "parent": "billing",
  "label_key": "nav.billing.invoices",   // i18n key, never hard-coded copy (rule 12/i18n)
  "icon": "receipt",
  "route": "/billing/invoices",   // real, deep-linkable, mirrors the hierarchy
  "screen_id": "SCR-BILLING-INVOICES-LIST",
  "feature_ref": "invoices.list",         // ties back to the §1 feature inventory
  "roles": ["owner", "admin"],            // RBAC enum values that SEE it
  "module": "billing",                    // entitlement / plan gate (optional)
  "children": ["billing.invoices.detail"],
  "states": ["default","loading","empty","error","permission-denied"],
  "wired": "wired"                        // wired | needs-wiring | needs-build
}
```

Rules the spec must satisfy: routes mirror the hierarchy (`/a/b/c`), every node has an i18n `label_key` (no hard-coded strings, all configured locales — i18n parity), every node has `roles`, every leaf has a `screen_id` + `feature_ref`, and `wired` is honest.

### 5. Wire menu → screen → design (the linkage that drives screenshots)
This is why the menu exists before the screens. For every LEAF node:
- Create/point to a **screen** (`screen_id`) at the node's `route`.
- The screen's design context is DERIVED from the tree: its breadcrumb = path from root; its active nav item = this node; its sibling tabs = its L4 children or its parent's children; the chrome (which nav tree, which shell) = its `tree`. This guarantees every screenshot shows the SAME nav, consistently, in the right state.
- Build the per-screen Stitch/Claude-design prompt by injecting the tree context. Minimal template:

```
Surface/shell: <tree> app shell — <primary nav visible: this section active> + top-bar utility.
Breadcrumb: <root › section › group › this>.
Active nav item: <label>.  Sibling tabs (if any): <L4 children>.
User: <role> doing <goal>.  Goal: <the one job this screen exists for>.
Layout + key content & actions: <from the feature>.
Required states: default, loading, empty (with CTA), error, permission-denied <+ surface-specific>.
Visual style: <chosen reference from frontend-design-research> — <tokens>. Typography: <font stack, full diacritic coverage>. White-label: <token replaces reference accent>.
```

- **Generation order follows the tree**, shell-first: auth → app shell + primary nav (locks the chrome the whole tree inherits) → L1 landing screens → L3 list screens → detail → forms → per extra tree (admin console, portal, field-PWA) repeat → system screens (empty/404/403/offline) last. Generating the shell first is what makes the menu visibly consistent across all screenshots.
- If a leaf's feature is `needs-build` (exists in menu logic but not in code), DO NOT generate a fake screen — mark it and raise a build card; the menu documents the gap instead of hiding it.

### 6. RBAC / entitlement filtering (both trees)
Define each tree as a full superset, then FILTER per role + per enabled module + per plan at RENDER time. Never hard-code a per-role menu. Two hard rules:
- **UI-hide is presentation, not security.** A node hidden from a role must ALSO 403/402 server-side if the user types the URL. Menu filtering and server authz are separate; the menu is never the gate.
- **Admin tree is fail-closed + separate.** The superadmin tree is not a branch of the user tree the user "can't see"; it is a separate console behind its own auth/step-up. Cross-tenant nav must fail closed.
Produce an **entitlement matrix**: `node × role × plan/module → visible? reachable-server-side?`.

### 7. Responsive + accessible nav (rule 13)
- Mobile: primary nav → drawer/hamburger or bottom tab bar; utility → account sheet; deep submenus → accordion or nested sheet, never a hover-only flyout. Touch targets ≥44px.
- Keyboard: full tree operable by keyboard, visible focus, skip-to-content, roving-tabindex on menus.
- ARIA: `nav` landmarks, `aria-current="page"` on the active item, `aria-expanded` on groups, accessible menu buttons; WCAG-AA contrast on every nav state (default/hover/active/disabled). Both mobile and desktop verified.

## Output artifacts
1. **Feature inventory** (with evidence) — §1.
2. **Menu tree spec** (JSON/YAML) — one node per entry, both/all trees — §4.
3. **Sitemap/IA tree** (human-readable nested view) per tree.
4. **Entitlement matrix** (node × role × plan) — §6.
5. **Screen linkage table**: node → screen_id → route → per-screen Stitch/Claude prompt — §5.
6. **Generation order list** (shell-first) — §5.
Keep them as living docs; when a feature/module is added, the tree spec + linkage table update in the SAME work.

## Pitfalls
- **One flattened menu** mixing user and admin items → admin ops leak into the app / users confused. Keep the trees separate.
- **Menu from the pitch, not the code** → orphan nodes to nowhere and missing screens for shipped features. §1 evidence is mandatory.
- **Grouping by DB table** instead of user goal → nobody can find anything.
- **Too deep** (level 5+) → re-group; or **too flat** (20 top-level items) → introduce grouping. Enforce Miller 5–9 and depth ≤3 (+1 for tabs).
- **Hard-coded per-role menus** → drift + cross-role leakage. Superset + filter.
- **UI-hide treated as security** → URL-typing bypass. Server authz is the gate.
- **Screens generated before the tree** → inconsistent chrome, wrong breadcrumbs, wasted regen. Tree first, shell screen second, then the menu drives the rest.
- **Hard-coded menu labels** → i18n break. Every node is an i18n key, all configured locales.
- **Faking a screen for a `needs-build` feature** → design lies about what exists. Mark the gap, raise a card.
- **Hover-only flyouts on mobile** → unusable. Accordion/sheet on touch.

## Verification (QA uses THIS as the gate)
Treat the menu as failing until all pass:
- **Two-tree separation**: user and admin/superadmin trees are structurally separate; no admin op reachable from the user tree; admin console behind its own auth.
- **Grounding**: every node has a `feature_ref` that resolves to real code (§1 evidence); zero orphan features (every shipped user-facing feature appears exactly once); zero nodes without a screen.
- **Logical structure**: each group has a one-sentence rationale; 5–9 top items/tree; depth ≤3 (+tabs); core jobs ≤1 click, any feature ≤3; ordering by frequency/criticality justified.
- **Wiring (flow-connectivity)**: every leaf's `wired` status is honest; `needs-wiring` targets that EXIST are wired before pass; `needs-build` has a build card. No decorative/no-op nodes, no dead ends.
- **RBAC correctness**: for each role × plan × module, the rendered menu matches the entitlement matrix, AND URL-typing a hidden node 403/402s server-side (verified, not just absent from menu). Cross-tenant fail-closed.
- **Screen linkage**: every leaf → a `screen_id` whose design shows the correct breadcrumb, active item, siblings, and shell; generation order is shell-first.
- **i18n**: every `label_key` present in ALL configured locales, no hard-coded copy.
- **Responsive + a11y**: nav works on mobile (drawer/sheet, ≥44px) and desktop, keyboard-operable, `aria-current`/`aria-expanded`/landmarks present, WCAG-AA on all nav states.
- **Deep-link/refresh**: every node route is deep-linkable, refresh-safe, back-button-correct.
A green visual mock is NOT sufficient — walk each tree end to end, at each role, and try to reach every node and every error branch.

## Notes for a multi-tenant SaaS fleet
- Entitlement-driven: menu renders from `module_catalog` + plan + RBAC; disabling a module hides its node automatically. Never hard-code.
- Tenant resolution from host/JWT, never an editable `?tenant=` in the route.
- White-label: nav chrome renders per-tenant brand tokens via the shared brand-token validator.
- This skill feeds the Stitch handoff in `user-flow-menu-design` (§ Google Stitch handoff): the menu tree IS the screen inventory + generation backlog.
