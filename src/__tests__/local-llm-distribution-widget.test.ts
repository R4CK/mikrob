// String-contract guard for card d6ecb003: local-LLM model-distribution swimlane on the
// Overview page (pair-BE 2ffc0a96, contract proposed in kanban comment 18874).
// House idiom: source files read as strings, asserted against short, formatting-proof
// fragments -- no DOM/runtime needed.
//
// Key contracts:
//   - GET /api/local-llm/model-usage-buckets?hours=6 fetched with Bearer token
//   - 404 response hides the card (graceful fallback, pair-BE 2ffc0a96 not yet landed)
//   - Empty models array renders .ovw-llmdist-empty (mechanism landed, no real traffic yet)
//   - Error renders .ovw-llmdist-error
//   - 5 KPI cards: active models, avg latency, tokens/sec, total requests, error rate
//   - Swimlane: one lane per model IN THE RESPONSE (backend already omits inactive models,
//     so the FE never renders an empty second lane), tasks positioned by real start/duration
//   - Task blocks are colored by task type and carry hover/focus tooltip data attributes
//   - Legend built from the same color map as the blocks
//   - i18n parity: all overview.llmDist.* keys in both hu.js and en.js
//   - CSS: card classes, KPI grid, lane/track/block classes, responsive breakpoint
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_CORE     = readFileSync(join(__dirname, '../../web/app.js'),          'utf-8')
const APP_OVERVIEW = readFileSync(join(__dirname, '../../web/app-overview.js'), 'utf-8')
const APP  = APP_CORE + '\n' + APP_OVERVIEW
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS  = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HU   = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN   = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

function fnBody(source: string, startMarker: string, maxLen = 6000): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nasync function ', start + startMarker.length)
  const nextSyncFn = source.indexOf('\nfunction ', start + startMarker.length)
  const nextConst = source.indexOf('\nconst ', start + startMarker.length)
  const candidates = [nextFn, nextSyncFn, nextConst].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + maxLen
  return source.slice(start, end)
}

const WIDGET_FN = 'async function loadLlmDistWidget('

describe('local-llm-distribution-widget: loadLlmDistWidget function', () => {
  it('function is defined in app-overview.js', () => {
    expect(APP).toContain(WIDGET_FN)
  })

  it('fetches /api/local-llm/model-usage-buckets with an hours param', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('/api/local-llm/model-usage-buckets?hours=')
  })

  it('sends Authorization header with Bearer token', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('Authorization')
    expect(body).toContain('Bearer ')
  })

  it('hides the card on 404 (graceful fallback for missing pair-BE 2ffc0a96)', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('r.status === 404')
    const i = body.indexOf('r.status === 404')
    const slice = body.slice(i, i + 80)
    expect(slice).toContain('card.hidden = true')
  })

  it('renders .ovw-llmdist-empty when models array is empty', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('ovw-llmdist-empty')
    expect(body).toContain('overview.llmDist.empty')
  })

  it('renders .ovw-llmdist-error on fetch error', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('ovw-llmdist-error')
    expect(body).toContain('overview.llmDist.error')
  })

  it('renders the KPI row via ovwLlmDistKpiHtml before checking for empty data', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('ovwLlmDistKpiHtml(d.kpi')
  })

  it('unhides card on successful render and on empty state', () => {
    const body = fnBody(APP, WIDGET_FN)
    const occurrences = body.split('card.hidden = false').length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })

  it('is called from loadOverview', () => {
    const loadBody = fnBody(APP, 'async function loadOverview(')
    expect(loadBody).toContain('loadLlmDistWidget()')
  })
})

