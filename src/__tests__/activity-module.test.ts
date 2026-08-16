// String-contract guard for app.js modularisation slice 35:
// Activity poll + Kanban auto-refresh moved to app-activity.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),          'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-activity.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),      'utf-8')

describe('activity modularisation: app-activity.js is the owner', () => {
  it('startActivityPoll lives in the module', () => {
    expect(MODULE).toContain('function startActivityPoll(')
  })

  it('stopActivityPoll lives in the module', () => {
    expect(MODULE).toContain('function stopActivityPoll(')
  })

  it('loadActivity lives in the module', () => {
    expect(MODULE).toContain('async function loadActivity(')
  })

  it('renderActivity lives in the module', () => {
    expect(MODULE).toContain('function renderActivity(')
  })

  it('ACTIVITY_STATE_META lives in the module', () => {
    expect(MODULE).toContain('ACTIVITY_STATE_META')
  })

  it('startKanbanRefresh lives in the module', () => {
    expect(MODULE).toContain('function startKanbanRefresh(')
  })
})

describe('activity modularisation: app.js delegates, does not define', () => {
  it('startActivityPoll is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function startActivityPoll\(/m)
  })

  it('renderActivity is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function renderActivity\(/m)
  })
})

describe('activity modularisation: index.html wiring', () => {
  it('index.html loads app-activity.js', () => {
    expect(HTML).toContain('src="/app-activity.js"')
  })

  it('app-activity.js loads after app-terminal.js (openTerminalModal dep)', () => {
    const actIdx      = HTML.indexOf('src="/app-activity.js"')
    const terminalIdx = HTML.indexOf('src="/app-terminal.js"')
    expect(actIdx).toBeGreaterThan(-1)
    expect(terminalIdx).toBeGreaterThan(-1)
    expect(actIdx).toBeGreaterThan(terminalIdx)
  })

  it('app-activity.js loads before fork-updates.js', () => {
    const actIdx  = HTML.indexOf('src="/app-activity.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(actIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(actIdx)
  })
})
