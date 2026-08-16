// String-contract guard for app.js modularisation slice 19:
// CostOps + Memory Import + Koltöztetes + Fleet Migration moved to app-import-migration.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),                  'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-import-migration.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),              'utf-8')

describe('import-migration modularisation: app-import-migration.js is the owner', () => {
  it('loadCosts lives in app-import-migration.js', () => {
    expect(MODULE).toContain('async function loadCosts(')
  })

  it('app-import-migration.js fetches /api/costs/summary', () => {
    expect(MODULE).toContain('/api/costs/summary')
  })

  it('memImportOverlay is declared in app-import-migration.js', () => {
    expect(MODULE).toContain("document.getElementById('memImportOverlay')")
  })

  it('app-import-migration.js fetches /api/memories to save imports', () => {
    expect(MODULE).toContain('/api/memories')
  })

  it('loadMigrateAgents lives in app-import-migration.js', () => {
    expect(MODULE).toContain('async function loadMigrateAgents(')
  })

  it('fleet export fetches /api/fleet/export', () => {
    expect(MODULE).toContain('/api/fleet/export')
  })

  it('fleet import fetches /api/fleet/import', () => {
    expect(MODULE).toContain('/api/fleet/import')
  })

  it('fleetLastBody state variable lives in app-import-migration.js', () => {
    expect(MODULE).toContain('let fleetLastBody = null')
  })
})

describe('import-migration modularisation: app.js delegates, does not define', () => {
  it('loadCosts is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadCosts\(/m)
  })

  it('loadMigrateAgents is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadMigrateAgents\(/m)
  })

  it('fleetLastBody is not declared in app.js', () => {
    expect(APP).not.toContain('let fleetLastBody = null')
  })

  it('import-migration stub is in place in app.js', () => {
    expect(APP).toContain('see web/app-import-migration.js')
  })
})

describe('import-migration modularisation: index.html wiring', () => {
  it('index.html loads app-import-migration.js', () => {
    expect(HTML).toContain('src="/app-import-migration.js"')
  })

  it('app-import-migration.js loads after app-terminal.js', () => {
    const terminalIdx = HTML.indexOf('src="/app-terminal.js"')
    const importIdx   = HTML.indexOf('src="/app-import-migration.js"')
    expect(terminalIdx).toBeGreaterThan(-1)
    expect(importIdx).toBeGreaterThan(terminalIdx)
  })

  it('app-import-migration.js loads before fork-updates.js', () => {
    const importIdx = HTML.indexOf('src="/app-import-migration.js"')
    const forkIdx   = HTML.indexOf('src="/fork-updates.js"')
    expect(importIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(importIdx)
  })
})
