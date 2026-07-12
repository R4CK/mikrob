#!/usr/bin/env node
// Fetch a Google Stitch project's screens (HTML + screenshots), or generate a
// new screen from a prompt, using the vault "Stitch" secret.
//
// Requires: npm i @google/stitch-sdk  (not vendored here)
// Key: resolved at runtime from the vault, never hardcoded:
//   export STITCH_API_KEY=$(echo "K=Stitch" | node scripts/vault-resolve.mjs | sed 's/^K=//')
//
// Usage:
//   STITCH_API_KEY=... STITCH_PROJECT=<id> STITCH_OUT=<dir> node scripts/stitch-fetch.mjs
//   STITCH_API_KEY=... STITCH_PROJECT=<id> STITCH_OUT=<dir> STITCH_GEN="<prompt>" node scripts/stitch-fetch.mjs
import fs from 'node:fs'; import path from 'node:path'
const { STITCH_PROJECT: PROJ, STITCH_OUT: OUT, STITCH_GEN: GEN } = process.env
if (!process.env.STITCH_API_KEY) { console.error('NO_KEY (resolve from vault first)'); process.exit(2) }
if (!PROJ || !OUT) { console.error('need STITCH_PROJECT + STITCH_OUT'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })
const { stitch } = await import('@google/stitch-sdk')
const dl = async (u, d) => { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); fs.writeFileSync(d, Buffer.from(await r.arrayBuffer())) }
const project = stitch.project(PROJ)
if (GEN) {
  const s = await project.generate(GEN)
  let h, i; try { h = await s.getHtml() } catch {} try { i = await s.getImage() } catch {}
  if (h) await dl(h, path.join(OUT, 'generated.html'))
  if (i) await dl(i, path.join(OUT, 'generated.png'))
  console.log('GENERATED', s.id || '?'); process.exit(0)
}
const screens = await project.screens()
let n = 0
for (const s of (screens || [])) {
  n++; const base = String(n).padStart(2, '0') + '-' + (s.id || 'screen' + n)
  let h, i; try { h = await s.getHtml() } catch {} try { i = await s.getImage() } catch {}
  if (h) try { await dl(h, path.join(OUT, base + '.html')) } catch {}
  if (i) try { await dl(i, path.join(OUT, base + '.png')) } catch {}
}
console.log('FETCHED', n, 'screens ->', OUT)
