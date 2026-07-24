// Generate mobile views for 10 CleanCore designs.
// Outputs {dir}/mobile.{html,png} alongside the existing generated.{html,png} (web/desktop).
// Uses re-login mechanism: project.screens() after generate() populates screenshot URL.
import fs from 'node:fs'
import path from 'node:path'
import { stitch } from '@google/stitch-sdk'

const PROJ = '3862263673254942781'
const DL_BASE = '/mnt/h/LM_Studio_Workdir/CleanCore/docs/design-previews/stitch-gen'

if (!process.env.STITCH_API_KEY) { console.error('NO_KEY'); process.exit(2) }

async function download(url, dest) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()))
}

const DESIGNS = [
  {
    dir: 'mw-consignment',
    prompt: `Surface: Manager Web — Warehouse Consignment tab, MOBILE view (390px phone screen).
User: Admin or Warehouse role reviewing consignment lots on phone.
Goal: See supplier lots, consume or settle — same as desktop but reflowed.
Layout: Single-column list, no sidebar (hamburger menu at top). Cards per lot show Supplier / Product / Qty / Status chip. Sticky bottom action bar with "Consume" and "Settle" buttons. Pull-to-refresh.
Required states: Default list, Loading (skeleton cards), Empty ("No open consignment lots" with icon), Error (retry). Status chips: teal HELD, amber PARTIALLY_CONSUMED, green SETTLED.
Visual style: CleanCore dark theme, navy surface #1e2335, brand primary #2563eb. Touch targets 44px min. Typography: "Inter", "Roboto", "Open Sans", "Noto Sans", sans-serif — full Latin Extended.`
  },
  {
    dir: 'mw-feedback',
    prompt: `Surface: Manager Web — Crew Feedback, MOBILE view (390px phone screen).
User: Manager reading crew feedback submissions on phone.
Goal: Browse feedback cards, see score trends, mark resolved.
Layout: Single-column, no sidebar (hamburger). Score summary pill at top (Avg 4.2 / 5 stars). Scrollable feedback cards: crew name, site, date, star rating (1-5), comment text, Resolve button. Filter chips row: All / Pending / Resolved.
Required states: Default, Loading (skeleton cards), Empty ("No feedback yet"), Error.
Visual style: CleanCore dark theme #1e2335 surface. Star rating in amber. Resolve = green chip. Touch targets 44px. Typography: "Inter", "Roboto", "Open Sans", "Noto Sans", sans-serif.`
  },
  {
    dir: 'mw-form-builder',
    prompt: `Surface: Manager Web — Checklist Builder, MOBILE view (390px phone screen).
User: Manager creating or editing a checklist template on phone.
Goal: Add/reorder tasks in a checklist, save and publish.
Layout: Single column, full screen. Top: template name input. Below: vertically stacked task cards (drag handle on left, task name text, photo-required toggle, delete icon). Bottom sticky: "+ Add Task" button full-width (teal), then "Save Draft" (ghost) and "Publish" (teal) row.
Required states: Empty template (just the "+ Add Task" CTA), editing with 3+ tasks (drag-reorder), saving (spinner on button), published (green toast).
Visual style: Dark #1e2335, task cards with subtle border. Drag handle muted gray. Photo toggle teal when on. Touch targets 44px. Typography: "Inter", sans-serif, full Latin Extended.`
  },
  {
    dir: 'fp-kiosk',
    prompt: `Surface: Field PWA — Kiosk Self Check-in, MOBILE view (390px phone, portrait).
User: Field worker checking in at a site using their own phone (not a wall tablet).
Goal: One-tap or QR-based check-in confirmation with site name displayed.
Layout: Full screen, centered. Top: CleanCore logo + site name in large bold. Middle: large "Check In" teal button (full width, 64px tall), and "Scan QR" secondary option. Bottom: current time display. No browser chrome (standalone PWA).
Required states: Default (waiting), Success (green checkmark animation + "Checked in at 08:05"), Error ("Could not check in — try again" red card).
Visual style: Dark navy #0f1117 background, teal accent #2563eb, white text, large font (24px site name). Touch targets 64px+ for primary actions. Typography: "Inter", sans-serif.`
  },
  {
    dir: 'mw-leave',
    prompt: `Surface: Manager Web — Leave Management, MOBILE view (390px phone screen).
User: Manager reviewing and approving leave requests on phone.
Goal: See pending leave requests, approve or deny with one tap.
Layout: Single column, no sidebar (hamburger). Two tabs at top: "Pending" (badge count) / "History". Pending tab: stacked request cards — worker avatar + name, date range, type chip (ANNUAL/SICK/UNPAID), "Approve" (green) and "Deny" (red) buttons side by side. Pull-to-refresh.
Required states: Default (pending list), Empty pending ("No pending requests"), Loading, Error.
Visual style: Dark navy surface, green APPROVE button, red DENY button. Status chips: amber PENDING, green APPROVED, red DENIED. Touch targets 44px. Typography: "Inter", sans-serif, full Latin Extended.`
  },
  {
    dir: 'public-scan',
    prompt: `Surface: Public — Zone Verified confirmation page, MOBILE view (390px phone, public-facing).
User: Visitor or worker who scanned a public QR code at a site zone.
Goal: Confirm their scan was registered, show zone + timestamp.
Layout: Full screen, centered vertically. Large animated green checkmark at top. Zone name in bold (e.g. "Zone: Main Entrance"). Timestamp below (e.g. "Verified at 09:14"). Powered-by CleanCore footer. No auth required.
Required states: Success (green check + zone name), Error ("QR code not recognized — contact staff" in amber).
Visual style: Clean white background (light mode), teal/green accent for success. Large readable text (20px zone name). Minimal branding. Typography: "Inter", sans-serif, full Latin Extended.`
  },
  {
    dir: 'mw-quality',
    prompt: `Surface: Manager Web — Quality Inspections, MOBILE view (390px phone screen).
User: Manager reviewing inspection results on phone.
Goal: See recent inspections, filter by site/score, open details.
Layout: Single column, no sidebar (hamburger). Score summary: average score pill (★ 4.1/5). Filter chips: All / Passed / Failed. Inspection cards: site name, inspector name, date, score badge (color-coded: green ≥4, amber 3-4, red <3), chevron to open detail.
Required states: Default, Loading (skeleton cards 4x), Empty ("No inspections yet"), Error.
Visual style: Dark navy surface, score badges green/amber/red semantic. Card tap opens detail drawer. Touch targets 44px. Typography: "Inter", sans-serif, full Latin Extended.`
  },
  {
    dir: 'fp-scan',
    prompt: `Surface: Field PWA — QR/Barcode Scanner, MOBILE view (390px phone, portrait).
User: Field worker scanning an asset or zone QR code in the field.
Goal: Activate camera, scan code, see immediate feedback on what was scanned.
Layout: Full-screen camera viewfinder with dark overlay. Center: scan target box (animated corner brackets, teal). Bottom sheet: scan result card slides up after successful scan — shows asset name/zone name, action buttons. No browser chrome (standalone PWA).
Required states: Scanning (viewfinder + corner animation), Success (bottom sheet slides up with green checkmark + item name), Not found (amber "Code not recognized"), Permission denied (prompt to allow camera).
Visual style: Camera viewfinder fills screen, dark overlay with scan target box. Teal corner brackets animate. Result bottom sheet: dark card, white text, teal accent. Touch targets 64px for actions. Typography: "Inter", sans-serif.`
  },
  {
    dir: 'mw-subcontractor',
    prompt: `Surface: Manager Web — Subcontractors, MOBILE view (390px phone screen).
User: Manager reviewing subcontractor companies and their workers on phone.
Goal: Browse subcontractors, see their workers, contact details.
Layout: Single column, no sidebar (hamburger). Search bar at top. Subcontractor cards: company name, logo/avatar, worker count badge, contact email, status chip (ACTIVE/INACTIVE). Card tap expands inline to show worker list. "+ Add Subcontractor" FAB bottom right.
Required states: Default list, Loading (skeleton 3 cards), Empty ("No subcontractors added"), Error.
Visual style: Dark navy #1e2335, ACTIVE chip teal, INACTIVE chip gray. FAB teal circle. Touch targets 44px. Typography: "Inter", sans-serif, full Latin Extended.`
  },
  {
    dir: 'sa-brand-preview',
    prompt: `Surface: Superadmin — Brand Preview, MOBILE view (390px phone screen).
User: Superadmin viewing how a tenant's white-label brand looks on mobile devices.
Goal: Preview the tenant brand colors and logo applied to the CleanCore mobile UI.
Layout: Phone frame mockup centered (or full screen on phone). Shows a mini CleanCore mobile UI shell with the tenant's brand applied: top bar with logo + brand color, bottom tab bar with brand accent, sample content cards in brand colors. Brand token inputs: primary color picker, logo upload, accent color. "Apply preview" button.
Required states: Default (current brand shown), Editing (color picker open), Reset (confirm dialog).
Visual style: The PREVIEW area shows tenant brand (configurable); the admin chrome is neutral dark #1e2335. Touch targets 44px. Typography: "Inter", sans-serif, full Latin Extended.`
  }
]

