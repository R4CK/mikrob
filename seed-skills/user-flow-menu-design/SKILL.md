---
name: user-flow-menu-design
description: Design (Fron Ted) and verify (QA) the COMPLETE user flow and menu/navigation system of a web app from its foundational website structure plus its feature/module set. Use whenever building or reviewing an app's information architecture, navigation, menus, routing, or end-to-end user journeys -- before building screens, and when checking that every feature is reachable and every flow is complete. Triggers: "design the menu/navigation", "user flow", "information architecture", "site map", "menü rendszer", "felhasználói flow", "navigáció", "hova kerüljön ez a funkció".
---

# User Flow & Menu System Design

Design the full information architecture (IA), navigation, and end-to-end user journeys of a web app. Fron Ted uses this to DESIGN; QA uses the same model to VERIFY (every feature reachable, every flow complete, no dead ends). The menu is never invented ad hoc -- it is DERIVED from (1) a website's foundational structure and (2) the app's actual feature/module set and the user's role.

## When to use
- Before building any screens for a new app/product or a major feature area.
- When a new feature/module is added and you must decide WHERE it lives in the nav.
- When reviewing whether an app's navigation is complete, consistent, and role-correct (QA gate).
- When a stakeholder asks "where should this go in the menu?" or "design the menu/flow".

## Core principle: derive, don't invent
Menu structure = f(foundational web structure, feature set, user role, plan/entitlement). Every menu item must trace to a real feature; every feature must have exactly one canonical home in the nav (plus optional shortcuts). No orphan features, no menu items that lead nowhere.

## Procedure

### 1. Foundational web structure (the skeleton every web app shares)
Lay down the base layers first -- these exist regardless of features:
- **Public/marketing layer** (pre-auth): landing, pricing, features, legal (ToS/Privacy), contact, login/signup entry.
- **Auth layer**: sign up, log in, magic-link/SSO, password/2FA, email verification, accept-invite, logout.
- **App shell** (post-auth): persistent chrome = top bar (logo, global search, notifications, account menu, tenant/workspace switcher) + primary navigation (sidebar or top nav) + main content area + optional contextual right panel + footer.
- **Account & settings layer**: profile, security, notifications, billing/plan, team/members & roles, integrations, danger zone.
- **System layer**: 404, 403/permission-denied, 500/error, maintenance, empty-tenant/first-run onboarding.
- **Admin/superadmin layer** (if applicable): separate or gated area for cross-tenant/platform operations.

### 2. Feature & module inventory
List every feature the app ships, and crucially mark each one's gating:
- Source of truth: the module catalog / feature flags / entitlements (e.g. a `module_catalog`, plan tiers, RBAC permissions). In a multi-tenant SaaS the menu is **entitlement-driven**: a tenant only sees modules it has enabled, a user only sees what their role permits.
- For each feature capture: name, the user goal it serves, primary role(s), required permission, required module/plan, and its data entity (so detail/list/create routes follow).

### 3. Map features to IA (the menu)
- **Primary nav** = the top ~5-9 jobs-to-be-done, not raw entities. Group by user goal, not by database table. Order by frequency of use.
- **Secondary nav** = sub-sections within a primary area (tabs or sub-menu).
- **Utility nav** = account, settings, help, notifications (in the top bar, not the primary nav).
- **Contextual nav** = actions on the current object (breadcrumbs, in-page tabs, action buttons).
- Rule of thumb: a user should reach any feature in <= 3 clicks; the most frequent jobs in 1.
- Role/entitlement: define the menu as a full superset, then FILTER per role + per enabled module + per plan. Never hard-code; the menu renders from the entitlement model so disabling a module hides its menu entry automatically.

### 4. Routing & URL design
- Stable, human-readable, hierarchical URLs that mirror the IA: `/sites`, `/sites/:id`, `/sites/:id/zones`, `/settings/billing`.
- Tenant scoping: subdomain or path prefix; never put another tenant's id in a trust-bearing position (the resolver derives tenant from host/JWT, not from a URL the user can edit).
- Deep-linkable: every meaningful state has a URL (shareable, back-button-correct, refresh-safe).

