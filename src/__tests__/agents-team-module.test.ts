// String-contract guard for app.js modularisation slice 20:
// Team org-chart, Agents view toggle, message log helpers moved to app-agents-team.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),              'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-agents-team.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),         'utf-8')

describe('agents-team modularisation: app-agents-team.js is the owner', () => {
  it('loadTeamGraph lives in app-agents-team.js', () => {
    expect(MODULE).toContain('async function loadTeamGraph(')
  })

  it('renderTeamGraph lives in app-agents-team.js', () => {
    expect(MODULE).toContain('function renderTeamGraph(')
  })

  it('_agentsActiveView state lives in app-agents-team.js', () => {
    // var (not let): must be on window so IIFE closures in other script tags can
    // write and read the same binding (card 27637425, fixed let->var).
    expect(MODULE).toContain("var _agentsActiveView = 'grid'")
  })

  it('_setAgentsView lives in app-agents-team.js', () => {
    expect(MODULE).toContain('function _setAgentsView(')
  })

  it('MSG_STATUS_META lives in app-agents-team.js', () => {
    expect(MODULE).toContain('const MSG_STATUS_META = {')
  })

  it('resolveOwnerName lives in app-agents-team.js', () => {
    expect(MODULE).toContain('async function resolveOwnerName(')
  })

  it('app-agents-team.js fetches /api/team/graph', () => {
    expect(MODULE).toContain('/api/team/graph')
  })
})

describe('agents-team modularisation: app.js delegates, does not define', () => {
  it('loadTeamGraph is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadTeamGraph\(/m)
  })

  it('renderTeamGraph is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function renderTeamGraph\(/m)
  })

  it('MSG_STATUS_META is not declared in app.js', () => {
    expect(APP).not.toContain('const MSG_STATUS_META = {')
  })

  it('agents-team stub is in place in app.js', () => {
    expect(APP).toContain('see web/app-agents-team.js')
  })
})

describe('agents-team modularisation: index.html wiring', () => {
  it('index.html loads app-agents-team.js', () => {
    expect(HTML).toContain('src="/app-agents-team.js"')
  })

  it('app-agents-team.js loads after app-import-migration.js', () => {
    const importIdx = HTML.indexOf('src="/app-import-migration.js"')
    const teamIdx   = HTML.indexOf('src="/app-agents-team.js"')
    expect(importIdx).toBeGreaterThan(-1)
    expect(teamIdx).toBeGreaterThan(importIdx)
  })

  it('app-agents-team.js loads before fork-updates.js', () => {
    const teamIdx = HTML.indexOf('src="/app-agents-team.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(teamIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(teamIdx)
  })
})
