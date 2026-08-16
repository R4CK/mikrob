// String-contract guard for app.js modularisation slice 24:
// First-run onboarding wizard moved to app-onboarding.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),           'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-onboarding.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),        'utf-8')

describe('onboarding modularisation: app-onboarding.js is the owner', () => {
  it('initOnboarding lives in app-onboarding.js', () => {
    expect(MODULE).toContain('async function initOnboarding(')
  })

  it('wireOnboarding lives in app-onboarding.js', () => {
    expect(MODULE).toContain('function wireOnboarding(step)')
  })

  it('renderOnboarding lives in app-onboarding.js', () => {
    expect(MODULE).toContain('function renderOnboarding(s)')
  })

  it('fetchOnboardingStatus lives in app-onboarding.js', () => {
    expect(MODULE).toContain('async function fetchOnboardingStatus(')
  })

  it('waitForChannelLive lives in app-onboarding.js', () => {
    expect(MODULE).toContain('async function waitForChannelLive(')
  })

  it('ONBOARDING_DISMISS_KEY const lives in app-onboarding.js', () => {
    expect(MODULE).toContain("const ONBOARDING_DISMISS_KEY = 'mvOnboardingDismissed'")
  })

  it('app-onboarding.js fetches /api/onboarding/status', () => {
    expect(MODULE).toContain('/api/onboarding/status')
  })
})

describe('onboarding modularisation: app.js delegates, does not define', () => {
  it('initOnboarding is NOT defined in app.js (moved to module)', () => {
    expect(APP).not.toMatch(/^async function initOnboarding\(/m)
  })

  it('wireOnboarding is NOT defined in app.js', () => {
    expect(APP).not.toMatch(/^function wireOnboarding\(/m)
  })

  it('renderOnboarding is NOT defined in app.js', () => {
    expect(APP).not.toMatch(/^function renderOnboarding\(/m)
  })

  it('onboarding stub is in place in app.js', () => {
    expect(APP).toContain('see web/app-onboarding.js')
  })

  it('initOnboarding() call is still in the Init block in app.js', () => {
    const initIdx = APP.indexOf('// === Init ===')
    expect(initIdx).toBeGreaterThan(-1)
    const initBlock = APP.slice(initIdx, initIdx + 600)
    expect(initBlock).toContain('initOnboarding()')
  })
})

describe('onboarding modularisation: index.html wiring', () => {
  it('index.html loads app-onboarding.js', () => {
    expect(HTML).toContain('src="/app-onboarding.js"')
  })

  it('app-onboarding.js loads after app-agent-bundle.js', () => {
    const bundleIdx    = HTML.indexOf('src="/app-agent-bundle.js"')
    const onboardingIdx = HTML.indexOf('src="/app-onboarding.js"')
    expect(bundleIdx).toBeGreaterThan(-1)
    expect(onboardingIdx).toBeGreaterThan(bundleIdx)
  })

  it('app-onboarding.js loads before fork-updates.js', () => {
    const onboardingIdx = HTML.indexOf('src="/app-onboarding.js"')
    const forkIdx       = HTML.indexOf('src="/fork-updates.js"')
    expect(onboardingIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(onboardingIdx)
  })
})
