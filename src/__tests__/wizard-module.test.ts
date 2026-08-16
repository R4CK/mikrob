// String-contract guard for app.js modularisation slice 34:
// Wizard logic (agent create flow) moved to app-wizard.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),        'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-wizard.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),    'utf-8')

describe('wizard modularisation: app-wizard.js is the owner', () => {
  it('loadProfiles lives in the module', () => {
    expect(MODULE).toContain('async function loadProfiles(')
  })

  it('renderWizardPendingBanner lives in the module', () => {
    expect(MODULE).toContain('function renderWizardPendingBanner(')
  })

  it('resetWizard lives in the module', () => {
    expect(MODULE).toContain('function resetWizard(')
  })

  it('the create-agent submit handler is in the module', () => {
    expect(MODULE).toContain('/api/agents')
    expect(MODULE).toContain("method: 'POST'")
  })
})

describe('wizard modularisation: app.js delegates, does not define', () => {
  it('loadProfiles is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadProfiles\(/m)
  })

  it('resetWizard is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function resetWizard\(/m)
  })
})

describe('wizard modularisation: index.html wiring', () => {
  it('index.html loads app-wizard.js', () => {
    expect(HTML).toContain('src="/app-wizard.js"')
  })

  it('app-wizard.js loads after app-settings.js (loadAvailableModels dep)', () => {
    const wizardIdx   = HTML.indexOf('src="/app-wizard.js"')
    const settingsIdx = HTML.indexOf('src="/app-settings.js"')
    expect(wizardIdx).toBeGreaterThan(-1)
    expect(settingsIdx).toBeGreaterThan(-1)
    expect(wizardIdx).toBeGreaterThan(settingsIdx)
  })

  it('app-wizard.js loads before fork-updates.js', () => {
    const wizardIdx = HTML.indexOf('src="/app-wizard.js"')
    const forkIdx   = HTML.indexOf('src="/fork-updates.js"')
    expect(wizardIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(wizardIdx)
  })
})
