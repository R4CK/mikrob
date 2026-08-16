// String-contract guard for app.js modularisation slice 43:
// mainAgentId, activeSubagents, refreshSubagents moved to app-auth-bootstrap.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),                'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-auth-bootstrap.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),            'utf-8')

describe('auth-bootstrap modularisation: app-auth-bootstrap.js is the owner', () => {
  it('mainAgentId lives in the module', () => {
    expect(MODULE).toContain('function mainAgentId(')
  })

  it('activeSubagents is declared in the module', () => {
    expect(MODULE).toContain('let activeSubagents =')
  })

  it('refreshSubagents lives in the module', () => {
    expect(MODULE).toContain('async function refreshSubagents(')
  })

  it('init calls are in the module', () => {
    expect(MODULE).toContain('refreshSubagents()')
    expect(MODULE).toContain('setInterval(refreshSubagents')
  })
})

describe('auth-bootstrap modularisation: app.js delegates, does not define', () => {
  it('mainAgentId is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function mainAgentId\(/m)
  })

  it('activeSubagents is not declared in app.js', () => {
    expect(APP).not.toMatch(/^let activeSubagents =/m)
  })

  it('refreshSubagents is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function refreshSubagents\(/m)
  })
})

describe('auth-bootstrap modularisation: index.html wiring', () => {
  it('index.html loads app-auth-bootstrap.js', () => {
    expect(HTML).toContain('src="/app-auth-bootstrap.js"')
  })

  it('app-auth-bootstrap.js loads after app.js', () => {
    const bootstrapIdx = HTML.indexOf('src="/app-auth-bootstrap.js"')
    const appIdx       = HTML.indexOf('src="/app.js"')
    expect(bootstrapIdx).toBeGreaterThan(-1)
    expect(bootstrapIdx).toBeGreaterThan(appIdx)
  })

  it('app-auth-bootstrap.js loads before app-activity.js', () => {
    const bootstrapIdx = HTML.indexOf('src="/app-auth-bootstrap.js"')
    const activityIdx  = HTML.indexOf('src="/app-activity.js"')
    expect(bootstrapIdx).toBeGreaterThan(-1)
    expect(activityIdx).toBeGreaterThan(bootstrapIdx)
  })

  it('app-auth-bootstrap.js loads before fork-updates.js', () => {
    const bootstrapIdx = HTML.indexOf('src="/app-auth-bootstrap.js"')
    const forkIdx      = HTML.indexOf('src="/fork-updates.js"')
    expect(bootstrapIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(bootstrapIdx)
  })
})
