// String-contract guard for app.js modularisation slice 36:
// i18n nav + static element rendering moved to app-i18n-nav.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),           'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-i18n-nav.js'),  'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),       'utf-8')

describe('i18n-nav modularisation: app-i18n-nav.js is the owner', () => {
  it('renderNav lives in the module', () => {
    expect(MODULE).toContain('function renderNav(')
  })

  it('renderStaticI18n lives in the module', () => {
    expect(MODULE).toContain('function renderStaticI18n(')
  })

  it('NAV_I18N lives in the module', () => {
    expect(MODULE).toContain('const NAV_I18N =')
  })

  it('PAGE_HEADER_I18N lives in the module', () => {
    expect(MODULE).toContain('const PAGE_HEADER_I18N =')
  })

  it('DOMContentLoaded init listener is in the module', () => {
    expect(MODULE).toContain("'DOMContentLoaded'")
    expect(MODULE).toContain('renderStaticI18n()')
  })
})

describe('i18n-nav modularisation: app.js delegates, does not define', () => {
  it('renderNav is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function renderNav\(/m)
  })

  it('renderStaticI18n is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function renderStaticI18n\(/m)
  })

  it('PAGE_HEADER_I18N is not defined in app.js', () => {
    expect(APP).not.toMatch(/^const PAGE_HEADER_I18N =/m)
  })
})

describe('i18n-nav modularisation: index.html wiring', () => {
  it('index.html loads app-i18n-nav.js', () => {
    expect(HTML).toContain('src="/app-i18n-nav.js"')
  })

  it('app-i18n-nav.js loads after app-onboarding.js (applyOnboardingProviderTab dep)', () => {
    const navIdx      = HTML.indexOf('src="/app-i18n-nav.js"')
    const onboardIdx  = HTML.indexOf('src="/app-onboarding.js"')
    expect(navIdx).toBeGreaterThan(-1)
    expect(onboardIdx).toBeGreaterThan(-1)
    expect(navIdx).toBeGreaterThan(onboardIdx)
  })

  it('app-i18n-nav.js loads before fork-updates.js', () => {
    const navIdx  = HTML.indexOf('src="/app-i18n-nav.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(navIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(navIdx)
  })
})
