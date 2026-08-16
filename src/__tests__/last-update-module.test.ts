// String-contract guard for app.js modularisation slice 42:
// renderLastUpdateBadge + refreshLastUpdateBadge moved to app-last-update.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),             'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-last-update.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),         'utf-8')

describe('last-update modularisation: app-last-update.js is the owner', () => {
  it('renderLastUpdateBadge lives in the module', () => {
    expect(MODULE).toContain('function renderLastUpdateBadge(')
  })

  it('refreshLastUpdateBadge lives in the module', () => {
    expect(MODULE).toContain('async function refreshLastUpdateBadge(')
  })

  it('init call is in the module (not in app.js)', () => {
    expect(MODULE).toContain('refreshLastUpdateBadge()')
  })
})

describe('last-update modularisation: app.js delegates, does not define', () => {
  it('renderLastUpdateBadge is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function renderLastUpdateBadge\(/m)
  })

  it('refreshLastUpdateBadge is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function refreshLastUpdateBadge\(/m)
  })
})

describe('last-update modularisation: index.html wiring', () => {
  it('index.html loads app-last-update.js', () => {
    expect(HTML).toContain('src="/app-last-update.js"')
  })

  it('app-last-update.js loads after app.js', () => {
    const lastUpdateIdx = HTML.indexOf('src="/app-last-update.js"')
    const appIdx        = HTML.indexOf('src="/app.js"')
    expect(lastUpdateIdx).toBeGreaterThan(-1)
    expect(lastUpdateIdx).toBeGreaterThan(appIdx)
  })

  it('app-last-update.js loads before fork-updates.js', () => {
    const lastUpdateIdx = HTML.indexOf('src="/app-last-update.js"')
    const forkIdx       = HTML.indexOf('src="/fork-updates.js"')
    expect(lastUpdateIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(lastUpdateIdx)
  })
})
