// Fetch PNGs for the 10 already-generated Stitch screens.
// Strategy: list all project screens (this populates screenshot.downloadUrl),
// then download the last N screens' PNGs into their output dirs.
// Usage: STITCH_API_KEY=... node fetch-pngs.mjs [--count N] [--generate]
import fs from 'node:fs'
import path from 'node:path'
import { stitch } from '@google/stitch-sdk'

const PROJ = '3862263673254942781'
const DL_BASE = '/mnt/h/LM_Studio_Workdir/CleanCore/docs/design-previews/stitch-gen'

// The 10 dirs we need PNGs for (in generation order)
const DIRS = [
  'mw-consignment',
  'mw-feedback',
  'mw-form-builder',
  'fp-kiosk',
  'mw-leave',
  'public-scan',
  'mw-quality',
  'fp-scan',
  'mw-subcontractor',
  'sa-brand-preview',
]

if (!process.env.STITCH_API_KEY) { console.error('NO_KEY'); process.exit(2) }

async function download(url, dest) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`)
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()))
}

console.log('Listing all project screens (re-login to populate screenshot data)...')
const project = stitch.project(PROJ)
const screens = await project.screens()
console.log(`Total screens in project: ${screens.length}`)

// The 10 most recently generated screens should map to our 10 dirs (last added = end of list)
const recent = screens.slice(-10)
console.log(`Taking last ${recent.length} screens.`)

for (let i = 0; i < recent.length; i++) {
  const screen = recent[i]
  const dir = DIRS[i]
  const outDir = path.join(DL_BASE, dir)
  const outPng = path.join(outDir, 'generated.png')

  if (fs.existsSync(outPng)) {
    console.log(`SKIP ${dir} — PNG already exists`)
    continue
  }

  console.log(`Fetching PNG for ${dir} (screen id=${screen.id})...`)
  let imgUrl
  try {
    imgUrl = await screen.getImage()
  } catch (e) {
    console.error(`  getImage() failed for ${dir}: ${e.message}`)
    continue
  }
  if (!imgUrl) {
    console.log(`  No image URL yet for ${dir} — screenshot may still be processing`)
    continue
  }
  try {
    fs.mkdirSync(outDir, { recursive: true })
    await download(imgUrl, outPng)
    const kb = Math.round(fs.statSync(outPng).size / 1024)
    console.log(`  SAVED ${outPng} (${kb}KB)`)
  } catch (e) {
    console.error(`  Download failed for ${dir}: ${e.message}`)
  }
}

console.log('\nDone. Missing PNGs:')
for (const dir of DIRS) {
  const p = path.join(DL_BASE, dir, 'generated.png')
  console.log(`  ${dir}: ${fs.existsSync(p) ? 'OK' : 'MISSING'}`)
}
