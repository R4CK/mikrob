// String-contract guard for app.js modularisation slice 21:
// Auth Mode panel + Channel tab moved to app-auth-channel.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),              'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-auth-channel.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),          'utf-8')

describe('auth-channel modularisation: app-auth-channel.js is the owner', () => {
  it('selectAuthModeCard lives in app-auth-channel.js', () => {
    expect(MODULE).toContain('function selectAuthModeCard(')
  })

  it('updateAuthModeUI lives in app-auth-channel.js', () => {
    expect(MODULE).toContain('function updateAuthModeUI(')
  })

  it('agentIsConnected lives in app-auth-channel.js', () => {
    expect(MODULE).toContain('function agentIsConnected(')
  })

  it('updateChannelTab lives in app-auth-channel.js', () => {
    expect(MODULE).toContain('function updateChannelTab(')
  })

  it('refreshChannelHealth lives in app-auth-channel.js', () => {
    expect(MODULE).toContain('async function refreshChannelHealth(')
  })

  it('refreshPendingPairings lives in app-auth-channel.js', () => {
    expect(MODULE).toContain('async function refreshPendingPairings(')
  })

  it('app-auth-channel.js references /api/agents/.../channels', () => {
    expect(MODULE).toContain('/channels/')
  })

  it('app-auth-channel.js has channel provider awareness', () => {
    expect(MODULE).toContain('currentChannelProvider')
  })
})

describe('auth-channel modularisation: app.js delegates, does not define', () => {
  it('selectAuthModeCard is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function selectAuthModeCard\(/m)
  })

  it('agentIsConnected is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function agentIsConnected\(/m)
  })

  it('updateChannelTab is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function updateChannelTab\(/m)
  })

  it('auth-channel stub is in place in app.js', () => {
    expect(APP).toContain('see web/app-auth-channel.js')
  })
})

describe('auth-channel modularisation: index.html wiring', () => {
  it('index.html loads app-auth-channel.js', () => {
    expect(HTML).toContain('src="/app-auth-channel.js"')
  })

  it('app-auth-channel.js loads after app-agents-team.js', () => {
    const teamIdx    = HTML.indexOf('src="/app-agents-team.js"')
    const channelIdx = HTML.indexOf('src="/app-auth-channel.js"')
    expect(teamIdx).toBeGreaterThan(-1)
    expect(channelIdx).toBeGreaterThan(teamIdx)
  })

  it('app-auth-channel.js loads before fork-updates.js', () => {
    const channelIdx = HTML.indexOf('src="/app-auth-channel.js"')
    const forkIdx    = HTML.indexOf('src="/fork-updates.js"')
    expect(channelIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(channelIdx)
  })
})