const project = stitch.project(PROJ)

async function generateMobile(design) {
  const outDir = path.join(DL_BASE, design.dir)
  const outHtml = path.join(outDir, 'mobile.html')
  const outPng = path.join(outDir, 'mobile.png')

  if (fs.existsSync(outPng)) {
    console.log(`SKIP ${design.dir} — mobile.png exists`)
    return
  }

  console.log(`\nGenerating mobile: ${design.dir}...`)
  fs.mkdirSync(outDir, { recursive: true })

  let screen
  try {
    screen = await project.generate(design.prompt)
    console.log(`  Generated id=${screen.id}`)
  } catch (e) {
    console.error(`  generate() failed for ${design.dir}: ${e.message}`)
    return
  }

  // Get HTML (available immediately)
  let html
  try { html = await screen.getHtml() } catch {}
  if (html) {
    try { await download(html, outHtml); console.log(`  HTML saved`) } catch (e) {
      console.error(`  HTML download failed: ${e.message}`)
    }
  }

  // Re-login: list all screens to populate screenshot.downloadUrl
  let imgUrl
  try {
    const screens = await project.screens()
    const fresh = screens.find(s => s.id === screen.id) ?? screen
    imgUrl = await fresh.getImage()
  } catch (e) {
    console.error(`  getImage() failed: ${e.message}`)
  }

  if (imgUrl) {
    try {
      await download(imgUrl, outPng)
      const kb = Math.round(fs.statSync(outPng).size / 1024)
      console.log(`  PNG saved (${kb}KB) -> ${outPng}`)
    } catch (e) {
      console.error(`  PNG download failed: ${e.message}`)
    }
  } else {
    console.log(`  No image URL — screenshot may still be processing`)
  }
}

console.log(`Generating mobile views for ${DESIGNS.length} designs...\n`)
for (const design of DESIGNS) {
  await generateMobile(design)
}

console.log('\n=== Summary ===')
for (const d of DESIGNS) {
  const png = path.join(DL_BASE, d.dir, 'mobile.png')
  const html = path.join(DL_BASE, d.dir, 'mobile.html')
  console.log(`${d.dir}: html=${fs.existsSync(html)?'OK':'MISSING'} png=${fs.existsSync(png)?'OK':'MISSING'}`)
}