describe('local-llm-distribution-widget: KPI cards', () => {
  it('ovwLlmDistKpiHtml renders all 5 required KPIs (design-ref)', () => {
    const body = fnBody(APP, 'function ovwLlmDistKpiHtml(')
    expect(body).toContain('active_models')
    expect(body).toContain('avg_latency')
    expect(body).toContain('tokens_per_sec')
    expect(body).toContain('total_requests')
    expect(body).toContain('error_rate')
  })

  it('reads kpi fields from the contract (activeModels, avgLatencyMs, tokensPerSec, totalRequests, errorRatePct)', () => {
    const body = fnBody(APP, 'function ovwLlmDistKpiHtml(')
    expect(body).toContain('kpi.activeModels')
    expect(body).toContain('kpi.avgLatencyMs')
    expect(body).toContain('kpi.tokensPerSec')
    expect(body).toContain('kpi.totalRequests')
    expect(body).toContain('kpi.errorRatePct')
  })
})

describe('local-llm-distribution-widget: swimlane rendering', () => {
  it('ovwLlmDistLanesHtml positions blocks by real start/duration, not by fixed buckets', () => {
    const body = fnBody(APP, 'function ovwLlmDistLanesHtml(')
    expect(body).toContain('task.startMs')
    expect(body).toContain('task.durationMs')
    expect(body).toContain('left:')
    expect(body).toContain('width:')
  })

  it('one lane rendered per entry in the models array (backend already filters inactive models)', () => {
    const body = fnBody(APP, 'function ovwLlmDistLanesHtml(')
    expect(body).toContain('models.map(')
    expect(body).toContain('ovw-llmdist-lane')
  })

  it('each task block carries agent (not "node"/"k8s", per Peti spec) and status in its dataset', () => {
    const body = fnBody(APP, 'function ovwLlmDistLanesHtml(')
    expect(body).toContain('data-agent=')
    expect(body).toContain('data-status=')
    expect(body).not.toMatch(/data-node=|k8s/i)
  })

  it('task blocks are colored per task type via ovwLlmDistColorFor', () => {
    const body = fnBody(APP, 'function ovwLlmDistLanesHtml(')
    expect(body).toContain('ovwLlmDistColorFor(task.task')
  })

  it('legend is built from the same color map used by the blocks', () => {
    const legendBody = fnBody(APP, 'function ovwLlmDistLegendHtml(')
    expect(legendBody).toContain('ovwLlmDistTaskColors')
    expect(legendBody).toContain('ovw-llmdist-legend-swatch')
  })
})

describe('local-llm-distribution-widget: tooltip (hover + keyboard focus)', () => {
  it('wires both mouse and focus events (keyboard-accessible, not hover-only)', () => {
    const body = fnBody(APP, 'function ovwLlmDistWireTooltips(')
    expect(body).toContain('mouseenter')
    expect(body).toContain('focus')
    expect(body).toContain('mouseleave')
    expect(body).toContain('blur')
  })

  it('tooltip shows duration, tokens in/out, throughput and status (design-ref fields)', () => {
    const body = fnBody(APP, 'function ovwLlmDistShowTooltip(')
    expect(body).toContain('overview.llmDist.tooltip.duration')
    expect(body).toContain('overview.llmDist.tooltip.tokens')
    expect(body).toContain('overview.llmDist.tooltip.throughput')
    expect(body).toContain('overview.llmDist.tooltip.status')
    expect(body).toContain('overview.llmDist.tooltip.agent')
  })

  it('task label text and tooltip fields go through escapeHtml', () => {
    const body = fnBody(APP, 'function ovwLlmDistShowTooltip(')
    expect(body).toContain('escapeHtml(task)')
    expect(body).toContain('escapeHtml(agent)')
  })
})