### 5. End-to-end user flows (journeys)
For each KEY journey, draw the step-by-step path through the screens. Always design at least:
- **First-run / onboarding**: signup -> verify -> create/seed tenant -> invite team -> reach the "aha" core action. No dead end; always a clear next step.
- **Core task loop**: the 1-3 jobs the product exists for, start to finish (entry -> do -> confirm -> back to list).
- **Invite / role / offboarding**: add member, set role, accept invite, remove member.
- **Billing / plan change / trial-expiry**: upgrade, downgrade, payment failure, trial -> grace (read-only) -> lockout.
- **Settings / account changes**, **search -> result -> detail**, **error & recovery** paths.
For each step define: trigger, screen, primary action, success destination, failure/branch destination.

**Flow-connectivity (BINDING — Peti 2026-07-10): every flow must be WIRED to every function it touches.**
For each flow, enumerate every backend function / endpoint / adjacent feature it touches or can
reach, and confirm each is actually connected — no decorative buttons, no no-op actions, no dead
ends, no feature that the flow implies but never links to. A step that "shows a button" but isn't
drotozott to the real function is a MISSING WIRING, not a detail. If a needed connection is
missing: **wire it if the target function EXISTS; if it does NOT exist, raise a new card to build
it** (don't silently leave the flow incomplete). In the flow artifact, list the touched functions
and mark each `wired` / `needs-wiring` / `needs-build`. This applies to reachability AND to every
sideways connection (a scan-action-menu must actually invoke maintenance/consignment/custody; a
detail page must actually call every action it offers).

### 6. Every screen's required states
A screen is not "designed" until all of these are specified: default, **loading**, **empty** (with a guiding call-to-action), **error**, **partial/slow**, **permission-denied**, and (for lists) zero/one/many/overflow + pagination. Empty states are part of the flow, not an afterthought -- they drive onboarding.

### 7. Responsive & accessibility
- Mobile: primary nav collapses to a drawer/hamburger; utility actions to a bottom bar or account sheet; capture-only/touch considerations.
- Keyboard: full nav operable by keyboard; visible focus; skip-to-content.
- ARIA: nav landmarks, `aria-current` on the active item, accessible menu buttons; WCAG-AA contrast on all nav states.

### 8. Output artifacts (Fron Ted produces)
1. **Sitemap / IA tree** (text or diagram): every page, nested.
2. **Navigation spec**: primary/secondary/utility items, each with its route, icon, required role+module+plan.
3. **User-flow diagrams** for each key journey (steps + branches).
4. **Entitlement matrix**: feature x role x plan -> visible? enabled?
5. **State inventory** per screen.
Keep these as living docs alongside the design; update when a feature/module is added.

## Pitfalls
- Menu organized by database tables instead of user goals -> users can't find anything.
- Hard-coded menu instead of entitlement/role-driven -> disabled modules still show, or cross-role leakage.
- Features with no home in the nav (orphans) or duplicated in many places with no canonical home.
- Onboarding/empty states skipped -> new tenant lands on a blank screen with no next step.
- Deep features buried >3 clicks; most-frequent action not reachable in 1.
- URLs that aren't deep-linkable / break on refresh / back button.
- Putting tenant id in an editable URL position (cross-tenant nav risk -- coordinate with the security model).
- Designing only the happy path; missing 403/empty/error destinations leaves dead ends.

## Verification (QA uses THIS section as the gate)
Treat the design as failing until all pass:
- **Reachability**: every shipped feature is reachable from the nav for at least one role; produce the full feature list and tick each off against the sitemap. Zero orphans.
- **Flow-connectivity (BINDING — Peti 2026-07-10)**: every flow is WIRED to every function it touches. Produce, per flow, the list of touched backend functions/endpoints/adjacent features and verify each is actually invoked (no decorative/no-op buttons, no dead-end actions, no implied-but-unlinked feature). A button not connected to its real function is a FAIL (missing wiring), not a note. Missing connection whose target EXISTS -> must be wired before pass; target that does NOT exist -> a build card must exist. Reachability is necessary but NOT sufficient — connectivity is the stronger check.
- **No dead ends**: every flow's every branch (success AND failure/empty/permission-denied) has a defined next destination; no screen leaves the user stuck.
- **Click-depth**: core jobs <= 1 click, any feature <= 3; flag violations.
- **Role/entitlement correctness**: for each role x plan x module combination, the visible menu matches the entitlement matrix exactly -- and a user CANNOT navigate (by URL typing) to a feature they lack permission/module for (it must 403/hide, verified, not just be absent from the menu). This is a security-adjacent check; cross-tenant nav must fail closed.
- **Consistency**: active-item highlight, breadcrumbs, back behavior, and naming are consistent across the app; the same feature is named the same everywhere.
- **States present**: each screen has loading/empty/error/permission-denied defined.
- **Responsive + a11y**: nav works on mobile (drawer) and by keyboard; `aria-current` + landmarks present; WCAG-AA contrast on nav states.
- **Deep-link/refresh**: every meaningful state has a stable URL that survives refresh and back.
A green visual mock is NOT sufficient -- walk each user flow end to end and try to reach every feature and every error branch.

## Notes for this fleet (multi-tenant SaaS context)
- Multi-tenant SaaS with a `module_catalog` + plan tiers + RBAC: the menu MUST be entitlement-driven (per-tenant enabled modules, per-user role, per-plan). Reuse the tenant-scope invariant -- nav filtering is presentation; server-side authz (402/403) is the real gate (never UI-hide-only).
- White-label theming: nav chrome must render per-tenant branding via the shared brand-token validator.
- Coordinate the URL/tenant-resolution design with the security model (host/JWT-authoritative tenant, never `?tenant=`).

## Google Stitch handoff

Once the IA is designed and the screen inventory is locked, prepare per-screen Stitch prompts so visual generation can start the moment the visual direction is chosen. This workflow runs AFTER steps 1-8 above.

### Step 1 -- derive the project-level brief (STITCH-DESIGN-BRIEF.md)

Write a single markdown file that Stitch receives as persistent context for every generation:

- **Product + surfaces**: what the app does; list each distinct UI surface (e.g. Manager Web desktop-first, Field PWA standalone-app, Client Portal) with its primary user and device.
- **Visual tone**: one paragraph -- the feeling to evoke (e.g. "Linear/Vercel-level polish, professional B2B, not playful") with 2-3 real-world reference products as anchors.
- **Design-token contract**: name the CSS custom properties that carry the tenant brand (primary, secondary, accent, surface, text). Stitch must reflect these as variables, not hard-coded values.
- **PWA constraints** (if any): display mode, bottom tab bar, no browser chrome, safe-area insets, large touch targets, bottom sheets instead of modals, capture-only camera.
- **Accessibility floor**: WCAG AA minimum; list the three must-pass contrast pairs.
- **Screen inventory** (section 7 of the brief): ordered list of every screen, grouped by surface. This is the generation backlog.

Paste the full brief into Stitch before any per-screen prompt -- it sets the shared context Stitch carries across all screens.

### Step 2 -- per-screen prompt structure

One prompt per screen. Each prompt covers exactly:

```
Surface: <surface name and device target>
User: <role> doing <goal>
Key content & actions:
- <content element 1>
- <action / CTA>
- ...
Required states: <comma-separated: default, loading, empty, error, permission-denied, + surface-specific>
[For PWA screens add:]
Standalone-app styling: bottom tab bar, no browser chrome, large touch targets (44px min),
bottom sheets, momentum scrolling, safe-area insets, per-tenant theme-color from manifest.
[VISUAL DIRECTION: <placeholder replaced with chosen references after stakeholder approval>]
```

Keep each prompt under 200 words. The `[VISUAL DIRECTION]` line is intentionally a placeholder -- leave it blank until the stakeholder selects references (see Step 3).

### Step 3 -- visual direction gate

Before generating, the stakeholder must choose the visual direction. Workflow:

1. Run `frontend-design-research` skill: publish 5-8 curated awwwards/dribbble links with one-line rationale each.
2. Stakeholder picks 1-2 references. Their choice becomes the `[VISUAL DIRECTION]` fill-in:
   `"Visual style: inspired by [title + URL] -- [1-sentence style descriptor]. White-label accent token replaces their accent color with --color-brand-primary."`
3. Do a global find-replace in `STITCH-SCREEN-PROMPTS.md` to substitute every placeholder, then generate.

**This is a hard gate.** Do not generate Stitch screens with a blank visual direction -- the outputs will be inconsistent.

### Step 4 -- generation order

Follow the screen inventory order from the brief (section 7). Rationale: Stitch builds visual consistency incrementally -- generating the shell/chrome screens first (Login, Dashboard, App Shell) establishes the design language that later screens inherit.

Recommended order:
1. Auth screens (Login, magic-link confirm) -- establishes brand entry point.
2. Primary shell + nav (Dashboard, main chrome) -- locks the layout grid and sidebar/tab bar.
3. List screens (Sites list, Schedule, etc.) -- locks the list/card pattern.
4. Detail screens -- inherits card pattern, adds tabs/panels.
5. Form/editor screens -- establishes form component language.
6. PWA screens -- separate pass; apply standalone-app spec on top of the same token layer.
7. Client Portal screens -- separate shell; same token layer, different chrome.
8. System screens (empty, 404, 403, offline) -- last; they reference the established style.

### Pitfalls
- Generating without a loaded brief: Stitch loses cross-screen coherence.
- Generating before visual direction is chosen: inconsistent outputs, wasted iterations.
- One prompt for multiple screens: Stitch conflates content; always one prompt = one screen.
- Skipping system screens: empty/error/offline states are part of the product, not optional.
- Long prompts timeout (>2 min): keep each prompt under ~150 words; if a generation times out, shorten the prompt and retry.
- Parallel generation causes timeouts: run at most 2 concurrent; if one times out, retry individually.
- Stitch output uses Tailwind CDN + Google Fonts: does NOT render inside Claude Artifact iframes (CSP blocks CDN). When adding stitch screens to a design gallery artifact, use the generated PNG (screenshot) embedded as a base64 data URI image, NOT the HTML as srcdoc. The HTML is useful for browsing locally only.

## V2 per-screen prompt structure (learned from a 77-screen SaaS V2)

When the full IA is known and visual direction is chosen, the correct output format is a group-by-surface file with per-screen Stitch prompts. Each group contains:

### 1. Full page inventory table

Before writing prompts, list every page as a table. Columns: ID, Section, Page title, URL pattern (or "Notes" for PWA). One row per page -- including list/detail/create/edit/sub-tabs/states as separate entries if they differ visually.

This table is the gate: if a feature has no row, it has no prompt, which means it has no screen. Use it to catch orphan features and duplicate coverage early.

### 2. Shell conventions block

A single block at the top of each surface section (paste into Stitch alongside the global design brief):
- Viewport / frame dimensions
- Chrome elements present (sidebar, top nav, bottom tab bar, status bar)
- Safe-area rules (if PWA/mobile)
- Touch target minimums (if mobile)
- Typography font stack + language coverage

### 3. Per-screen prompt structure (one prompt = one screen)

```
Surface: [App surface] — [screen context in one line].
User: [role + what they're doing right now].
Goal: [the one job this screen exists to do].

Layout: [key layout decisions — split, full-width, shell presence, fixed vs scroll].

Key content & actions:
- [main content blocks, in visual order top-to-bottom]
- [primary CTA + secondary actions]

Required states:
- Default / Loading / Empty (with CTA) / Error / [surface-specific states]

Visual style: [reference URL] — [3-5 specific visual tokens: bg color, accent, typography density, component types used]. Typography: [explicit font stack]. White-label: [which token replaces which reference color].
```

### 4. Surface grouping and commit cadence

Group by surface (Manager Web / Field PWA / Client Portal / System). Complete one group, commit, notify, then start the next. Never write all surfaces in a single turn -- context exhaustion and "no output" risk.

Correct commit cadence for 4-surface product:
- Commit 1: Manager Web (largest, establish design language)
- Commit 2: Field PWA (standalone shell, different visual reference)
- Commit 3: Client Portal + System screens (light surface + error states)

### 5. Unicode / font constraint (always explicit)

Every visual style line must include:
`Typography: "Inter", "Roboto", "Open Sans", "Noto Sans", sans-serif — full Latin Extended (HU/DE/PL/FR/ES/IT diacritics).`

And a Global Design System block at the top of the file must declare this constraint explicitly for the Stitch session. No glyph-incomplete fonts. This is a BINDING constraint for multi-language B2B SaaS.
