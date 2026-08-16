// String-contract guard for app.js modularisation slice 40:
// Theme + Language toggle moved to app-theme-lang.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),            'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-theme-lang.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),        'utf-8')

describe('theme-lang modularisation: app-theme-lang.js is the owner', () => {
  it('theme toggle listener is in the module', () => {
    expect(MODULE).toContain("localStorage.setItem('cc-theme', next)")
  })

  it('savedTheme logic is in the module', () => {
    expect(MODULE).toContain("localStorage.getItem('cc-theme')")
  })

  it('language toggle IIFE is in the module', () => {
    expect(MODULE).toContain('function syncLangBtn(')
  })

  it('setLang wrapper is in the module', () => {
    expect(MODULE).toContain('_origSetLang = window.setLang')
  })
})

describe('theme-lang modularisation: app.js delegates, does not define', () => {
  it('themeToggle listener is not in app.js', () => {
    expect(APP).not.toContain("localStorage.setItem('cc-theme', next)")
  })

  it('savedTheme is not defined in app.js', () => {
    expect(APP).not.toMatch(/^const savedTheme =/m)
  })

  it('syncLangBtn is not defined in app.js', () => {
    expect(APP).not.toContain('function syncLangBtn(')
  })
})

describe('theme-lang modularisation: index.html wiring', () => {
  it('index.html loads app-theme-lang.js', () => {
    expect(HTML).toContain('src="/app-theme-lang.js"')
  })

  it('app-theme-lang.js loads after app.js', () => {
    const themeIdx = HTML.indexOf('src="/app-theme-lang.js"')
    const appIdx   = HTML.indexOf('src="/app.js"')
    expect(themeIdx).toBeGreaterThan(-1)
    expect(themeIdx).toBeGreaterThan(appIdx)
  })

  it('app-theme-lang.js loads before fork-updates.js', () => {
    const themeIdx = HTML.indexOf('src="/app-theme-lang.js"')
    const forkIdx  = HTML.indexOf('src="/fork-updates.js"')
    expect(themeIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(themeIdx)
  })
})
