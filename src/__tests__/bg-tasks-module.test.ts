// String-contract guard for app.js modularisation slice 7 (card cc6f787d):
// Background Tasks section moved to app-bg-tasks.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-bg-tasks.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('bg-tasks modularisation: app-bg-tasks.js is the owner', () => {
  it('loadBgTasksPage lives in app-bg-tasks.js', () => {
    expect(MODULE).toContain('async function loadBgTasksPage()')
  })

  it('startBgTask lives in app-bg-tasks.js', () => {
    expect(MODULE).toContain('async function startBgTask()')
  })

  it('loadBgTasks lives in app-bg-tasks.js', () => {
    expect(MODULE).toContain('async function loadBgTasks()')
  })

  it('viewBgTask lives in app-bg-tasks.js', () => {
    expect(MODULE).toContain('async function viewBgTask(')
  })

  it('cancelBgTask lives in app-bg-tasks.js', () => {
    expect(MODULE).toContain('async function cancelBgTask(')
  })

  it('bgInitialized state lives in app-bg-tasks.js', () => {
    expect(MODULE).toContain('let bgInitialized = false')
  })

  it('bgRefreshTimer state lives in app-bg-tasks.js', () => {
    expect(MODULE).toContain('let bgRefreshTimer = null')
  })
})

describe('bg-tasks modularisation: app.js delegates, does not define', () => {
  it('loadBgTasksPage is not defined in app.js (only called)', () => {
    // The stub comment contains the function name -- allow that, but not a function definition
    expect(APP).not.toMatch(/^async function loadBgTasksPage\(\)/m)
  })

  it('bgInitialized is not declared in app.js', () => {
    expect(APP).not.toContain('let bgInitialized')
  })

  it('bgRefreshTimer is not declared in app.js', () => {
    expect(APP).not.toContain('let bgRefreshTimer')
  })
})

describe('bg-tasks modularisation: index.html wiring', () => {
  it('index.html loads app-bg-tasks.js', () => {
    expect(HTML).toContain('src="/app-bg-tasks.js"')
  })

  it('app-bg-tasks.js loads after app-approvals.js', () => {
    const approvalsIdx = HTML.indexOf('src="/app-approvals.js"')
    const bgTasksIdx = HTML.indexOf('src="/app-bg-tasks.js"')
    expect(approvalsIdx).toBeGreaterThan(-1)
    expect(bgTasksIdx).toBeGreaterThan(approvalsIdx)
  })

  it('app-bg-tasks.js loads before fork-updates.js', () => {
    const bgTasksIdx = HTML.indexOf('src="/app-bg-tasks.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(bgTasksIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(bgTasksIdx)
  })
})
