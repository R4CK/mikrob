// String-contract guard for card 01b51197: token-cost overview widget.
// House idiom: source files read as strings, asserted against short,
// formatting-proof fragments -- no DOM/runtime needed.
//
// Key contracts:
//   - GET /api/costops/estimates fetched with Bearer token
//   - 404 response hides the card (graceful fallback, pair-BE d2cfa818 not yet landed)
//   - Empty estimates array renders .ovw-cost-empty
//   - Error renders .ovw-cost-error
//   - Per-agent rows: proportional bar (width%), USD, token counts
//   - Total rendered in footer; footer hidden by default
//   - "Details" link navigates to costs page (flow-connectivity, rule 9)
//   - i18n parity: all overview.cost.* keys in both hu.js and en.js
//   - CSS: all .ovw-cost-* classes present, [hidden] overrides, responsive breakpoint
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

function fnBody(source: string, startMarker: string, maxLen = 5000): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nasync function ', start + startMarker.length)
  const nextSyncFn = source.indexOf('\nfunction ', start + startMarker.length)
  const candidates = [nextFn, nextSyncFn].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + maxLen
  return source.slice(start, end)
}

const WIDGET_FN = 'async function loadCostEstimatesWidget('

describe('cost-estimates-widget: loadCostEstimatesWidget function', () => {
  it('function is defined in app.js', () => {
    expect(APP).toContain(WIDGET_FN)
  })

  it('fetches /api/costops/estimates', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('/api/costops/estimates')
  })

  it('sends Authorization header with Bearer token', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('Authorization')
    expect(body).toContain('Bearer ')
  })

  it('hides the card on 404 (graceful fallback for missing BE)', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('r.status === 404')
    const i = body.indexOf('r.status === 404')
    const slice = body.slice(i, i + 80)
    expect(slice).toContain('card.hidden = true')
  })

  it('renders .ovw-cost-empty when estimates array is empty', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('ovw-cost-empty')
    expect(body).toContain("overview.cost.empty")
  })

  it('renders .ovw-cost-error on fetch error', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('ovw-cost-error')
    expect(body).toContain("overview.cost.error")
  })

  it('renders proportional bar width as percentage', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('ovw-cost-bar')
    expect(body).toContain('width:')
    expect(body).toContain('%')
  })

  it('renders USD amount per row', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('overview.cost.usd')
    expect(body).toContain('estimatedUsd')
  })

  it('renders token counts per row (in/out K)', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('overview.cost.row_tps')
    expect(body).toContain('inputK')
    expect(body).toContain('outputK')
  })

  it('shows total in footer and unhides footer', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('ovwCostTotal')
    expect(body).toContain('totalEstimatedUsd')
    expect(body).toContain('footer.hidden = false')
  })

  it('unhides card on successful render', () => {
    const body = fnBody(APP, WIDGET_FN)
    expect(body).toContain('card.hidden = false')
  })

  it('is called from loadOverview', () => {
    const loadBody = fnBody(APP, 'async function loadOverview(')
    expect(loadBody).toContain('loadCostEstimatesWidget()')
  })
})

describe('cost-estimates-widget: HTML', () => {
  it('widget card exists with id ovwCostCard and is hidden by default', () => {
    expect(HTML).toContain('id="ovwCostCard"')
    const idx = HTML.indexOf('id="ovwCostCard"')
    const tag = HTML.slice(idx - 30, idx + 100)
    expect(tag).toContain('hidden')
  })

  it('has ovwCostBody element for dynamic content', () => {
    expect(HTML).toContain('id="ovwCostBody"')
  })

  it('has footer with total label and total value elements', () => {
    expect(HTML).toContain('id="ovwCostFooter"')
    expect(HTML).toContain('id="ovwCostTotal"')
  })

  it('has detail link pointing to costs page inside the widget (flow-connectivity)', () => {
    // The widget card contains a "Details →" link with data-page="costs".
    // Anchor on the widget element first to avoid matching the sidebar nav link.
    const cardIdx = HTML.indexOf('id="ovwCostCard"')
    const cardSlice = HTML.slice(cardIdx, cardIdx + 1000)
    expect(cardSlice).toContain('data-page="costs"')
    expect(cardSlice).toContain('overview.cost.detail_link')
  })

  it('has disclaimer note element', () => {
    expect(HTML).toContain('id="ovwCostNote"')
  })

  it('card has overview-card class', () => {
    const idx = HTML.indexOf('id="ovwCostCard"')
    const tag = HTML.slice(idx - 50, idx + 60)
    expect(tag).toContain('overview-card')
  })
})

describe('cost-estimates-widget: CSS', () => {
  it('defines .ovw-cost-card', () => {
    expect(CSS).toContain('.ovw-cost-card')
  })

  it('defines hidden overrides for footer and note', () => {
    expect(CSS).toContain('.ovw-cost-footer[hidden]')
    expect(CSS).toContain('.ovw-cost-note[hidden]')
  })

  it('defines .ovw-cost-bar and .ovw-cost-bar-wrap for proportional display', () => {
    expect(CSS).toContain('.ovw-cost-bar-wrap')
    expect(CSS).toContain('.ovw-cost-bar')
  })

  it('defines .ovw-cost-row with flex layout', () => {
    const idx = CSS.indexOf('.ovw-cost-row {')
    expect(idx).toBeGreaterThan(-1)
    const slice = CSS.slice(idx, idx + 100)
    expect(slice).toContain('flex')
  })

  it('defines tabular-nums for amounts (column alignment)', () => {
    expect(CSS).toContain('tabular-nums')
  })

  it('has responsive breakpoint hiding token count on narrow screens', () => {
    const idx = CSS.indexOf('.ovw-cost-tps')
    const mediaIdx = CSS.indexOf('@media (max-width', idx)
    expect(mediaIdx).toBeGreaterThan(idx)
  })
})

describe('cost-estimates-widget: i18n parity', () => {
  const keys = [
    'overview.cost.title',
    'overview.cost.meta_today',
    'overview.cost.total',
    'overview.cost.detail_link',
    'overview.cost.empty',
    'overview.cost.error',
    'overview.cost.usd',
    'overview.cost.row_tps',
    'overview.cost.note_disclaimer',
  ]
  for (const key of keys) {
    it(`"${key}" exists in both hu.js and en.js`, () => {
      expect(HU).toContain(`'${key}'`)
      expect(EN).toContain(`'${key}'`)
    })
  }
})
