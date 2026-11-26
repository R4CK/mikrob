// String-contract guard for the "LLM today" Overview tile (card f1e33cfb, MikroB msg 22311).
// House idiom (see gemini-calls-widget.test.ts / local-llm-distribution-widget.test.ts): source
// files read as strings, asserted against short, formatting-proof fragments -- no DOM/runtime
// needed.
//
// Context: card f1e33cfb first moved the full GPU-spectrum canvas + model-distribution swimlane
// off Overview entirely onto the Live-load page. MikroB (msg 22311) asked for a slim Overview
// tile instead of a plain removal, matching the agreed phase structure (36dc9240 comment 34489):
// one compact tile with GPU busy/idle + VRAM, today's local call count, and a detail link --
// built to be upgraded with the real chain numbers once R1 (954a6a93, /api/llm/chain) lands.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { langHasKey } from './helpers/lang-overlay-key.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_OVERVIEW = readFileSync(join(__dirname, '../../web/app-overview.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')

function fnBody(source: string, startMarker: string, maxLen = 4000): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nasync function ', start + startMarker.length)
  const nextSyncFn = source.indexOf('\nfunction ', start + startMarker.length)
  const candidates = [nextFn, nextSyncFn].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + maxLen
  return source.slice(start, end)
}

describe('LLM today tile: loader (loadLlmTodayTile)', () => {
  const FN = 'async function loadLlmTodayTile('

  it('function is defined in app-overview.js', () => {
    expect(APP_OVERVIEW).toContain(FN)
  })

  it('fetches both /api/local-llm/status and /api/local-llm/usage', () => {
    const body = fnBody(APP_OVERVIEW, FN)
    expect(body).toContain("fetch('/api/local-llm/status')")
    expect(body).toContain("fetch('/api/local-llm/usage')")
  })

  it('shows an honest no-GPU state instead of fabricating a reading', () => {
    const body = fnBody(APP_OVERVIEW, FN)
    expect(body).toContain('if (!gpu)')
    expect(body).toContain("t('overview.llmToday.no_gpu')")
  })

  it('derives busy/idle from util_pct (>= 10%), never guesses when it is missing', () => {
    const body = fnBody(APP_OVERVIEW, FN)
    expect(body).toContain("typeof gpu.util_pct === 'number'")
    expect(body).toContain('gpu.util_pct >= 10')
    expect(body).toContain("busy ? 'overview.llmToday.gpu_busy' : 'overview.llmToday.gpu_idle'")
  })

  it('renders VRAM as used/total only when both numbers are present and total > 0', () => {
    const body = fnBody(APP_OVERVIEW, FN)
    expect(body).toContain("typeof gpu.mem_used_mb === 'number' && typeof gpu.mem_total_mb === 'number' && gpu.mem_total_mb > 0")
    expect(body).toContain('llmFmtVram(gpu.mem_used_mb)')
  })

  it("renders today's local call count from usage.today, defaulting to 0 (never undefined/NaN)", () => {
    const body = fnBody(APP_OVERVIEW, FN)
    expect(body).toContain("t('overview.llmToday.calls_today', { n: usage.today || 0 })")
  })

  it('never shows a raw error or a blank line on fetch failure (rule 12)', () => {
    const body = fnBody(APP_OVERVIEW, FN)
    expect(body).toContain("t('overview.llmToday.error')")
    expect(body).not.toMatch(/catch\s*\(\s*err\s*\)\s*\{[^}]*err\.message/)
  })

  it('is invoked from loadOverview()', () => {
    const loadOverviewBody = fnBody(APP_OVERVIEW, 'async function loadOverview(', 3000)
    expect(loadOverviewBody).toContain('loadLlmTodayTile()')
  })

  it('wires the detail link to switchPage, same pattern as the gemini/cost widgets', () => {
    expect(APP_OVERVIEW).toContain('wireLlmTodayDetailLink')
    expect(APP_OVERVIEW).toContain('.ovw-llmtoday-detail-link[data-page]')
  })
})

describe('LLM today tile: HTML', () => {
  it('the tile exists on the Overview page with gpu/calls/footer elements', () => {
    expect(HTML).toContain('id="ovwLlmTodayCard"')
    expect(HTML).toContain('id="ovwLlmTodayGpu"')
    expect(HTML).toContain('id="ovwLlmTodayCalls"')
  })

  it('the detail link points at the Live-load page (pageId llmMonitor)', () => {
    const idx = HTML.indexOf('ovw-llmtoday-detail-link')
    const tag = HTML.slice(HTML.lastIndexOf('<a', idx), HTML.indexOf('>', idx) + 1)
    expect(tag).toContain('data-page="llmMonitor"')
  })

  it('is NOT hidden by default (unlike the gemini/cost tiles, which wait on a not-yet-landed endpoint)', () => {
    const idx = HTML.indexOf('id="ovwLlmTodayCard"')
    const tag = HTML.slice(HTML.lastIndexOf('<div', idx), HTML.indexOf('>', idx) + 1)
    expect(tag).not.toContain('hidden')
  })

  it('the full GPU-spectrum canvas and model-distribution swimlane are NOT duplicated on Overview -- exactly one instance each, both inside llmMonitorPage', () => {
    expect(HTML.match(/id="ovwSpectrumCard"/g)?.length).toBe(1)
    expect(HTML.match(/id="ovwLlmDistCard"/g)?.length).toBe(1)
    const monPageIdx = HTML.indexOf('id="llmMonitorPage"')
    const overviewPageIdx = HTML.indexOf('id="overviewPage"')
    const spectrumIdx = HTML.indexOf('id="ovwSpectrumCard"')
    const distIdx = HTML.indexOf('id="ovwLlmDistCard"')
    expect(overviewPageIdx).toBeGreaterThan(-1)
    expect(monPageIdx).toBeGreaterThan(overviewPageIdx)
    expect(spectrumIdx).toBeGreaterThan(monPageIdx)
    expect(distIdx).toBeGreaterThan(monPageIdx)
  })
})

describe('LLM today tile: CSS and i18n', () => {
  it('defines the tile layout classes', () => {
    expect(CSS).toContain('.ovw-llmtoday-card')
    expect(CSS).toContain('.ovw-llmtoday-body')
    expect(CSS).toContain('.ovw-llmtoday-footer')
    expect(CSS).toContain('.ovw-llmtoday-detail-link')
  })

  for (const key of [
    'overview.llmToday.title',
    'overview.llmToday.detail_link',
    'overview.llmToday.gpu_busy',
    'overview.llmToday.gpu_idle',
    'overview.llmToday.gpu_line',
    'overview.llmToday.no_gpu',
    'overview.llmToday.calls_today',
    'overview.llmToday.error',
  ]) {
    it(`hu.js and en.js both define ${key}`, () => {
      expect(langHasKey('hu', key)).toBe(true)
      expect(langHasKey('en', key)).toBe(true)
    })
  }

  it('every overview.llmToday.* key referenced from app-overview.js exists in both lang files', () => {
    // Broad match (not just direct t('...') calls): gpu_busy/gpu_idle appear inside a ternary
    // whose result is passed to t() via a variable, not as a literal t('...') argument.
    const refs = new Set<string>()
    for (const m of APP_OVERVIEW.matchAll(/'(overview\.llmToday\.[a-zA-Z_]+)'/g)) refs.add(m[1] ?? '')
    expect(refs.size).toBeGreaterThan(5)
    for (const k of refs) {
      expect(langHasKey('hu', k), k).toBe(true)
      expect(langHasKey('en', k), k).toBe(true)
    }
  })
})
