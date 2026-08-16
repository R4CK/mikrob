// String-contract guard for card 1ba4997b: app.js modularisation slice 3 -- Memories + Daily Log.
// Verifies structural correctness of the extraction:
//   - app-memories.js contains the key public functions
//   - app.js has the stub comment (NOT the original code)
//   - index.html loads app-memories.js BEFORE app.js (init-time requirement)
//   - app.js call sites still reference the functions
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP     = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const MODULE  = readFileSync(join(__dirname, '../../web/app-memories.js'), 'utf-8')
const HTML    = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('memories-module: app-memories.js contains key public functions', () => {
  it('contains loadMemAgents (called at init time by app.js)', () => {
    expect(MODULE).toContain('async function loadMemAgents(')
  })

  it('contains loadMemStats', () => {
    expect(MODULE).toContain('async function loadMemStats(')
  })

  it('contains loadMemories', () => {
    expect(MODULE).toContain('async function loadMemories(')
  })

  it('contains renderMemories', () => {
    expect(MODULE).toContain('function renderMemories(')
  })

  it('contains loadMemoryGraph (force-directed graph)', () => {
    expect(MODULE).toContain('async function loadMemoryGraph(')
  })

  it('contains loadDailyLog', () => {
    expect(MODULE).toContain('async function loadDailyLog(')
  })

  it('contains renderLogEntries', () => {
    expect(MODULE).toContain('function renderLogEntries(')
  })

  it('contains formatLogDate', () => {
    expect(MODULE).toContain('function formatLogDate(')
  })

  it('has header comment explaining loading order constraint', () => {
    expect(MODULE).toContain('app-memories.js')
    expect(MODULE).toContain('app.js')
    expect(MODULE).toContain('BEFORE')
  })

  it('contains state variables (memSearchTimer, currentMemTier, etc.)', () => {
    expect(MODULE).toContain('let memSearchTimer')
    expect(MODULE).toContain('let currentMemTier')
    expect(MODULE).toContain('let currentLogDate')
    expect(MODULE).toContain('let logDates')
  })

  it('contains graph state variables', () => {
    expect(MODULE).toContain('let graphNodes')
    expect(MODULE).toContain('let graphZoom')
    expect(MODULE).toContain('let graphPanX')
  })
})

describe('memories-module: app.js has stub, NOT original code', () => {
  it('app.js has stub comment for the memories section', () => {
    expect(APP).toContain('app-memories.js')
    expect(APP).toContain('modularisation')
  })

  it('app.js does NOT contain loadMemAgents function body', () => {
    expect(APP).not.toContain('async function loadMemAgents(')
  })

  it('app.js does NOT contain loadMemStats function body', () => {
    expect(APP).not.toContain('async function loadMemStats(')
  })

  it('app.js does NOT contain loadMemories function body', () => {
    expect(APP).not.toContain('async function loadMemories(')
  })

  it('app.js does NOT contain loadDailyLog function body', () => {
    expect(APP).not.toContain('async function loadDailyLog(')
  })

  it('app.js does NOT contain renderMemories function body', () => {
    expect(APP).not.toContain('function renderMemories(')
  })

  it('app.js does NOT contain loadMemoryGraph function body', () => {
    expect(APP).not.toContain('async function loadMemoryGraph(')
  })

  it('app.js does NOT contain graphNodes state variable declaration', () => {
    expect(APP).not.toContain('let graphNodes = []')
  })

  it('app.js still calls loadMemAgents from init section', () => {
    expect(APP).toContain('loadMemAgents()')
  })

  it('app.js still calls loadMemAgents/loadMemStats/loadMemories from switchPage', () => {
    expect(APP).toContain("loadMemAgents(); loadMemStats(); loadMemories()")
  })
})

describe('memories-module: index.html loading order (init-time constraint)', () => {
  it('loads app-memories.js as a script tag', () => {
    expect(HTML).toContain('src="/app-memories.js"')
  })

  it('loads app-memories.js BEFORE app.js (init-time constraint)', () => {
    const memIdx = HTML.indexOf('src="/app-memories.js"')
    const appIdx = HTML.indexOf('src="/app.js"')
    expect(memIdx).toBeGreaterThan(0)
    expect(appIdx).toBeGreaterThan(0)
    expect(memIdx).toBeLessThan(appIdx)
  })

  it('still loads app-conversation.js after app.js', () => {
    const appIdx  = HTML.indexOf('src="/app.js"')
    const convIdx = HTML.indexOf('src="/app-conversation.js"')
    expect(convIdx).toBeGreaterThan(appIdx)
  })

  it('still loads app-local-llm.js after app.js', () => {
    const appIdx = HTML.indexOf('src="/app.js"')
    const llmIdx = HTML.indexOf('src="/app-local-llm.js"')
    expect(llmIdx).toBeGreaterThan(appIdx)
  })

  it('fork-updates.js remains last', () => {
    const llmIdx  = HTML.indexOf('src="/app-local-llm.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(forkIdx).toBeGreaterThan(llmIdx)
  })
})
