// String-contract guard for app.js modularisation slice 39:
// Page switching + mobile sidebar moved to app-page-switch.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),           'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-page-switch.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),       'utf-8')

describe('page-switch modularisation: app-page-switch.js is the owner', () => {
  it('switchPage lives in the module', () => {
    expect(MODULE).toContain('function switchPage(')
  })

  it('confirmSettingsLeave lives in the module', () => {
    expect(MODULE).toContain('function confirmSettingsLeave(')
  })

  it('setSidebarOpen lives in the module', () => {
    expect(MODULE).toContain('function setSidebarOpen(')
  })

  it('navLinks click handler is in the module', () => {
    expect(MODULE).toContain('navLinks.forEach(')
    expect(MODULE).toContain("location.hash =")
  })
})

describe('page-switch modularisation: app.js delegates, does not define', () => {
  it('switchPage is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function switchPage\(/m)
  })

  it('setSidebarOpen is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function setSidebarOpen\(/m)
  })
})

describe('page-switch modularisation: index.html wiring', () => {
  it('index.html loads app-page-switch.js', () => {
    expect(HTML).toContain('src="/app-page-switch.js"')
  })

  it('app-page-switch.js loads after app-elements.js', () => {
    const switchIdx  = HTML.indexOf('src="/app-page-switch.js"')
    const elemIdx    = HTML.indexOf('src="/app-elements.js"')
    expect(switchIdx).toBeGreaterThan(-1)
    expect(elemIdx).toBeGreaterThan(-1)
    expect(switchIdx).toBeGreaterThan(elemIdx)
  })

  it('app-page-switch.js loads before fork-updates.js', () => {
    const switchIdx = HTML.indexOf('src="/app-page-switch.js"')
    const forkIdx   = HTML.indexOf('src="/fork-updates.js"')
    expect(switchIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(switchIdx)
  })
})
