# CleanCore — Google Stitch Per-Screen Prompts

> Ready-to-paste prompts for each screen. Paste into Stitch after Peti selects the visual direction.
> Visual direction placeholder: **[VISUAL DIRECTION]** — replace with Peti's chosen references before generating.
> Product context: paste the full STITCH-DESIGN-BRIEF.md into Stitch as the base context first, then use these per-screen prompts one at a time.

---

## GLOBAL DESIGN SYSTEM CONSTRAINTS

> **Include this block in every Stitch session alongside the design brief. It applies to ALL screens without exception.**

```
Typography (MANDATORY — Unicode Latin Extended):
- Primary typeface: Inter (preferred) or Roboto or Open Sans or Noto Sans.
- ALL of these ship with complete Latin Extended glyph coverage.
- Required coverage: HU (á é í ó ö ő ú ü ű), DE (ä ö ü ß), PL (ł ą ę ź ż ń ó ś ć), IT/FR/ES accents (à â ç è é ê î ñ ô û ù).
- EXPLICITLY EXCLUDED: fonts without full Latin Extended sets — no system-default serif fallbacks, no decorative fonts, no icon-only web fonts in the body stack.
- Font stack: "Inter", "Roboto", "Open Sans", "Noto Sans", sans-serif.
- All UI text, labels, error messages, and placeholders must render in the specified stack.
```

---

## MANAGER WEB

### MW-01 — Login / Magic-link

```
Surface: Manager Web App — unauthenticated entry point.
User: Tenant admin or manager arriving at the login page.
Goal: Enter their email to receive a magic-link; no password required.

Key content & actions:
- CleanCore logo + tenant name (white-label, centered)
- Single email input field + "Send magic-link" CTA button
- "Check your inbox" success state with email address confirmed and a resend link
- Link: "Need help? Contact support"
- Footer: platform name + legal links (ToS, Privacy)

Required states:
- Default (empty email field)
- Loading (button spinner while sending)
- Success (magic-link sent — inbox confirmation)
- Error (invalid email format; email not found)
- Expired-link error (user clicked an old link — prompt to request a new one)

Visual style: XPO Logistic TMS Truck Management Dashboard (dribbble.com/shots/26643982) -- dark sidebar (#0f1117), data-dense tables with status-chip rows, teal/indigo accent on dark surfaces, operational B2B tone. White-label: --color-brand-primary replaces teal accent; sidebar bg uses --color-surface-alt. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### MW-02 — Dashboard

```
Surface: Manager Web App — post-login home screen.
User: Operations manager starting their workday.
Goal: Instant situational awareness — what's happening today across all sites and crews.

Key content & actions:
- Top bar: tenant logo, global search, notification bell, account menu, workspace/tenant switcher
- Sidebar nav: Dashboard (active), Sites, Schedule, Checklists, Proof, Assets, Clients, Billing, Settings
- KPI strip (4 tiles): Active jobs today / Open issues / Sites covered / Pending invoices
- "Today's schedule" card: crew × site assignments, status chips (on-route / on-site / done / missed)
- Alerts panel: overdue checklists, failed proof uploads, billing-due warnings
- Quick-actions: + New site / + New shift / + Generate invoice

Required states:
- Default (data loaded)
- Loading (skeleton tiles and skeleton rows)
- Empty (first-run onboarding — no sites yet; CTA: "Add your first site")
- Error (API failure — banner with retry)

