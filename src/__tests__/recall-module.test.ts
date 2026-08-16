// String-contract guard for app.js modularisation slice 8 (card 48d891b4):
// Recall/Napló section moved to app-recall.js. esc() helper stays in app.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-recall.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('recall modularisation: app-recall.js is the owner', () => {
  it('loadRecallPage lives in app-recall.js', () => {
    expect(MODULE).toContain('async function loadRecallPage()')
  })

  it('loadRecallDates lives in app-recall.js', () => {
    expect(MODULE).toContain('async function loadRecallDates()')
  })

  it('doRecall lives in app-recall.js', () => {
    expect(MODULE).toContain('async function doRecall()')
  })

  it('renderRecallSummary lives in app-recall.js', () => {
    expect(MODULE).toContain('function renderRecallSummary(')
  })

  it('renderRecallTimeline lives in app-recall.js', () => {
    expect(MODULE).toContain('function renderRecallTimeline(')
  })

  it('recallInitialized state lives in app-recall.js', () => {
    expect(MODULE).toContain('let recallInitialized = false')
  })

  it('recallSortDesc state lives in app-recall.js', () => {
    expect(MODULE).toContain('let recallSortDesc = true')
  })
})

describe('recall modularisation: app.js delegates, does not define', () => {
  it('loadRecallPage is not defined in app.js (only called at switchPage)', () => {
    expect(APP).not.toMatch(/^async function loadRecallPage\(\)/m)
  })

  it('recallInitialized is not declared in app.js', () => {
    expect(APP).not.toContain('let recallInitialized')
  })

  it('esc helper stays in app.js (used by all modules)', () => {
    expect(APP).toContain('function esc(s)')
  })
})

describe('recall modularisation: index.html wiring', () => {
  it('index.html loads app-recall.js', () => {
    expect(HTML).toContain('src="/app-recall.js"')
  })

  it('app-recall.js loads after app-bg-tasks.js', () => {
    const bgIdx = HTML.indexOf('src="/app-bg-tasks.js"')
    const recallIdx = HTML.indexOf('src="/app-recall.js"')
    expect(bgIdx).toBeGreaterThan(-1)
    expect(recallIdx).toBeGreaterThan(bgIdx)
  })

  it('app-recall.js loads before fork-updates.js', () => {
    const recallIdx = HTML.indexOf('src="/app-recall.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(recallIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(recallIdx)
  })
})
