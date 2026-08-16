// String-contract guard for app.js modularisation slice 45:
// routeFromHash IIFE moved to app-router.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_CORE = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-router.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('router modularisation: app-router.js is the owner', () => {
  it('routeFromHash lives in app-router.js', () => {
    expect(MODULE).toContain('function routeFromHash()')
  })

  it('hashchange listener is in app-router.js', () => {
    expect(MODULE).toContain("addEventListener('hashchange', routeFromHash)")
  })

  it('DOMContentLoaded dispatch is in app-router.js', () => {
    expect(MODULE).toContain("addEventListener('DOMContentLoaded', routeFromHash)")
  })

  it('team->agents redirect is in app-router.js', () => {
    expect(MODULE).toContain("pageId === 'team'")
  })
})

describe('router modularisation: app.js delegates, does not define', () => {
  it('routeFromHash is not defined in app.js', () => {
    expect(APP_CORE).not.toContain('function routeFromHash()')
  })

  it('hashchange listener is not wired in app.js', () => {
    expect(APP_CORE).not.toContain("addEventListener('hashchange', routeFromHash)")
  })
})

describe('router modularisation: index.html wiring', () => {
  it('index.html loads app-router.js', () => {
    expect(HTML).toContain('src="/app-router.js"')
  })

  it('app-router.js loads after fork-updates.js (must be last)', () => {
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    const routerIdx = HTML.indexOf('src="/app-router.js"')
    expect(forkIdx).toBeGreaterThan(-1)
    expect(routerIdx).toBeGreaterThan(forkIdx)
  })
})
