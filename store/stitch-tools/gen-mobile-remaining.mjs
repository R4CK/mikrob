// Generate remaining mobile views (skip already-done). Handles retries.
import fs from 'node:fs'
import path from 'node:path'
import { stitch } from '@google/stitch-sdk'

const PROJ = '3862263673254942781'
const DL_BASE = '/mnt/h/LM_Studio_Workdir/CleanCore/docs/design-previews/stitch-gen'
if (!process.env.STITCH_API_KEY) { console.error('NO_KEY'); process.exit(2) }

const wait = ms => new Promise(r => setTimeout(r, ms))

async function dl(url, dest) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()))
}

const DESIGNS = [
  { dir: 'fp-kiosk', prompt: `Surface: Field PWA Kiosk Check-in, phone screen 390px portrait. User: field worker checking in at site on own phone. Large teal Check In button full-width 64px. Site name bold 24px. QR scan secondary option. Success: green checkmark animation. Standalone PWA no browser chrome. Dark navy 0f1117 background. Touch targets 64px. Inter sans-serif font.` },
  { dir: 'mw-leave', prompt: `Surface: Manager Web Leave Management, phone screen 390px. Single column no sidebar hamburger menu. Two tabs: Pending (badge) / History. Pending: stacked request cards with worker name, date range, leave type chip, Approve green button and Deny red button side by side. Pull-to-refresh. Empty: No pending requests. Dark navy surface 1e2335. Touch targets 44px. Inter sans-serif.` },
  { dir: 'mw-quality', prompt: `Surface: Manager Web Quality Inspections, phone screen 390px. Single column no sidebar. Score summary avg 4.1/5 pill at top. Filter chips: All / Passed / Failed. Inspection cards: site name, inspector, date, score badge green>=4 amber 3-4 red<3, chevron. Empty: No inspections yet. Dark navy 1e2335. Touch targets 44px. Inter sans-serif.` },
  { dir: 'fp-scan', prompt: `Surface: Field PWA QR scanner, phone screen 390px portrait. Full-screen camera viewfinder with dark overlay. Center: animated scan target box with teal corner brackets. Bottom sheet slides up on scan success: asset/zone name, green checkmark, action buttons. States: scanning with animation, success bottom sheet, not found amber, camera permission denied. Standalone PWA. Touch targets 64px. Inter sans-serif.` },
  { dir: 'mw-subcontractor', prompt: `Surface: Manager Web Subcontractors, phone screen 390px. Single column no sidebar hamburger. Search bar top. Subcontractor cards: company name, worker count badge, contact email, ACTIVE teal chip or INACTIVE gray. Card tap expands to show worker list. FAB teal plus Add Subcontractor bottom right. Dark navy 1e2335. Touch targets 44px. Inter sans-serif.` },
  { dir: 'public-scan', prompt: `Surface: Public Zone Verified confirmation, phone screen 390px light theme. Full screen centered. Large animated green checkmark. Zone name bold 20px e.g. Zone: Main Entrance. Timestamp: Verified at 09:14. Powered by CleanCore footer. No auth required. Clean white background, green accent. Large readable text. Inter sans-serif.` },
  { dir: 'sa-brand-preview', prompt: `Surface: Superadmin Brand Preview, phone screen 390px. Phone frame mockup showing tenant brand applied to CleanCore mobile UI: top bar with tenant logo and brand color, bottom tab bar with brand accent, sample content cards in brand color. Below: brand token inputs color picker primary, logo upload, accent color, Apply preview button. Admin chrome dark 1e2335. Touch targets 44px. Inter sans-serif.` },
]

const project = stitch.project(PROJ)

async function genOne(design, attempt = 1) {
  const outDir = path.join(DL_BASE, design.dir)
  const outPng = path.join(outDir, 'mobile.png')
  const outHtml = path.join(outDir, 'mobile.html')
  if (fs.existsSync(outPng)) { console.log(`SKIP ${design.dir}`); return true }

  console.log(`\n[${design.dir}] attempt ${attempt}...`)
  fs.mkdirSync(outDir, { recursive: true })

  let screen
  try {
    screen = await project.generate(design.prompt)
    console.log(`  id=${screen.id}`)
  } catch(e) {
    if (attempt < 3) {
      console.log(`  generate failed (${e.message}), retry in 15s...`)
      await wait(15000)
      return genOne(design, attempt + 1)
    }
    console.error(`  GIVE UP: ${e.message}`)
    return false
  }

  let h; try{h=await screen.getHtml()}catch{}
  if (h) try { await dl(h, outHtml); console.log('  html ok') } catch {}

  const screens = await project.screens()
  const fresh = screens.find(s => s.id === screen.id) ?? screen
  let img; try{img=await fresh.getImage()}catch{}
  if (img) {
    try {
      await dl(img, outPng)
      console.log(`  PNG ok (${Math.round(fs.statSync(outPng).size/1024)}KB)`)
      return true
    } catch(e) { console.error(`  PNG dl failed: ${e.message}`) }
  } else {
    console.log('  No image URL yet')
  }
  return false
}

for (const d of DESIGNS) {
  await genOne(d)
  await wait(3000) // brief pause between screens
}

console.log('\n=== Final ===')
for (const d of DESIGNS) {
  const p = path.join(DL_BASE, d.dir, 'mobile.png')
  console.log(`${d.dir}: ${fs.existsSync(p) ? 'OK' : 'MISSING'}`)
}
