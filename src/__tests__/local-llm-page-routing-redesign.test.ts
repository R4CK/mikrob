import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Card e5fc1fb4 (Peti, Telegram 2026-09-06; pair-BE ecf38e5a). Four requirements on the Local LLM
// page: (1) every installed model with its switch, first thing after Status; (2) the task routing
// made visible -- which preset goes to which model and why, the always-online categories, the latest
// card-level verdicts; (3) the offload-aggressiveness slider stays; (4) coherent hooks into the
// EXISTING Overview model-distribution swimlane (d6ecb003), not a parallel one. Contract-first: the
// routing endpoint may be absent (404) and the page must say so, never guess. String-contract tests
// in the house idiom: read the sources, assert the fragments.

const WEB = join(__dirname, '..', '..', 'web')
const HTML = readFileSync(join(WEB, 'index.html'), 'utf8')
const JS = readFileSync(join(WEB, 'app-local-llm.js'), 'utf8')
const OVW = readFileSync(join(WEB, 'app-overview.js'), 'utf8')
const CSS = readFileSync(join(WEB, 'style.css'), 'utf8')
const HU = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')

const NEW_KEYS = [
  'localLlm.routing.title',
  'localLlm.routing.desc',
  'localLlm.routing.summary',
  'localLlm.routing.endpoint_missing',
  'localLlm.routing.endpoint_missing_short',
  'localLlm.routing.endpoint_error',
  'localLlm.routing.route_default',
  'localLlm.routing.route_override',
  'localLlm.routing.route_unknown',
  'localLlm.routing.route_online_now',
  'localLlm.routing.always_online_title',
  'localLlm.routing.ceiling_never',
  'localLlm.routing.ceiling_upto',
  'localLlm.routing.decisions_title',
  'localLlm.routing.decisions_empty',
  'localLlm.routing.decisions_unavailable',
  'localLlm.routing.verdict_local',
  'localLlm.routing.verdict_online',
  'localLlm.models.summary',
  'localLlm.models.summary_offline',
  'localLlm.models.route_default',
  'localLlm.models.route_presets',
  'overview.llmDist.lane_disabled',
  'overview.llmDist.lane_open',
  'overview.llmDist.tooltip.routing',
  'overview.llmDist.tooltip.routing_override',
  'overview.llmDist.tooltip.routing_default',
]

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  expect(a, from).toBeGreaterThan(-1)
  expect(b, to).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('Local LLM page layout (card e5fc1fb4)', () => {
  // The LLM monitor page sits BEFORE this one in index.html, so the slice ends inside the last
  // section of the Local LLM page (the recommendations block), not at the next page.
  const page = slice(HTML, 'id="localLlmPage"', 'id="llmRecsStaleBanner"')
  const order = ['localLlm.status.title', 'localLlm.models.title', 'localLlm.offload.title', 'localLlm.routing.title', 'localLlm.usage.title', 'localLlm.rec.title']

  it('sections come in the order Status, Models, Offload, Routing, Usage, Recommended', () => {
    const idx = order.map((k) => page.indexOf(`data-i18n="${k}"`))
    idx.forEach((i, n) => expect(i, order[n]).toBeGreaterThan(-1))
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })

  it('the former Kategóriák section is gone as a heading, its list and message ids live on inside the routing section', () => {
    expect(page).not.toContain('data-i18n="localLlm.categories.title"')
    const routing = slice(page, 'id="llmRoutingSection"', 'data-i18n="localLlm.usage.title"')
    expect(routing).toContain('id="llmCategoriesList"')
    expect(routing).toContain('id="llmCategoriesMsg"')
    expect(routing).toContain('id="llmRoutingSummary"')
    expect(routing).toContain('id="llmRoutingAlwaysOnline"')
    expect(routing).toContain('id="llmRoutingDecisions"')
  })

  it('(3) the aggressiveness slider, its optimum button and the ramp block are still on the page', () => {
    expect(page).toContain('id="llmOffloadSlider"')
    expect(page).toContain('id="llmOffloadOptimalBtn"')
    expect(page).toContain('id="llmOffloadRamp"')
    expect(page).toContain('id="llmOffloadDifficulty"')
  })

  it('(1) the models block carries a summary line and keeps the pull row', () => {
    const models = slice(page, 'data-i18n="localLlm.models.title"', 'data-i18n="localLlm.offload.title"')
    expect(models).toContain('id="llmModelsSummary"')
    expect(models).toContain('id="llmModels"')
    expect(models).toContain('id="llmPullBtn"')
  })
})

