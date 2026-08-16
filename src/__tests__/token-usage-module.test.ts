// String-contract guard for card 8d7550a8: app.js modularisation slice 4 -- Token Usage Monitor.
// Verifies structural correctness of the extraction:
//   - app-token-usage.js contains the key public functions and state vars
//   - app.js has the stub comment (NOT the original code)
//   - index.html loads app-token-usage.js AFTER app.js (post-init, like slices 1+2)
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-token-usage.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('token-usage-module: app-token-usage.js contains key public functions', () => {
  it('contains loadTokenUsage', () => {
    expect(MODULE).toContain('async function loadTokenUsage(')
  })

  it('contains renderTuSummary', () => {
    expect(MODULE).toContain('function renderTuSummary(')
  })

  it('contains renderTuTimeline', () => {
    expect(MODULE).toContain('function renderTuTimeline(')
  })

  it('contains renderTuBudgetCards', () => {
    expect(MODULE).toContain('function renderTuBudgetCards(')
  })

  it('contains renderTuModelDist', () => {
    expect(MODULE).toContain('function renderTuModelDist(')
  })

  it('contains renderTuToolStats', () => {
    expect(MODULE).toContain('function renderTuToolStats(')
  })

  it('contains tuPriceForModel', () => {
    expect(MODULE).toContain('function tuPriceForModel(')
  })

  it('contains tuCalcCostUSD', () => {
    expect(MODULE).toContain('function tuCalcCostUSD(')
  })

  it('contains tuFormatTokens', () => {
    expect(MODULE).toContain('function tuFormatTokens(')
  })

  it('contains tuMcpGroupKey', () => {
    expect(MODULE).toContain('function tuMcpGroupKey(')
  })

  it('contains header comment explaining loading order', () => {
    expect(MODULE).toContain('app-token-usage.js')
    expect(MODULE).toContain('AFTER')
  })

  it('contains state variables (tuSelectedAgent, tuChartState, tuBudgetView)', () => {
    expect(MODULE).toContain("let tuSelectedAgent = ''")
    expect(MODULE).toContain('let tuChartState = null')
    expect(MODULE).toContain("let tuBudgetView = ''")
  })

  it('contains detail/search state variables', () => {
    expect(MODULE).toContain('let tuDetailData = []')
    expect(MODULE).toContain('let tuDetailSort')
    expect(MODULE).toContain('let tuDetailSearch')
    expect(MODULE).toContain('let tuSearchTimer')
  })

  it('contains model distribution state', () => {
    expect(MODULE).toContain('let tuModelDistData = null')
  })

  it('contains tool stats state', () => {
    expect(MODULE).toContain('let tuToolStatsData = null')
  })

  it('contains TU_MODEL_PRICING table', () => {
    expect(MODULE).toContain('const TU_MODEL_PRICING = {')
    expect(MODULE).toContain("'claude-sonnet-5'")
    expect(MODULE).toContain("'claude-opus-5'")
  })
})

describe('token-usage-module: app.js has stub, NOT original code', () => {
  it('app.js has stub comment for the token usage section', () => {
    expect(APP).toContain('app-token-usage.js')
    expect(APP).toContain('modularisation')
    expect(APP).toContain('STUB')
  })

  it('app.js does NOT contain loadTokenUsage function body', () => {
    expect(APP).not.toContain('async function loadTokenUsage(')
  })

  it('app.js does NOT contain renderTuSummary function body', () => {
    expect(APP).not.toContain('function renderTuSummary(')
  })

  it('app.js does NOT contain renderTuTimeline function body', () => {
    expect(APP).not.toContain('function renderTuTimeline(')
  })

  it('app.js does NOT contain renderTuModelDist function body', () => {
    expect(APP).not.toContain('function renderTuModelDist(')
  })

  it('app.js does NOT contain renderTuToolStats function body', () => {
    expect(APP).not.toContain('function renderTuToolStats(')
  })

  it('app.js does NOT contain TU_MODEL_PRICING declaration', () => {
    expect(APP).not.toContain('const TU_MODEL_PRICING = {')
  })

  it('app.js does NOT contain tuSelectedAgent declaration', () => {
    expect(APP).not.toContain("let tuSelectedAgent = ''")
  })
})

describe('token-usage-module: index.html loading order (post-init constraint)', () => {
  it('loads app-token-usage.js as a script tag', () => {
    expect(HTML).toContain('src="/app-token-usage.js"')
  })

  it('loads app-token-usage.js AFTER app.js', () => {
    const tuIdx  = HTML.indexOf('src="/app-token-usage.js"')
    const appIdx = HTML.indexOf('src="/app.js"')
    expect(tuIdx).toBeGreaterThan(0)
    expect(appIdx).toBeGreaterThan(0)
    expect(tuIdx).toBeGreaterThan(appIdx)
  })

  it('loads app-token-usage.js AFTER app-local-llm.js', () => {
    const tuIdx  = HTML.indexOf('src="/app-token-usage.js"')
    const llmIdx = HTML.indexOf('src="/app-local-llm.js"')
    expect(tuIdx).toBeGreaterThan(llmIdx)
  })

  it('fork-updates.js remains after app-token-usage.js', () => {
    const tuIdx   = HTML.indexOf('src="/app-token-usage.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(forkIdx).toBeGreaterThan(tuIdx)
  })

  it('app-memories.js still loads BEFORE app.js', () => {
    const memIdx = HTML.indexOf('src="/app-memories.js"')
    const appIdx = HTML.indexOf('src="/app.js"')
    expect(memIdx).toBeLessThan(appIdx)
  })
})
