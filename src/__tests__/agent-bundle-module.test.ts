// String-contract guard for app.js modularisation slice 23:
// Agent export (fleet bundle), Agent import, Auto-restart, Voice config moved to app-agent-bundle.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),               'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-agent-bundle.js'),  'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),           'utf-8')

describe('agent-bundle modularisation: app-agent-bundle.js is the owner', () => {
  it('exportAllAgentsBtn handler lives in app-agent-bundle.js', () => {
    expect(MODULE).toContain("document.getElementById('exportAllAgentsBtn')")
  })

  it('importAgentBtn handler lives in app-agent-bundle.js', () => {
    expect(MODULE).toContain("document.getElementById('importAgentBtn')")
  })

  it('loadVoiceConfig lives in app-agent-bundle.js', () => {
    expect(MODULE).toContain('async function loadVoiceConfig(')
  })

  it('saveVoiceConfigBtn handler lives in app-agent-bundle.js', () => {
    expect(MODULE).toContain("document.getElementById('saveVoiceConfigBtn')")
  })

  it('saveAutoRestartBtn handler lives in app-agent-bundle.js', () => {
    expect(MODULE).toContain("document.getElementById('saveAutoRestartBtn')")
  })

  it('app-agent-bundle.js references /api/agents/export-all', () => {
    expect(MODULE).toContain('/api/agents/export-all')
  })

  it('app-agent-bundle.js references /api/agents/import', () => {
    expect(MODULE).toContain('/api/agents/import')
  })

  it('app-agent-bundle.js references /api/voice', () => {
    expect(MODULE).toContain('/api/voice/')
  })
})

describe('agent-bundle modularisation: app.js delegates, does not define', () => {
  it('loadVoiceConfig is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadVoiceConfig\(/m)
  })

  it('agent-bundle stub is in place in app.js', () => {
    expect(APP).toContain('see web/app-agent-bundle.js')
  })
})

describe('agent-bundle modularisation: index.html wiring', () => {
  it('index.html loads app-agent-bundle.js', () => {
    expect(HTML).toContain('src="/app-agent-bundle.js"')
  })

  it('app-agent-bundle.js loads after app-skills-detail.js', () => {
    const detailIdx = HTML.indexOf('src="/app-skills-detail.js"')
    const bundleIdx = HTML.indexOf('src="/app-agent-bundle.js"')
    expect(detailIdx).toBeGreaterThan(-1)
    expect(bundleIdx).toBeGreaterThan(detailIdx)
  })

  it('app-agent-bundle.js loads before fork-updates.js', () => {
    const bundleIdx = HTML.indexOf('src="/app-agent-bundle.js"')
    const forkIdx   = HTML.indexOf('src="/fork-updates.js"')
    expect(bundleIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(bundleIdx)
  })
})