describe('routing data: loaded contract-first, absence is said out loud (rule 12)', () => {
  const loader = slice(JS, 'async function llmLoadRouting()', 'function llmShortModelName(')

  it('fetches GET /api/local-llm/routing and keeps a three-state flag: ok / absent (404) / error', () => {
    expect(loader).toContain("fetch('/api/local-llm/routing')")
    expect(loader).toContain("if (res.status === 404) { _llmRouting = null; _llmRoutingState = 'absent'; return null }")
    expect(loader).toContain("_llmRoutingState = 'error'")
    expect(loader).toContain("_llmRoutingState = 'ok'")
  })

  it('reads every contract field defensively (defaultModel, overrides, alwaysOnline, presets, recentDecisions, decisionsLogAvailable)', () => {
    for (const f of ['defaultModel', 'overrides', 'alwaysOnline', 'presets', 'recentDecisions', 'decisionsLogAvailable']) expect(loader).toContain(f)
  })

  it('the summary names the endpoint-missing key when absent and the BE card in that text', () => {
    const fn = slice(JS, 'function llmRoutingSummaryHtml(', 'function llmRoutingAlwaysOnlineHtml(')
    expect(fn).toContain("'localLlm.routing.endpoint_missing'")
    expect(fn).toContain("'localLlm.routing.endpoint_error'")
    expect(HU).toMatch(/'localLlm\.routing\.endpoint_missing': '[^']*ecf38e5a/)
  })

  it('routing is loaded BEFORE the first status render so model rows can wear their chips', () => {
    const load = slice(JS, 'async function loadLocalLlm() {', 'llmSetupOffload()')
    expect(load.indexOf('await llmLoadRouting()')).toBeGreaterThan(-1)
    expect(load.indexOf('await llmLoadRouting()')).toBeLessThan(load.indexOf('await llmRefreshStatus()'))
  })
})

describe('(2) the preset table: switch + routed model + why', () => {
  const fn = slice(JS, 'async function llmRefreshCategories() {', 'async function llmToggleCategory(')

  it('joins categories with the routing answer and the offload config in one refresh', () => {
    expect(fn).toContain("fetch('/api/local-llm/categories')")
    expect(fn).toContain('llmLoadRouting()')
    expect(fn).toContain("fetch('/api/local-llm/offload-config')")
  })

  it('every preset row keeps the real switch (POST /api/local-llm/categories) and the info tooltip', () => {
    expect(fn).toContain("llmToggleCategory(btn.dataset.task, btn.dataset.enabled !== '1')")
    expect(fn).toContain('class="llm-category-toggle')
    expect(fn).toContain("t('localLlm.categories.infoAria', { task: c.name })")
  })

  it('a routed preset shows the model with its source (override/default); without routing data it says unknown, never a guess', () => {
    expect(fn).toContain('const route = llmRouteForTask(c.name)')
    expect(fn).toContain("llm-category-route--${route.source}")
    expect(fn).toContain("'localLlm.routing.route_override' : 'localLlm.routing.route_default'")
    expect(fn).toContain("t('localLlm.routing.route_unknown')")
    expect(fn).toContain("t('localLlm.routing.route_online_now')")
  })

  it('llmRouteForTask prefers the override table and falls back to the default model, null when no data', () => {
    const r = slice(JS, 'function llmRouteForTask(task) {', 'function llmPresetsRoutedTo(')
    expect(r).toContain('if (!_llmRouting) return null')
    expect(r).toContain("return { model: o, source: 'override' }")
    expect(r).toContain("source: 'default'")
  })

  it('always-online and decisions panels render from the contract, with speaking empties', () => {
    const a = slice(JS, 'function llmRoutingAlwaysOnlineHtml()', 'function llmRoutingDecisionsHtml()')
    expect(a).toContain("ceiling === 'never' ? t('localLlm.routing.ceiling_never') : t('localLlm.routing.ceiling_upto'")
    const d = slice(JS, 'function llmRoutingDecisionsHtml()', '// Presets (formerly "Categories"')
    expect(d).toContain("if (!_llmRouting.decisionsLogAvailable) return `<div class=\"llm-empty\">${t('localLlm.routing.decisions_unavailable')}</div>`")
    expect(d).toContain("String(r.verdict).toUpperCase() !== 'LOCAL'")
    expect(d).toContain('llm-verdict--online')
    expect(d).toContain('llm-verdict--local')
  })
})

describe('(1) model rows: chips, summary and the highlight hook', () => {
  it('both the live rows and the Ollama-down fallback rows call the route chip', () => {
    expect(JS.match(/\$\{llmModelRouteChipHtml\(m\.name\)\}/g)?.length).toBe(2)
  })

  it('the chip is default / N presets / nothing, and nothing when routing data is absent', () => {
    const c = slice(JS, 'function llmModelRouteChipHtml(modelName) {', 'function llmRoutingSummaryHtml(')
    expect(c).toContain("if (!r) return ''")
    expect(c).toContain("t('localLlm.models.route_default')")
    expect(c).toContain("t('localLlm.models.route_presets', { n: r.presets.length })")
  })

  it('the summary counts installed vs disabled and says when the count is the offline fallback', () => {
    const s = slice(JS, 'function llmRenderModelsSummary(models, ollamaUp) {', 'function llmApplyModelHighlight()')
    expect(s).toContain("t(ollamaUp ? 'localLlm.models.summary' : 'localLlm.models.summary_offline', { installed: names.length, disabled })")
    // the disabled count is MEASURED from the flags, not a constant (live check caught `disabled = 0`)
    expect(s).toContain('const disabled = names.filter(n => llmModelDisabled(n)).length')
    expect(JS).toContain('llmRenderModelsSummary(d.ollama_up ? models : _llmModelList, d.ollama_up)')
  })

  it('the highlight hook consumes window._llmHighlightModel once and scrolls the row into view', () => {
    const h = slice(JS, 'function llmApplyModelHighlight()', 'async function llmRefreshStatus()')
    expect(h).toContain('window._llmHighlightModel = null')
    expect(h).toContain("row.classList.add('llm-model-row--highlight')")
    expect(h).toContain("row.scrollIntoView({ block: 'center', behavior: 'smooth' })")
  })
})

