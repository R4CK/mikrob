// String-contract guard for app.js modularisation slice 29:
// Connectors page section moved to app-connectors.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),          'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-connectors.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),      'utf-8')

describe('connectors modularisation: app-connectors.js is the owner', () => {
  it('loadConnectors lives in the module', () => {
    expect(MODULE).toContain('async function loadConnectors()')
  })

  it('loadCatalog lives in the module', () => {
    expect(MODULE).toContain('async function loadCatalog(')
  })

  it('module contains the connectors API call', () => {
    expect(MODULE).toContain('/api/connectors')
  })

  it('connectorGrid is declared in the module', () => {
    expect(MODULE).toContain("const connectorGrid = document.getElementById('connectorGrid')")
  })
})

describe('connectors modularisation: app.js delegates, does not define', () => {
  it('loadConnectors is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadConnectors\(\)/m)
  })

  it('connectorGrid const is not declared in app.js', () => {
    expect(APP).not.toContain("const connectorGrid = document.getElementById('connectorGrid')")
  })
})

describe('connectors modularisation: index.html wiring', () => {
  it('index.html loads app-connectors.js', () => {
    expect(HTML).toContain('src="/app-connectors.js"')
  })

  it('app-connectors.js loads after app-agent-bundle.js', () => {
    const bundleIdx = HTML.indexOf('src="/app-agent-bundle.js"')
    const connIdx   = HTML.indexOf('src="/app-connectors.js"')
    expect(bundleIdx).toBeGreaterThan(-1)
    expect(connIdx).toBeGreaterThan(bundleIdx)
  })

  it('app-connectors.js loads before fork-updates.js', () => {
    const connIdx = HTML.indexOf('src="/app-connectors.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(connIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(connIdx)
  })
})
