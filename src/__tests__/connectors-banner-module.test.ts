// String-contract guard for app.js modularisation slice 28:
// connectors.hu install banner IIFE moved to app-connectors-banner.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),                     'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-connectors-banner.js'),   'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),                 'utf-8')

describe('connectors-banner modularisation: app-connectors-banner.js is the owner', () => {
  it('banner IIFE lives in the module', () => {
    expect(MODULE).toContain("const DISMISSED_KEY = 'cxhu_banner_dismissed'")
  })

  it('checkStatus lives in the module', () => {
    expect(MODULE).toContain('async function checkStatus()')
  })

  it('showState lives in the module', () => {
    expect(MODULE).toContain('function showState(name)')
  })

  it('module installs the connectors-hu install endpoint call', () => {
    expect(MODULE).toContain('/api/connectors-hu/install')
  })
})

describe('connectors-banner modularisation: app.js delegates, does not define', () => {
  it('DISMISSED_KEY is not defined in app.js', () => {
    expect(APP).not.toContain("const DISMISSED_KEY = 'cxhu_banner_dismissed'")
  })

  it('cxhu_banner_dismissed key is not referenced in app.js', () => {
    expect(APP).not.toContain('cxhu_banner_dismissed')
  })
})

describe('connectors-banner modularisation: index.html wiring', () => {
  it('index.html loads app-connectors-banner.js', () => {
    expect(HTML).toContain('src="/app-connectors-banner.js"')
  })

  it('app-connectors-banner.js loads after app-updates.js', () => {
    const updatesIdx = HTML.indexOf('src="/app-updates.js"')
    const bannerIdx  = HTML.indexOf('src="/app-connectors-banner.js"')
    expect(updatesIdx).toBeGreaterThan(-1)
    expect(bannerIdx).toBeGreaterThan(updatesIdx)
  })

  it('app-connectors-banner.js loads before fork-updates.js', () => {
    const bannerIdx  = HTML.indexOf('src="/app-connectors-banner.js"')
    const forkIdx    = HTML.indexOf('src="/fork-updates.js"')
    expect(bannerIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(bannerIdx)
  })
})
