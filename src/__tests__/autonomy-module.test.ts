// String-contract guard for app.js modularisation slice 17:
// Autonomy/Integrations content rendering moved to app-autonomy.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),         'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-autonomy.js'),'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),     'utf-8')

describe('autonomy modularisation: app-autonomy.js is the owner', () => {
  it('renderAutonomyContent lives in app-autonomy.js', () => {
    expect(MODULE).toMatch(/async function renderAutonomyContent\(/)
  })

  it('renderIntegrationsContent lives in app-autonomy.js', () => {
    expect(MODULE).toContain('async function renderIntegrationsContent(')
  })

  it('app-autonomy.js fetches /api/autonomy', () => {
    expect(MODULE).toContain('/api/autonomy')
  })

  it('app-autonomy.js has autonomy i18n keys', () => {
    expect(MODULE).toContain("'autonomy.loading'")
  })

  it('app-autonomy.js saves via PUT to /api/autonomy', () => {
    expect(MODULE).toContain("method: 'PUT'")
  })
})

describe('autonomy modularisation: app.js delegates, does not define', () => {
  it('renderAutonomyContent is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function renderAutonomyContent\(/m)
  })

  it('renderIntegrationsContent is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function renderIntegrationsContent\(/m)
  })

  it('Autonomy section stub is in place', () => {
    expect(APP).toContain('see web/app-autonomy.js')
  })
})

describe('autonomy modularisation: index.html wiring', () => {
  it('index.html loads app-autonomy.js', () => {
    expect(HTML).toContain('src="/app-autonomy.js"')
  })

  it('app-autonomy.js loads after app-overview.js', () => {
    const overviewIdx  = HTML.indexOf('src="/app-overview.js"')
    const autonomyIdx  = HTML.indexOf('src="/app-autonomy.js"')
    expect(overviewIdx).toBeGreaterThan(-1)
    expect(autonomyIdx).toBeGreaterThan(overviewIdx)
  })

  it('app-autonomy.js loads before fork-updates.js', () => {
    const autonomyIdx = HTML.indexOf('src="/app-autonomy.js"')
    const forkIdx     = HTML.indexOf('src="/fork-updates.js"')
    expect(autonomyIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(autonomyIdx)
  })
})
