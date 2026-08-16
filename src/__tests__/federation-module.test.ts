// String-contract guard for app.js modularisation slice 12:
// Federation page section moved to app-federation.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-federation.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('federation modularisation: app-federation.js is the owner', () => {
  it('loadFederationPage lives in app-federation.js', () => {
    expect(MODULE).toContain('async function loadFederationPage()')
  })

  it('fedPageWired state lives in app-federation.js', () => {
    expect(MODULE).toContain('let fedPageWired = false')
  })

  it('renderFederationPage lives in app-federation.js', () => {
    expect(MODULE).toContain('function renderFederationPage()')
  })

  it('wireFederationPage lives in app-federation.js', () => {
    expect(MODULE).toContain('function wireFederationPage()')
  })

  it('fedTailscale state lives in app-federation.js', () => {
    expect(MODULE).toContain("let _fedTailscaleState = { status: 'idle' }")
  })
})

describe('federation modularisation: app.js delegates, does not define', () => {
  it('loadFederationPage is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadFederationPage\(\)/m)
  })

  it('fedPageWired is not declared in app.js', () => {
    expect(APP).not.toContain('let fedPageWired = false')
  })

  it('wireFederationPage is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function wireFederationPage\(\)/m)
  })
})

describe('federation modularisation: index.html wiring', () => {
  it('index.html loads app-federation.js', () => {
    expect(HTML).toContain('src="/app-federation.js"')
  })

  it('app-federation.js loads after app-skills.js', () => {
    const skillsIdx = HTML.indexOf('src="/app-skills.js"')
    const fedIdx = HTML.indexOf('src="/app-federation.js"')
    expect(skillsIdx).toBeGreaterThan(-1)
    expect(fedIdx).toBeGreaterThan(skillsIdx)
  })

  it('app-federation.js loads before fork-updates.js', () => {
    const fedIdx = HTML.indexOf('src="/app-federation.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(fedIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(fedIdx)
  })
})
