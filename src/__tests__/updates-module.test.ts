// String-contract guard for app.js modularisation slice 25:
// Updates page helpers moved to app-updates.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),         'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-updates.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),     'utf-8')

describe('updates modularisation: app-updates.js is the owner', () => {
  it('escapeHtmlUpdates lives in app-updates.js', () => {
    expect(MODULE).toContain('function escapeHtmlUpdates(s)')
  })

  it('renderUpdatesBadge lives in app-updates.js', () => {
    expect(MODULE).toContain('function renderUpdatesBadge(status)')
  })

  it('wireBranchDriftBanner lives in app-updates.js', () => {
    expect(MODULE).toContain('function wireBranchDriftBanner(')
  })

  it('renderBranchNotice lives in app-updates.js', () => {
    expect(MODULE).toContain('function renderBranchNotice(status)')
  })

  it('renderDiagnoseOffer lives in app-updates.js', () => {
    expect(MODULE).toContain('async function renderDiagnoseOffer(')
  })

  it('runUpdate lives in app-updates.js', () => {
    expect(MODULE).toContain('async function runUpdate(autoStash)')
  })

  it('pollUpdateOutcome lives in app-updates.js', () => {
    expect(MODULE).toContain('async function pollUpdateOutcome(resetBtn)')
  })

  it('updatesCheckBtn listener is in app-updates.js', () => {
    expect(MODULE).toContain("'updatesCheckBtn'")
  })

  it('updatesApplyBtn listener is in app-updates.js', () => {
    expect(MODULE).toContain("'updatesApplyBtn'")
  })

  it('pollUpdatesBadge init call is in app-updates.js', () => {
    expect(MODULE).toContain('pollUpdatesBadge()')
    expect(MODULE).toContain('setInterval(pollUpdatesBadge')
  })
})

describe('updates modularisation: app.js keeps fork-seam + fork-only functions', () => {
  it('loadUpdates() stays in app.js (fork-overlay seam)', () => {
    expect(APP).toMatch(/^async function loadUpdates\(\)/m)
  })

  it('handleRepoInstallClick stays in app.js (fork-only)', () => {
    expect(APP).toContain('async function handleRepoInstallClick(btn)')
  })

  it('runRepoInstall stays in app.js (fork-only)', () => {
    expect(APP).toContain('async function runRepoInstall(repoKey, btn)')
  })

  it('escapeHtmlUpdates is NOT defined in app.js (moved to module)', () => {
    expect(APP).not.toMatch(/^function escapeHtmlUpdates\(/m)
  })

  it('renderUpdatesBadge is NOT defined in app.js (moved to module)', () => {
    expect(APP).not.toMatch(/^function renderUpdatesBadge\(/m)
  })

  it('renderUpdatesVersion IS still in app.js (upstream fn, fork-updates.js calls it)', () => {
    expect(APP).toContain('function renderUpdatesVersion(data)')
  })

  it('stub comment is present in app.js', () => {
    expect(APP).toContain('see web/app-updates.js')
  })

  it('pollUpdatesBadge init is NOT in app.js (moved to module bottom)', () => {
    expect(APP).not.toMatch(/^pollUpdatesBadge\(\)\s*$/m)
    expect(APP).not.toMatch(/^setInterval\(pollUpdatesBadge/m)
  })
})

describe('updates modularisation: index.html wiring', () => {
  it('index.html loads app-updates.js', () => {
    expect(HTML).toContain('src="/app-updates.js"')
  })

  it('app-updates.js loads before fork-updates.js', () => {
    const updatesIdx = HTML.indexOf('src="/app-updates.js"')
    const forkIdx    = HTML.indexOf('src="/fork-updates.js"')
    expect(updatesIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(updatesIdx)
  })

  it('app-updates.js loads after app.js (depends on globals defined there)', () => {
    const appIdx     = HTML.indexOf('src="/app.js"')
    const updatesIdx = HTML.indexOf('src="/app-updates.js"')
    expect(appIdx).toBeGreaterThan(-1)
    expect(updatesIdx).toBeGreaterThan(appIdx)
  })
})
