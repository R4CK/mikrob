// String-contract guard for app.js modularisation slice 33:
// Settings save buttons + Model management moved to app-settings.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),          'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-settings.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),      'utf-8')

describe('settings modularisation: app-settings.js is the owner', () => {
  it('loadAvailableModels lives in the module', () => {
    expect(MODULE).toContain('async function loadAvailableModels(')
  })

  it('loadOllamaModels lives in the module', () => {
    expect(MODULE).toContain('async function loadOllamaModels(')
  })

  it('OpenRouter modal functions are in the module', () => {
    expect(MODULE).toContain('async function openOpenrouterModal(')
    expect(MODULE).toContain('function closeOpenrouterModal(')
  })

  it('model save button handler is in the module', () => {
    expect(MODULE).toContain("saveModelBtn").and
    expect(MODULE).toContain("/api/agents/")
  })

  it('init call loadAvailableModels() is at the end of the module', () => {
    const lastCall = MODULE.lastIndexOf('loadAvailableModels()')
    const defEnd = MODULE.indexOf('async function loadAvailableModels(')
    expect(lastCall).toBeGreaterThan(defEnd + 100)
  })
})

describe('settings modularisation: app.js delegates, does not define', () => {
  it('loadAvailableModels is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadAvailableModels\(/m)
  })

  it('loadOllamaModels is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadOllamaModels\(/m)
  })

  it('the bare loadAvailableModels() init call is removed from app.js Init block', () => {
    const initIdx = APP.indexOf('// === Init ===')
    expect(initIdx).toBeGreaterThan(-1)
    const initBlock = APP.slice(initIdx, initIdx + 500)
    // The bare top-level call must not be in the init block; references inside
    // comments (moved-notice) are allowed.
    const callIdx = initBlock.indexOf('\nloadAvailableModels()')
    expect(callIdx, 'bare loadAvailableModels() call still present in init block').toBe(-1)
  })
})

describe('settings modularisation: index.html wiring', () => {
  it('index.html loads app-settings.js', () => {
    expect(HTML).toContain('src="/app-settings.js"')
  })

  it('app-settings.js loads after app-agent-detail.js (updateProcessControl dep)', () => {
    const settingsIdx     = HTML.indexOf('src="/app-settings.js"')
    const agentDetailIdx  = HTML.indexOf('src="/app-agent-detail.js"')
    expect(settingsIdx).toBeGreaterThan(-1)
    expect(agentDetailIdx).toBeGreaterThan(-1)
    expect(settingsIdx).toBeGreaterThan(agentDetailIdx)
  })

  it('app-settings.js loads before fork-updates.js', () => {
    const settingsIdx = HTML.indexOf('src="/app-settings.js"')
    const forkIdx     = HTML.indexOf('src="/fork-updates.js"')
    expect(settingsIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(settingsIdx)
  })
})