describe('(4) Overview swimlane (d6ecb003) hooks, no parallel swimlane', () => {
  it('the widget fetches the model flags and the routing answer alongside the buckets, tolerating absence', () => {
    const w = slice(OVW, 'async function loadLlmDistWidget()', 'wireQuotaThresholdControls')
    expect(w).toContain("fetch('/api/local-llm/models'")
    expect(w).toContain("fetch('/api/local-llm/routing'")
    expect(w).toContain('const disabledModels = new Set()')
    expect(w).toContain('ovwLlmDistRouting = routingRes && routingRes.ok ? await routingRes.json().catch(() => null) : null')
    expect(w).toContain('ovwLlmDistLanesHtml(models, rangeStartMs, rangeEndMs, zoom, d.rosterAvailable, disabledModels)')
  })

  it('a lane label is a button that opens the Local LLM page on that model, badged when disabled', () => {
    const l = slice(OVW, 'function ovwLlmDistLanesHtml(', 'function ovwLlmDistLegendHtml()')
    expect(l).toContain('const off = m.enabled === false || (disabledModels instanceof Set && disabledModels.has(m.model))')
    // a BUTTON, not a span: the live check caught a mutant that kept the classes on a <span>
    expect(l).toContain('<button type="button" class="ovw-llmdist-lane-label ovw-llmdist-lane-link')
    expect(l).toContain("t('overview.llmDist.lane_disabled')")
    expect(OVW).toContain("body.querySelectorAll('.ovw-llmdist-lane-link').forEach((b) => b.addEventListener('click', () => ovwLlmDistOpenModel(b.dataset.model)))")
    const open = slice(OVW, 'function ovwLlmDistOpenModel(name) {', 'function ovwLlmDistColorFor(')
    expect(open).toContain('window._llmHighlightModel = name')
    expect(open).toContain('.sb-link[data-page="localLlm"]')
  })

  it('the tooltip gains a routing row only when the routing answer is present', () => {
    const r = slice(OVW, 'function ovwLlmDistRoutingRowHtml(task) {', 'function ovwLlmDistHideTooltip()')
    expect(r).toContain("if (!ovwLlmDistRouting) return ''")
    expect(r).toContain("t('overview.llmDist.tooltip.routing_override', { model: o })")
    expect(r).toContain("t('overview.llmDist.tooltip.routing_default'")
    expect(OVW).toContain('${ovwLlmDistRoutingRowHtml(task)}')
  })

  it('there is still exactly one model-distribution widget and one lanes renderer', () => {
    expect(OVW.match(/async function loadLlmDistWidget\(\)/g)?.length).toBe(1)
    expect(OVW.match(/function ovwLlmDistLanesHtml\(/g)?.length).toBe(1)
    expect(HTML.match(/id="ovwLlmDistCard"/g)?.length).toBe(1)
  })
})

describe('CSS (rule 13) and i18n parity', () => {
  it('routing panels are a two-column grid that stacks at 720px; the lane link keeps a 44px target on touch', () => {
    expect(CSS).toContain('.llm-routing-cols { display: grid; grid-template-columns: 1fr 1fr;')
    const mq = slice(CSS, '@media (max-width: 720px) {\n  .llm-routing-cols', '}')
    expect(mq).toContain('grid-template-columns: 1fr')
    expect(CSS).toContain('@media (pointer: coarse) {\n  .ovw-llmdist-lane-link { min-height: 44px; }')
    expect(CSS).toContain('.llm-model-row--highlight { animation: llm-row-flash')
  })

  for (const key of NEW_KEYS) {
    it(`hu.js and en.js both define ${key}`, () => {
      expect(HU).toContain(`'${key}':`)
      expect(EN).toContain(`'${key}':`)
    })
  }

  it('every localLlm.routing / models.summary / llmDist key referenced from the JS exists in hu.js', () => {
    const refs = new Set<string>()
    for (const src of [JS, OVW]) {
      for (const m of src.matchAll(/t\('((?:localLlm\.routing|localLlm\.models\.(?:summary|route)|overview\.llmDist\.(?:lane_|tooltip\.routing))[^']*)'/g)) refs.add(m[1] ?? '')
    }
    expect(refs.size).toBeGreaterThan(10)
    for (const k of refs) expect(HU, k).toContain(`'${k}':`)
  })
})
