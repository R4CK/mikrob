// String-contract guard for app.js modularisation slice 13:
// Per-device keys + Settings load section moved to app-device-keys.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-device-keys.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('device-keys modularisation: app-device-keys.js is the owner', () => {
  it('loadSettings lives in app-device-keys.js', () => {
    expect(MODULE).toContain('async function loadSettings()')
  })

  it('renderDeviceKeysSection lives in app-device-keys.js', () => {
    expect(MODULE).toContain('function renderDeviceKeysSection(')
  })

  it('mintDeviceKey lives in app-device-keys.js', () => {
    expect(MODULE).toContain('async function mintDeviceKey()')
  })

  it('saveAllSettings lives in app-device-keys.js', () => {
    expect(MODULE).toContain('async function saveAllSettings()')
  })

  it('resetAllSettings lives in app-device-keys.js', () => {
    expect(MODULE).toContain('function resetAllSettings()')
  })
})

describe('device-keys modularisation: app.js delegates, does not define', () => {
  it('loadSettings is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadSettings\(\)/m)
  })

  it('app.js uses lambda for refreshSettingsBtn to defer loadSettings resolution', () => {
    expect(APP).toContain("addEventListener('click', () => loadSettings())")
  })

  it('renderDeviceKeysSection is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function renderDeviceKeysSection\(/m)
  })
})

describe('device-keys modularisation: index.html wiring', () => {
  it('index.html loads app-device-keys.js', () => {
    expect(HTML).toContain('src="/app-device-keys.js"')
  })

  it('app-device-keys.js loads after app-skills.js', () => {
    const skillsIdx = HTML.indexOf('src="/app-skills.js"')
    const dkIdx = HTML.indexOf('src="/app-device-keys.js"')
    expect(skillsIdx).toBeGreaterThan(-1)
    expect(dkIdx).toBeGreaterThan(skillsIdx)
  })

  it('app-device-keys.js loads before fork-updates.js', () => {
    const dkIdx = HTML.indexOf('src="/app-device-keys.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(dkIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(dkIdx)
  })
})
