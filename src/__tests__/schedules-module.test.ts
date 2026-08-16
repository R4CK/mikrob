// String-contract guard for app.js modularisation slice 11 (card 0159301d):
// Schedules page (incl. Prompt expand + Save handler) moved to app-schedules.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-schedules.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('schedules modularisation: app-schedules.js is the owner', () => {
  it('loadSchedules lives in app-schedules.js', () => {
    expect(MODULE).toContain('async function loadSchedules()')
  })

  it('saveScheduleBtn event listener wired in app-schedules.js', () => {
    expect(MODULE).toContain('saveScheduleBtn.addEventListener')
  })

  it('scheduleList DOM ref lives in app-schedules.js', () => {
    expect(MODULE).toContain("const scheduleList = document.getElementById('scheduleList')")
  })

  it('saveScheduleBtn DOM ref lives in app-schedules.js', () => {
    expect(MODULE).toContain("const saveScheduleBtn = document.getElementById('saveScheduleBtn')")
  })

  it('Prompt expand handler lives in app-schedules.js', () => {
    expect(MODULE).toContain("document.getElementById('expandPromptBtn')")
  })
})

describe('schedules modularisation: app.js delegates, does not define', () => {
  it('loadSchedules is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadSchedules\(\)/m)
  })

  it('saveScheduleBtn is not bound in app.js', () => {
    expect(APP).not.toContain('saveScheduleBtn.addEventListener')
  })

  it('scheduleList is not declared in app.js', () => {
    expect(APP).not.toContain("const scheduleList = document.getElementById('scheduleList')")
  })
})

describe('schedules modularisation: index.html wiring', () => {
  it('index.html loads app-schedules.js', () => {
    expect(HTML).toContain('src="/app-schedules.js"')
  })

  it('app-schedules.js loads after app.js (via script order)', () => {
    const appIdx = HTML.indexOf('src="/app.js"')
    const schedulesIdx = HTML.indexOf('src="/app-schedules.js"')
    expect(appIdx).toBeGreaterThan(-1)
    expect(schedulesIdx).toBeGreaterThan(appIdx)
  })

  it('app-schedules.js loads before fork-updates.js', () => {
    const schedulesIdx = HTML.indexOf('src="/app-schedules.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(schedulesIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(schedulesIdx)
  })
})