describe('local-llm-distribution-widget: HTML', () => {
  it('widget card exists with id ovwLlmDistCard and is hidden by default', () => {
    expect(HTML).toContain('id="ovwLlmDistCard"')
    const idx = HTML.indexOf('id="ovwLlmDistCard"')
    const tag = HTML.slice(idx - 50, idx + 100)
    expect(tag).toContain('hidden')
    expect(tag).toContain('overview-card')
  })

  it('has ovwLlmDistKpis and ovwLlmDistBody elements for dynamic content', () => {
    expect(HTML).toContain('id="ovwLlmDistKpis"')
    expect(HTML).toContain('id="ovwLlmDistBody"')
  })

  it('has a meta element for the window-hours label', () => {
    expect(HTML).toContain('id="ovwLlmDistMeta"')
  })

  it('sits directly below the existing load spectrum card (Peti: "ALATT")', () => {
    const spectrumIdx = HTML.indexOf('id="ovwSpectrumCard"')
    const distIdx = HTML.indexOf('id="ovwLlmDistCard"')
    const gridIdx = HTML.indexOf('class="overview-grid"')
    expect(spectrumIdx).toBeGreaterThan(-1)
    expect(distIdx).toBeGreaterThan(spectrumIdx)
    expect(gridIdx).toBeGreaterThan(distIdx)
  })
})

describe('local-llm-distribution-widget: CSS', () => {
  it('defines .ovw-llmdist-card and .ovw-llmdist-kpis grid', () => {
    expect(CSS).toContain('.ovw-llmdist-card')
    expect(CSS).toContain('.ovw-llmdist-kpis')
    const idx = CSS.indexOf('.ovw-llmdist-kpis {')
    expect(idx).toBeGreaterThan(-1)
    expect(CSS.slice(idx, idx + 150)).toContain('grid')
  })

  it('defines lane/track/block classes', () => {
    expect(CSS).toContain('.ovw-llmdist-lane')
    expect(CSS).toContain('.ovw-llmdist-lane-track')
    expect(CSS).toContain('.ovw-llmdist-block')
  })

  it('block hover/focus state uses focus-visible (keyboard-accessible)', () => {
    expect(CSS).toContain('.ovw-llmdist-block:focus-visible')
  })

  it('defines the tooltip element with [hidden] override', () => {
    expect(CSS).toContain('.ovw-llmdist-tooltip')
    expect(CSS).toContain('.ovw-llmdist-tooltip[hidden]')
  })

  it('uses tabular-nums for KPI values (column alignment)', () => {
    const idx = CSS.indexOf('.ovw-llmdist-kpi-value')
    expect(CSS.slice(idx, idx + 200)).toContain('tabular-nums')
  })

  it('has a responsive breakpoint for narrow screens', () => {
    const idx = CSS.indexOf('.ovw-llmdist-card')
    const mediaIdx = CSS.indexOf('@media (max-width', idx)
    expect(mediaIdx).toBeGreaterThan(idx)
    const mediaSlice = CSS.slice(mediaIdx, mediaIdx + 250)
    expect(mediaSlice).toContain('.ovw-llmdist-kpis')
  })
})

describe('local-llm-distribution-widget: i18n parity', () => {
  const keys = [
    'overview.llmDist.title',
    'overview.llmDist.meta',
    'overview.llmDist.empty',
    'overview.llmDist.error',
    'overview.llmDist.kpi.active_models',
    'overview.llmDist.kpi.avg_latency',
    'overview.llmDist.kpi.tokens_per_sec',
    'overview.llmDist.kpi.total_requests',
    'overview.llmDist.kpi.error_rate',
    'overview.llmDist.legend_title',
    'overview.llmDist.tooltip.agent',
    'overview.llmDist.tooltip.duration',
    'overview.llmDist.tooltip.tokens',
    'overview.llmDist.tooltip.tokens_value',
    'overview.llmDist.tooltip.throughput',
    'overview.llmDist.tooltip.status',
    'overview.llmDist.status.ok',
    'overview.llmDist.status.err',
    'overview.llmDist.status.busy',
    'overview.llmDist.ms',
    'overview.llmDist.sec',
    'overview.llmDist.tps',
  ]
  for (const key of keys) {
    it(`"${key}" exists in both hu.js and en.js`, () => {
      expect(HU).toContain(`'${key}'`)
      expect(EN).toContain(`'${key}'`)
    })
  }
})
