// String-contract guard for app.js modularisation slice 41:
// Toast, SVG icons, escapeHtml, STATUS_COMPONENT_LABELS moved to app-helpers.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),         'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-helpers.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),     'utf-8')

describe('helpers modularisation: app-helpers.js is the owner', () => {
  it('showToast lives in the module', () => {
    expect(MODULE).toContain('function showToast(')
  })

  it('escapeHtml lives in the module', () => {
    expect(MODULE).toContain('function escapeHtml(')
  })

  it('pauseIcon lives in the module', () => {
    expect(MODULE).toContain('function pauseIcon(')
  })

  it('STATUS_COMPONENT_LABELS is in the module', () => {
    expect(MODULE).toContain('const STATUS_COMPONENT_LABELS =')
  })
})

describe('helpers modularisation: app.js delegates, does not define', () => {
  it('showToast is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function showToast\(/m)
  })

  it('escapeHtml is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function escapeHtml\(/m)
  })

  it('STATUS_COMPONENT_LABELS is not defined in app.js', () => {
    expect(APP).not.toMatch(/^const STATUS_COMPONENT_LABELS =/m)
  })
})

describe('helpers modularisation: index.html wiring', () => {
  it('index.html loads app-helpers.js', () => {
    expect(HTML).toContain('src="/app-helpers.js"')
  })

  it('app-helpers.js loads after app-elements.js (toast DOM ref dependency)', () => {
    const helpersIdx = HTML.indexOf('src="/app-helpers.js"')
    const elemIdx    = HTML.indexOf('src="/app-elements.js"')
    expect(helpersIdx).toBeGreaterThan(-1)
    expect(helpersIdx).toBeGreaterThan(elemIdx)
  })

  it('app-helpers.js loads before fork-updates.js', () => {
    const helpersIdx = HTML.indexOf('src="/app-helpers.js"')
    const forkIdx    = HTML.indexOf('src="/fork-updates.js"')
    expect(helpersIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(helpersIdx)
  })
})