Visual style: XPO Logistic TMS Truck Management Dashboard (dribbble.com/shots/26643982) -- dark sidebar (#0f1117), data-dense tables with status-chip rows, teal/indigo accent on dark surfaces, operational B2B tone. White-label: --color-brand-primary replaces teal accent; sidebar bg uses --color-surface-alt. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### MW-03 — Sites List

```
Surface: Manager Web App.
User: Manager browsing all managed locations.
Goal: Find a site, see its status at a glance, navigate to its detail.

Key content & actions:
- Page header: "Sites" + search/filter bar (status, zone, active/inactive) + "+ Add site" button
- List rows: site name, address, active zone count, last-cleaned date, current status chip (active / scheduled / overdue / inactive)
- Map toggle: switch between list view and a map pin view (geofence outlines visible)
- Bulk actions: assign crew, export, archive
- Pagination / infinite scroll

Required states:
- Default (populated list)
- Loading (skeleton rows)
- Empty (no sites — illustrated empty state with "+ Add your first site" CTA)
- Search no-results ("No sites match 'X' — clear filter")
- Error (fetch failure)

Visual style: XPO Logistic TMS Truck Management Dashboard (dribbble.com/shots/26643982) -- dark sidebar (#0f1117), data-dense tables with status-chip rows, teal/indigo accent on dark surfaces, operational B2B tone. White-label: --color-brand-primary replaces teal accent; sidebar bg uses --color-surface-alt. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### MW-04 — Site Detail (Zones & Map)

```
Surface: Manager Web App.
User: Manager reviewing a single location.
Goal: See all zones/rooms, current service status, scheduled crews, and geofence boundary.

Key content & actions:
- Breadcrumb: Sites > [Site Name]
- Header: site name, address, status chip, action bar (Edit / Print QR / Archive)
- Tab strip: Overview | Zones | Schedule | Proof | Assets
- Overview tab: geofence map (polygon), last-cleaned timestamp, active crew card, open issues count
- Zones tab: zone list (name, area m², last-cleaned, QR sticker link), + Add zone button
- Side panel (or detail drawer): zone detail on click — checklist template, last visit proof thumbnail

Required states:
- Default
- Loading (map skeleton + list skeleton)
- Empty zones (no zones added yet — CTA: "Add first zone")
- Permission-denied (user role cannot edit — edit actions hidden, read-only label)

Visual style: XPO Logistic TMS Truck Management Dashboard (dribbble.com/shots/26643982) -- dark sidebar (#0f1117), data-dense tables with status-chip rows, teal/indigo accent on dark surfaces, operational B2B tone. White-label: --color-brand-primary replaces teal accent; sidebar bg uses --color-surface-alt. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### MW-05 — Schedule (Calendar)

```
Surface: Manager Web App.
User: Operations manager planning crew assignments and shifts.
Goal: View and edit the weekly/monthly crew × site schedule; create, swap, or reassign shifts.

Key content & actions:
- Calendar header: week / month toggle, previous/next navigation, "Today" button, "+ New shift" CTA
- Grid: rows = crews/brigades, columns = days; cells = shift blocks (site name, time, status chip)
- Shift block click: opens side drawer with shift details (site, crew members, time, checklist template) and actions (Edit / Reassign / Cancel)
- Drag-to-reschedule (desktop), tap-to-edit (responsive)
- Filter sidebar: filter by site, by crew member, by status

Required states:
- Default (shifts visible)
- Loading (calendar grid skeleton)
- Empty week (no shifts scheduled — CTA: "Schedule first shift")
- Conflict warning (two crews double-booked on same site — highlighted cell)
- Error

Visual style: XPO Logistic TMS Truck Management Dashboard (dribbble.com/shots/26643982) -- dark sidebar (#0f1117), data-dense tables with status-chip rows, teal/indigo accent on dark surfaces, operational B2B tone. White-label: --color-brand-primary replaces teal accent; sidebar bg uses --color-surface-alt. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### MW-06 — Checklist Template Editor

```
Surface: Manager Web App.
User: Manager or admin building a reusable cleaning checklist template.
Goal: Define tasks (with optional photo-gates and completion-gates), set order, save template.

Key content & actions:
- Header: template name (editable inline) + status badge (Draft / Active) + Save / Publish actions
- Task list: draggable rows — task label, type selector (check / photo-required / numeric), required toggle
- "+ Add task" button at bottom of list
- Task detail side panel: label, description, photo-gate toggle, completion-gate toggle, expected duration
- Version history link (snapshot-on-instantiate mechanism, read-only)

Required states:
- Default (populated template)
- Loading (skeleton rows)
- Empty (new template — prompt to add first task)
- Unsaved changes warning (leave-page guard)
- Publish confirmation modal (template locked once instances exist)

Visual style: XPO Logistic TMS Truck Management Dashboard (dribbble.com/shots/26643982) -- dark sidebar (#0f1117), data-dense tables with status-chip rows, teal/indigo accent on dark surfaces, operational B2B tone. White-label: --color-brand-primary replaces teal accent; sidebar bg uses --color-surface-alt. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### MW-07 — Checklist Live Instance

```
Surface: Manager Web App (read-only supervisor view of a running or completed checklist).
User: Manager reviewing a crew's completed or in-progress checklist.
Goal: See which tasks are done, which are blocked, view attached photo proof, flag issues.

Key content & actions:
- Header: site name, crew name, date/time, overall completion % progress bar
- Task list: each row shows task label, status icon (pending / done / skipped / photo-attached), timestamp
- Photo thumbnail: tap to expand before/after photo with EXIF-derived timestamp
- Issue flag: manager can flag a task for follow-up
- Completion summary: done count / total, QA score if applicable

Required states:
- In-progress (some tasks pending — live refresh indicator)
- Completed (all tasks done — green header, QA score displayed)
- Incomplete-submitted (crew submitted with skipped tasks — amber warning)
- Loading
- Error (failed to load instance)

Visual style: XPO Logistic TMS Truck Management Dashboard (dribbble.com/shots/26643982) -- dark sidebar (#0f1117), data-dense tables with status-chip rows, teal/indigo accent on dark surfaces, operational B2B tone. White-label: --color-brand-primary replaces teal accent; sidebar bg uses --color-surface-alt. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### MW-08 — Proof / Evidence Detail

```
Surface: Manager Web App.
User: Manager or auditor reviewing tamper-evident proof of completed work.
Goal: Inspect photo evidence, verify timestamps, download audit-grade report.

Key content & actions:
- Header: site + visit date + crew + audit status badge (Verified / Pending)
- Photo grid: before/after pairs per zone; each photo shows capture timestamp, geolocation pin, hash fingerprint chip
- Hash chain panel: evidence anchor list with timestamps (collapsible, for auditors)
- Download button: export PDF report (with embedded photos + chain of custody)
- Share link: generate a read-only proof link for the client

Required states:
- Default (photos loaded)
- Loading (photo grid skeleton)
- Empty (no photos submitted — "No proof attached to this visit")
- Verification failed (hash mismatch — red alert banner)

Visual style: XPO Logistic TMS Truck Management Dashboard (dribbble.com/shots/26643982) -- dark sidebar (#0f1117), data-dense tables with status-chip rows, teal/indigo accent on dark surfaces, operational B2B tone. White-label: --color-brand-primary replaces teal accent; sidebar bg uses --color-surface-alt. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### MW-09 — Billing / Invoice

```
Surface: Manager Web App.
User: Admin or billing manager managing invoices and plan.
Goal: Create, review, and send invoices to clients; see plan status and usage.

Key content & actions:
- Tab strip: Invoices | Plans | Payments
- Invoice list: client name, invoice number, date, amount, status chip (Draft / Sent / Paid / Overdue)
- "+ New invoice" button; row click opens invoice detail
- Invoice detail view: EU VAT-compliant layout, line items, NAV reporting status badge (Hungary), PDF download, Send/Remind actions
- Plan card: current plan tier, trial countdown / grace period warning, upgrade CTA

Required states:
- Default (invoice list populated)
- Loading (skeleton rows)
- Empty (no invoices yet — CTA: "Create first invoice")
- Grace period warning banner (payment overdue — amber)
- Lockout state (plan expired — read-only mode, upgrade CTA prominent)

Visual style: XPO Logistic TMS Truck Management Dashboard (dribbble.com/shots/26643982) -- dark sidebar (#0f1117), data-dense tables with status-chip rows, teal/indigo accent on dark surfaces, operational B2B tone. White-label: --color-brand-primary replaces teal accent; sidebar bg uses --color-surface-alt. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### MW-10 — Settings (Branding & Team)

```
Surface: Manager Web App.
User: Tenant admin configuring the white-label appearance and managing team members.
Goal: Upload logo, set brand colors, add/remove team members, configure roles and integrations.

Key content & actions:
- Settings sidebar: Branding | Team & Roles | Integrations | Security | Danger zone
- Branding tab: logo upload (light/dark), color pickers (primary, secondary, accent) with live WCAG-AA contrast indicator, preview pane showing how the UI looks with the new colors, Publish button (disabled if contrast fails AA)
- Team tab: member list (name, email, role chip), + Invite member button, role selector per member
- Integrations tab: O365 / Gmail connect toggle, time-export config
- Danger zone: delete tenant (requires typed confirmation)

Required states:
- Default
- Loading (member list skeleton)
- Unsaved branding changes (sticky "Publish" bar)
- WCAG contrast warning (color picker inline — red alert if ratio < 4.5:1)
- Invite sent confirmation

Visual style: XPO Logistic TMS Truck Management Dashboard (dribbble.com/shots/26643982) -- dark sidebar (#0f1117), data-dense tables with status-chip rows, teal/indigo accent on dark surfaces, operational B2B tone. White-label: --color-brand-primary replaces teal accent; sidebar bg uses --color-surface-alt. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

## FIELD PWA

> **All Field PWA screens must use standalone installed-app styling:**
> bottom tab bar (max 5 tabs), no browser chrome, large touch targets (min 44×44px),
> bottom sheets instead of dropdowns/modals, momentum scrolling, safe-area insets (notch/home-bar),
> per-tenant app name + icon + theme-color from manifest. Design mobile-first, single-column,
> thumb-reachable primary actions.

---

### PWA-01 — Today (Job List)

```
Surface: Field PWA — standalone installed app.
User: Field worker / cleaner starting their shift.
Goal: See today's assigned jobs in order, start the first one immediately.

Key content & actions:
- Top: greeting ("Good morning, [name]") + date
- Job cards (chronological): site name, address, time window, status chip (Upcoming / On route / In progress / Done), "Navigate" shortcut button
- Pull-to-refresh
- Sticky bottom tab bar: Today (active) · Scan · Checklist · Map · Profile
- FAB or prominent "Start job" button on the first upcoming card

Required states:
- Default (jobs listed)
- Loading (skeleton cards)
- Empty (no jobs today — "No jobs scheduled. Check with your manager." + contact button)
- All done (celebration micro-animation, "All jobs completed today")
- Offline (banner: "Offline — showing cached jobs. Actions will sync when connected.")

Standalone-app styling: bottom tab bar, large tap targets, safe-area insets.
Visual style: D-Tools Field Service App (dribbble.com/shots/25347603) + Field Management Case Study (dribbble.com/shots/21060085) -- large task-card layout, status chips (Upcoming/On route/Done), bottom-sheet check-in/out flow, standalone installed-app shell (bottom tab bar, no browser chrome, safe-area insets), dark header bar, green/teal accent for active/done states. White-label: --color-brand-primary replaces accent. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### PWA-02 — Scan (QR Check-in / Check-out)

```
Surface: Field PWA — standalone installed app.
User: Field worker arriving at or leaving a site.
Goal: Scan the QR sticker on-site to check in (or check out); the app verifies geofence proximity.

Key content & actions:
- Full-bleed live camera viewfinder (capture-only — no gallery access, anti-spoof)
- QR targeting reticle centered; subtle scan animation
- Geofence proximity indicator (green ring when within boundary, red when outside)
- Success overlay: site name confirmed + timestamp + "Checked in" / "Checked out" + haptic feedback
- Manual fallback: "Can't scan? Enter site code" (text input, bottom sheet)

Required states:
- Camera loading (spinner)
- Active scan (viewfinder live)
- Geofence outside range (red indicator + "Move closer to the site entrance")
- Scan success — check-in (green overlay, auto-navigates to Checklist)
- Scan success — check-out (green overlay, navigates to Today summary)
- Unknown QR (error overlay + manual entry CTA)
- Camera permission denied (instructional screen to enable in system settings)

Standalone-app styling: full-bleed camera, no browser chrome, haptic on success.
Visual style: D-Tools Field Service App (dribbble.com/shots/25347603) + Field Management Case Study (dribbble.com/shots/21060085) -- large task-card layout, status chips (Upcoming/On route/Done), bottom-sheet check-in/out flow, standalone installed-app shell (bottom tab bar, no browser chrome, safe-area insets), dark header bar, green/teal accent for active/done states. White-label: --color-brand-primary replaces accent. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### PWA-03 — Checklist Run (Task + Photo Capture)

```
Surface: Field PWA — standalone installed app.
User: Field worker executing a cleaning checklist on-site.
Goal: Work through each task in order, mark done, capture required photos, submit on completion.

Key content & actions:
- Header: site name + zone + progress bar (X/Y tasks done)
- Task list: scrollable, one task prominent at a time (large card) — task label, description, checkbox to mark done
- Photo-gate task: "Take photo" button launches full-bleed capture screen (live camera, no gallery); thumbnail appears on capture
- Completion-gate: cannot mark done without the photo if photo-required
- Sticky bottom: "Submit checklist" button (enabled only when all required tasks done)
- Notes field per task (optional, bottom sheet)

Required states:
- Default (tasks in progress)
- Photo capture mode (full-bleed camera overlay, shutter button)
- Photo captured (thumbnail shown, retake option)
- All tasks done (Submit button active, green progress bar)
- Submitted (success screen — summary: time taken, photos count; "Back to Today" button)
- Offline (banner: tasks saved locally, will sync on reconnect)

Standalone-app styling: bottom tab bar hidden during active capture; large touch targets; bottom sheet for notes.
Visual style: D-Tools Field Service App (dribbble.com/shots/25347603) + Field Management Case Study (dribbble.com/shots/21060085) -- large task-card layout, status chips (Upcoming/On route/Done), bottom-sheet check-in/out flow, standalone installed-app shell (bottom tab bar, no browser chrome, safe-area insets), dark header bar, green/teal accent for active/done states. White-label: --color-brand-primary replaces accent. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### PWA-04 — Map (Geofence & Site Overview)

```
Surface: Field PWA — standalone installed app.
User: Field worker navigating to a site or checking geofence status.
Goal: See the site location on a map, get directions, confirm geofence proximity.

Key content & actions:
- Full-bleed map with site pin(s) for today's jobs
- Geofence polygon overlay on the active site
- Bottom sheet (persistent, swipeable up): active job card — site name, address, time window, distance
- "Get directions" button (opens native maps app)
- Check-in status badge on the pin (not checked in / checked in / done)

Required states:
- Loading (map tiles loading)
- Default (map centered on next job site)
- Outside geofence (site pin amber — "You are X m away from the boundary")
- Inside geofence (site pin green — "You're on-site. Ready to check in.")
- No location permission (instructional screen)
- Offline (cached map tiles if available; "Map unavailable offline" fallback)

Standalone-app styling: full-bleed map, swipeable bottom sheet, safe-area insets.
Visual style: D-Tools Field Service App (dribbble.com/shots/25347603) + Field Management Case Study (dribbble.com/shots/21060085) -- large task-card layout, status chips (Upcoming/On route/Done), bottom-sheet check-in/out flow, standalone installed-app shell (bottom tab bar, no browser chrome, safe-area insets), dark header bar, green/teal accent for active/done states. White-label: --color-brand-primary replaces accent. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### PWA-05 — Profile

```
Surface: Field PWA — standalone installed app.
User: Field worker managing their personal account and app settings.
Goal: View their schedule summary, update language preference, contact support, sign out.

Key content & actions:
- Avatar + name + role chip
- Stats strip: jobs completed this week / this month, on-time %
- Settings list rows: Language, Notifications, Dark mode toggle, About / version
- "Contact manager" button
- Sign out button (with confirmation bottom sheet)

Required states:
- Default
- Loading (stats skeleton)
- Sign-out confirmation bottom sheet ("Sign out? Any unsynced actions will be lost.")
- Offline (stats may be stale — cache timestamp shown)

Standalone-app styling: bottom tab bar (Profile tab active), safe-area insets, bottom sheet for sign-out.
Visual style: D-Tools Field Service App (dribbble.com/shots/25347603) + Field Management Case Study (dribbble.com/shots/21060085) -- large task-card layout, status chips (Upcoming/On route/Done), bottom-sheet check-in/out flow, standalone installed-app shell (bottom tab bar, no browser chrome, safe-area insets), dark header bar, green/teal accent for active/done states. White-label: --color-brand-primary replaces accent. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

## CLIENT PORTAL

---

### CP-01 — Overview (Dashboard)

```
Surface: Client Portal.
User: Client (the tenant's customer) checking in on their services.
Goal: Quick summary of all their sites' service status and any open issues.

Key content & actions:
- Top bar: tenant brand logo, client's name + avatar, sign out
- KPI strip (3 tiles): Sites covered · Avg QA score · Open requests
- Site list (summary cards): site name, last-cleaned date, QA score badge (green/amber/red), open request count chip
- "Submit new request" CTA button
- Bottom navigation (mobile): Sites · Business · Requests · Account

Required states:
- Default
- Loading (skeleton KPI + skeleton cards)
- Empty (client has no sites yet — "No sites linked to your account. Contact your service provider.")
- Error

Visual style: Customer Journey CRM Dashboard (dribbble.com/shots/24659454) -- clean light surface, KPI journey tiles, card-based timeline layout, warm neutral palette with accent highlights. White-label: --color-brand-primary for CTAs and accent; WCAG-AA contrast on all text pairs. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### CP-02 — My Sites (Site Detail)

```
Surface: Client Portal.
User: Client viewing a specific site's service history and proof.
Goal: See cleaning log, QA scores over time, and access before/after photo proof.

Key content & actions:
- Breadcrumb: Sites > [Site Name]
- Header: site name, address, QA gauge meter
- Cleaning log timeline: chronological visits — date, cleaner name, QA score badge, "Photos" link if proof attached
- Visit detail (tap/click): before/after photo grid, completion status, notes
- FAB: "Submit request for this site" (pre-fills site in request form)

Required states:
- Default (log populated)
- Loading (timeline skeleton)
- Empty (no visits yet — "Service not yet started for this site.")
- No photos (visit entry without proof — "No photos for this visit")

Visual style: Customer Journey CRM Dashboard (dribbble.com/shots/24659454) -- clean light surface, KPI journey tiles, card-based timeline layout, warm neutral palette with accent highlights. White-label: --color-brand-primary for CTAs and accent; WCAG-AA contrast on all text pairs. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### CP-03 — Reports / Proof

```
Surface: Client Portal.
User: Client or their auditor reviewing downloadable proof of service.
Goal: Download a signed PDF proof report for a date range; verify evidence integrity.

Key content & actions:
- Date range picker: "Last 30 days / 90 days / Custom"
- Site filter (multi-select)
- Report list: one row per generated report — date range, site, status (Ready / Generating / Failed), Download PDF button
- "Generate new report" button (triggers async generation)
- Integrity badge: hash-chain verified / not verified chip per report

Required states:
- Default (reports listed)
- Loading (report list skeleton)
- Generating (spinner on row — "Generating… this may take a moment")
- Empty (no reports yet — "Generate your first proof report above.")
- Download ready (green chip — PDF download available)

Visual style: Customer Journey CRM Dashboard (dribbble.com/shots/24659454) -- clean light surface, KPI journey tiles, card-based timeline layout, warm neutral palette with accent highlights. White-label: --color-brand-primary for CTAs and accent; WCAG-AA contrast on all text pairs. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### CP-04 — Invoices

```
Surface: Client Portal.
User: Client managing their invoices from the service provider.
Goal: View, download, and approve/query invoices.

Key content & actions:
- Invoice list: invoice number, date, amount + currency, status chip (Open / Paid / Overdue)
- Row click: invoice detail — line items, VAT breakdown, PDF download, "Query this invoice" button
- Filter: status (All / Open / Paid / Overdue)
- Summary strip: total outstanding amount

Required states:
- Default (invoices listed)
- Loading (skeleton rows)
- Empty (no invoices — "No invoices yet.")
- Overdue warning (amber banner: "You have X overdue invoices")
- Invoice detail loading skeleton

Visual style: Customer Journey CRM Dashboard (dribbble.com/shots/24659454) -- clean light surface, KPI journey tiles, card-based timeline layout, warm neutral palette with accent highlights. White-label: --color-brand-primary for CTAs and accent; WCAG-AA contrast on all text pairs. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

## SYSTEM SCREENS

---

### SYS-01 — Empty States (Generic)

```
Surface: All surfaces (Manager Web / Field PWA / Client Portal).
Goal: Guide the user to the next productive action when a list or section has no content.

Design spec for empty states:
- Centered illustration (abstract, not clip-art; respects brand accent color)
- Short headline: what's empty ("No sites yet" / "No jobs today" / "No invoices")
- One-sentence explanation of why it's empty and what to do
- Single primary CTA button ("Add first site" / "Schedule first shift" / "Contact provider")
- Consistent size and padding across all uses — this is a reusable component

Variations to show on the same screen:
1. First-run / onboarding empty (no data ever added)
2. Filtered empty (data exists but filter hides it — "No results for 'X'. Clear filter.")
3. Permission-limited empty (data exists but user role can't see it — "Access restricted")

Visual style: follows the host surface language -- Manager Web shell (XPO TMS reference) for web error pages; Field PWA standalone-app language (D-Tools reference) for PWA offline screen. Brand accent via --color-brand-primary; consistent with the shell. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### SYS-02 — 404 Not Found

```
Surface: All surfaces.
Goal: Tell the user the page doesn't exist and route them back into the app.

Key content:
- Large "404" typographic treatment
- Headline: "Page not found"
- Subtext: "This page doesn't exist or has been moved."
- Primary CTA: "Go to Dashboard" (or "Back to Home" for the portal)
- Optional: global search field to help the user find what they were looking for

No illustration required if the typographic treatment is strong; if illustration used, keep it minimal and brand-consistent.

Visual style: follows the host surface language -- Manager Web shell (XPO TMS reference) for web error pages; Field PWA standalone-app language (D-Tools reference) for PWA offline screen. Brand accent via --color-brand-primary; consistent with the shell. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### SYS-03 — 403 Permission Denied

```
Surface: All surfaces (triggers when a user navigates to a URL their role doesn't permit).
Goal: Clearly explain the access restriction and offer a safe exit.

Key content:
- Icon: lock or shield (brand accent color)
- Headline: "Access restricted"
- Subtext: "You don't have permission to view this page. Contact your administrator if you think this is a mistake."
- Primary CTA: "Back to Dashboard"
- Secondary: "Contact support"

Do NOT show the content behind the gate — even partially. The page must be fully blank behind the message.

Visual style: follows the host surface language -- Manager Web shell (XPO TMS reference) for web error pages; Field PWA standalone-app language (D-Tools reference) for PWA offline screen. Brand accent via --color-brand-primary; consistent with the shell. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

### SYS-04 — Offline (Field PWA)

```
Surface: Field PWA — standalone installed app.
Goal: Inform the worker they are offline while keeping the app usable with cached data.

Key content & behavior:
- Persistent amber banner at the top: "You're offline — working from cached data. Actions will sync when you reconnect."
- The app shell remains fully functional: today's job list (cached), active checklist (cached), profile
- Actions that require connectivity are disabled with a tooltip: "Unavailable offline"
- Queued-actions indicator: "3 actions waiting to sync" with a progress chip
- On reconnect: banner disappears, sync runs silently, brief "Synced ✓" toast

Required states:
- Offline + cached data available (degraded but usable)
- Offline + no cache (full offline screen: "No cached data. Connect to the internet to load your jobs.")
- Reconnecting (spinner in the banner)
- Synced (success toast, banner dismissed)

Standalone-app styling: safe-area insets, banner below status bar, native-feel toast.
Visual style: follows the host surface language -- Manager Web shell (XPO TMS reference) for web error pages; Field PWA standalone-app language (D-Tools reference) for PWA offline screen. Brand accent via --color-brand-primary; consistent with the shell. Typography: Inter / Roboto / Open Sans / Noto Sans (Unicode Latin Extended -- full HU/DE/PL/FR/ES/IT diacritic coverage required); no glyph-incomplete fonts.
```

---

## HOW TO USE

1. Paste `STITCH-DESIGN-BRIEF.md` into Stitch as the product context.
2. Once Peti selects visual references: replace every `[VISUAL DIRECTION: ...]` placeholder with e.g. `"Visual style: inspired by reference #2 (Field Management Case Study) — dark navy shell, teal accent, card-based list with large status chips, bottom sheet patterns. White-label accent token replaces teal with --color-brand-primary."`
3. Paste each screen prompt individually into Stitch to generate that screen.
4. Order: Manager Web (MW-01 through MW-10) → Field PWA (PWA-01 through PWA-05) → Client Portal (CP-01 through CP-04) → System (SYS-01 through SYS-04).
