// String-contract guard for app.js modularisation slice 31:
// Agents API, HUD, and Federated agent cards moved to app-agents.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),        'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-agents.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),    'utf-8')

describe('agents modularisation: app-agents.js is the owner', () => {
  it('loadAgents lives in the module', () => {
    expect(MODULE).toContain('async function loadAgents(')
  })

  it('renderAgents lives in the module', () => {
    expect(MODULE).toContain('function renderAgents(')
  })

  it('startAgentsBusyPoll lives in the module', () => {
    expect(MODULE).toContain('function startAgentsBusyPoll(')
  })

  it('renderFederatedAgentCards lives in the module', () => {
    expect(MODULE).toContain('function renderFederatedAgentCards(')
  })

  it('openMarveenDetail lives in the module', () => {
    expect(MODULE).toContain('async function openMarveenDetail(')
  })

  it('federatedPeerStatus state variable is in the module', () => {
    expect(MODULE).toContain('let federatedPeerStatus = []')
  })
})

describe('agents modularisation: app.js delegates, does not define', () => {
  it('loadAgents is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadAgents\(/m)
  })

  it('renderAgents is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function renderAgents\(/m)
  })

  it('federatedPeerStatus is not declared in app.js', () => {
    expect(APP).not.toContain('let federatedPeerStatus = []')
  })
})

describe('agents modularisation: index.html wiring', () => {
  it('index.html loads app-agents.js', () => {
    expect(HTML).toContain('src="/app-agents.js"')
  })

  it('app-agents.js loads after app-skills-detail.js (which it depends on)', () => {
    const agentsIdx = HTML.indexOf('src="/app-agents.js"')
    const skillsIdx = HTML.indexOf('src="/app-skills-detail.js"')
    expect(agentsIdx).toBeGreaterThan(-1)
    expect(skillsIdx).toBeGreaterThan(-1)
    expect(agentsIdx).toBeGreaterThan(skillsIdx)
  })

  it('app-agents.js loads after app-auth-channel.js (agentIsConnected, updateChannelTab deps)', () => {
    const agentsIdx = HTML.indexOf('src="/app-agents.js"')
    const authIdx   = HTML.indexOf('src="/app-auth-channel.js"')
    expect(agentsIdx).toBeGreaterThan(authIdx)
  })

  it('app-agents.js loads before fork-updates.js', () => {
    const agentsIdx = HTML.indexOf('src="/app-agents.js"')
    const forkIdx   = HTML.indexOf('src="/fork-updates.js"')
    expect(agentsIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(agentsIdx)
  })
})
