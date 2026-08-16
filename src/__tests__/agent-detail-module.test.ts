// String-contract guard for app.js modularisation slice 32:
// Agent Detail, avatar gallery, avatar upload, process control, and tab switching
// moved to app-agent-detail.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),              'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-agent-detail.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),          'utf-8')

describe('agent-detail modularisation: app-agent-detail.js is the owner', () => {
  it('openAgentDetail lives in the module', () => {
    expect(MODULE).toContain('async function openAgentDetail(')
  })

  it('switchAgentTab lives in the module', () => {
    expect(MODULE).toContain('function switchAgentTab(')
  })

  it('updateProcessControl lives in the module', () => {
    expect(MODULE).toContain('function updateProcessControl(')
  })

  it('populateDetailAvatarGrid lives in the module', () => {
    expect(MODULE).toContain('function populateDetailAvatarGrid(')
  })

  it('avatar file upload IIFE is in the module', () => {
    expect(MODULE).toContain('avatarUploadZone')
  })
})

describe('agent-detail modularisation: app.js delegates, does not define', () => {
  it('openAgentDetail is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function openAgentDetail\(/m)
  })

  it('switchAgentTab is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function switchAgentTab\(/m)
  })

  it('updateProcessControl is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function updateProcessControl\(/m)
  })
})

describe('agent-detail modularisation: index.html wiring', () => {
  it('index.html loads app-agent-detail.js', () => {
    expect(HTML).toContain('src="/app-agent-detail.js"')
  })

  it('app-agent-detail.js loads after app-agents.js (getAvatarGradient dep)', () => {
    const detailIdx  = HTML.indexOf('src="/app-agent-detail.js"')
    const agentsIdx  = HTML.indexOf('src="/app-agents.js"')
    expect(detailIdx).toBeGreaterThan(-1)
    expect(agentsIdx).toBeGreaterThan(-1)
    expect(detailIdx).toBeGreaterThan(agentsIdx)
  })

  it('app-agent-detail.js loads after app-auth-channel.js (updateChannelTab dep)', () => {
    const detailIdx = HTML.indexOf('src="/app-agent-detail.js"')
    const authIdx   = HTML.indexOf('src="/app-auth-channel.js"')
    expect(detailIdx).toBeGreaterThan(authIdx)
  })

  it('app-agent-detail.js loads before fork-updates.js', () => {
    const detailIdx = HTML.indexOf('src="/app-agent-detail.js"')
    const forkIdx   = HTML.indexOf('src="/fork-updates.js"')
    expect(detailIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(detailIdx)
  })
})
