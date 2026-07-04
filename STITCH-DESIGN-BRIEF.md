# CleanCore — Google Stitch Design Brief

> Paste this into Google Stitch as the product context, then generate screens page-by-page using the per-screen prompts at the end. This brief describes the whole product, its users, its information architecture, its visual identity, and the **PWA / standalone-mobile-app** requirement.

## 1. What the product is
**CleanCore** is a multi-tenant SaaS platform for **field-service / facility-cleaning operations companies** in the EU (7 languages: EN, DE, PL, IT, FR, HU, ES). Each customer company (a *tenant*) manages its sites, crews, work schedules, proof-of-work checklists with photo evidence, assets/chemicals, and client-facing reporting and invoicing — with full **white-label branding per tenant**.

Two distinct surfaces share one design system:
- **Manager Web App** (desktop-first, responsive): operations managers and admins plan, assign, monitor, and bill.
- **Field PWA** (mobile-first, installable, **must feel like a native standalone app**): cleaners/crews check in on-site, run checklists, capture photo proof, scan QR stickers.
- **Client Portal**: a tenant's own customers log in to see service status, reports, and proof.

## 2. Users & their primary jobs
- **Superadmin (platform)**: manage tenants, provisioning, plans, module catalog.
- **Tenant Admin / Manager (web)**: sites & zones, crews & shifts, checklist templates, billing/invoices, branding, team & roles, reports.
- **Field Worker / Crew (PWA mobile)**: today's jobs, check-in/out (QR + geofence), run checklist, capture photos, mark done.
- **Client (portal)**: see their sites' service status, completed proof, invoices.

## 3. Feature modules (the menu derives from these — entitlement-driven per tenant/role/plan)
- **Sites & Zones**: locations with address, geofence polygon, area; zones/rooms; printable **QR stickers**.
- **Workforce**: crews, members, **shift scheduling** (recurrence, swaps/reassign), brigades.
- **Proof-of-Work Checklists**: templates → instances; **photo-gate** (a task can require a photo) and **completion-gate**; snapshot-on-instantiate.
- **Evidence**: tamper-evident hash-chain + signed anchors for audit-grade proof.
- **Mobile Check-in/out**: QR scan + geofence event, capture-only camera (no gallery upload — anti-spoof), privacy-by-design.
- **Assets & Chemicals**: equipment/chemical inventory, photos, QR/DataMatrix, stock movement.
- **Billing & Invoicing**: invoices with EU VAT + Hungarian NAV reporting, plans, trial → grace → lockout.
- **Branding / White-label**: per-tenant colors, logo, theme; subdomain + premium custom domain.
- **Client Portal**: client-facing site status, reports, proof, invoices.
- **Integrations**: O365 / Gmail, time & pay export.

## 4. Information architecture (navigation)
Menu is **derived from the feature set and filtered by role + enabled module + plan** — never a static list. Reach any feature in ≤3 clicks; the most frequent job in 1.

**Manager Web — primary nav (sidebar):**
1. Dashboard (today's operations overview, KPIs, alerts)
2. Sites (list → site detail → zones)
3. Schedule (calendar of crews × shifts)
4. Checklists (templates + live instances)
5. Proof / Evidence (completed work, photos, audit)
6. Assets (inventory)
7. Clients & Portal
8. Billing (invoices, plan)
9. Settings (team & roles, branding, integrations, security) — in the top-bar account menu.

Top bar: tenant/workspace switcher, global search, notifications, account menu.

**Field PWA — bottom tab bar (max 5):** Today · Scan · Checklist · Map · Profile.

**Client Portal:** Overview · My Sites · Reports/Proof · Invoices.

## 5. Visual identity & design system
- **Tone**: professional, trustworthy, operational, clean. Not playful, not heavy-corporate. Think modern B2B SaaS (Linear/Vercel-level polish) adapted for field-ops.
- **Layout**: generous whitespace, strong typographic hierarchy, card-based content, clear data tables and lists, status chips, map + list combos.
- **Color**: a calm neutral base (white / near-black / grays) + one confident brand accent — **but the accent is per-tenant (white-label)**, so design with a theming token system (`--brand-primary`, `--brand-on-primary`, surface/elevation tokens) and show it with a sensible default accent. Ensure **WCAG-AA contrast** on all states.
- **States**: every screen needs default, loading (skeletons), empty (with a guiding CTA — empty states drive onboarding), error, and permission-denied.
- **Components**: top bar, sidebar/bottom-nav, cards, data tables, list rows with status chips, detail headers with breadcrumbs + actions, forms with inline validation, modals/sheets, map view, photo grid/capture, calendar/scheduler, KPI tiles, invoice layout.
- **Accessibility**: keyboard operable, visible focus, `aria-current` on active nav, landmarks, AA contrast.

## 6. PWA / standalone-app requirement (critical)
The mobile experience **must feel like a separate installed application, not a website in a browser**:
- **App shell**: persistent bottom tab bar, no browser chrome; `display: standalone` manifest; per-tenant app name, icon, theme-color, splash.
- **Native-feeling patterns**: bottom navigation, large touch targets, swipe/gesture affordances, pull-to-refresh, bottom sheets instead of dropdowns, momentum scrolling, safe-area insets (notch).
- **Install prompt** and offline-capable shell (cached UI, queued actions when offline).
- **Camera as a first-class surface**: capture-only (live camera, no gallery), full-bleed capture screen.
- **QR scanning** as a primary action (center tab or FAB).
- Mobile screens are designed mobile-first, not shrunk desktop — single-column, thumb-reachable actions, sticky primary action button.

## 7. How to generate in Stitch (page-by-page)
After Peti approves the design direction (Fron Ted will supply awwwards/dribbble reference links first), generate in this order, each as its own Stitch screen prompt built from sections 4–6:
1. Manager: Login / magic-link → Dashboard → Sites list → Site detail (zones, map) → Schedule (calendar) → Checklist template editor → Checklist live instance → Proof/Evidence detail (photos) → Billing/Invoice → Settings (branding, team).
2. Field PWA (standalone-app styling): Today → Scan (camera) → Checklist run (task + photo capture) → Map (geofence check-in) → Profile.
3. Client Portal: Overview → My Sites → Reports/Proof → Invoices.
4. System screens: empty states, 404, 403/permission-denied, offline.

For each screen, the Stitch prompt should state: the surface (manager web / field PWA / client portal), the user + their goal, the key content + actions, the required states, and — for PWA screens — "standalone installed-app styling: bottom tab bar, no browser chrome, large touch targets, bottom sheets, safe-area insets."

---
*Source of truth for the product: the CleanCore kanban (50+ shipped modules). Branding is per-tenant white-label — design the system with theming tokens and a neutral default accent.*
