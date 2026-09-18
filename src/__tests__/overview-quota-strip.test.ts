// Card c6d8d599 (upstream e30161ac): port renderQuotaStrip/formatDurationShort/quotaLevelClass +
// the loadOverview() wiring + the HTML container + CSS + i18n keys into the fork's overview page.
//
// The backend half (readQuotaSnapshot -> /api/overview's `quota` field) already shipped on an
// earlier, unrelated card -- confirmed by reading src/web/quota.ts and src/web/routes/overview.ts
// directly rather than trusting the card text, which is what caught that the card's OTHER claim
// ("the 10 i18n keys already exist, zero collision") was false: none of the nine keys this widget
// needs existed in web/lang/{en,hu}.js before this change, and the upstream key `overview.quota.title`
// collides with the ALREADY-EXISTING "Claude Limit" gauge widget's title key -- reusing it here would
// have silently renamed that widget. Renamed to `overview.quota.strip_title` instead.
//
// These tests EXECUTE the real renderQuotaStrip/formatDurationShort/quotaLevelClass (extracted from
// the shipped web/app-overview.js the same way llmdist-lane-packing.test.ts extracts its packer),
// against a minimal hand-rolled DOM stub -- not jsdom, just the handful of methods the function
// actually calls (getElementById/createElement/appendChild + hidden/className/innerHTML/textContent).
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'app-overview.js'), 'utf8')
const HTML = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
const CSS = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')

function extract(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`missing function ${name}`)
  let depth = 0
  let i = SRC.indexOf('{', start)
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') { depth--; if (depth === 0) break }
  }
  return SRC.slice(start, i + 1)
}

class FakeEl {
  tag: string
  className = ''
  hidden = false
  textContent = ''
  innerHTML = ''
  children: FakeEl[] = []
  constructor(tag: string) { this.tag = tag }
  appendChild(c: FakeEl) { this.children.push(c); return c }
}

function makeDom(ids: string[]) {
  const registry = new Map<string, FakeEl>()
  for (const id of ids) registry.set(id, new FakeEl('div'))
  const document = {
    getElementById: (id: string) => registry.get(id) ?? null,
    createElement: (tag: string) => new FakeEl(tag),
  }
  return { document, els: registry }
}

/** Records key+params rather than translating, so assertions can pin exactly which i18n call fired. */
function fakeT(key: string, params?: Record<string, unknown>): string {
  return params ? `${key}|${JSON.stringify(params)}` : key
}
function fakeEscapeHtml(s: string): string { return s }
function fakeFormatRelative(ts: number): string { return `rel(${Date.now() - ts})` }

let formatDurationShort: (sec: number) => string
let quotaLevelClass: (pct: number) => string
let renderQuotaStrip: (q: unknown) => void

beforeAll(() => {
  const body = `${extract('formatDurationShort')}\n${extract('quotaLevelClass')}\n${extract('renderQuotaStrip')}\n` +
    'return { formatDurationShort, quotaLevelClass, renderQuotaStrip }'
  const factory = new Function('document', 't', 'escapeHtml', 'formatRelative', body) as (
    document: unknown, t: unknown, escapeHtml: unknown, formatRelative: unknown,
  ) => { formatDurationShort: typeof formatDurationShort; quotaLevelClass: typeof quotaLevelClass; renderQuotaStrip: typeof renderQuotaStrip }
  const dom = makeDom(['quotaStrip', 'quotaBars', 'quotaStripNote', 'quotaStripAge'])
  const out = factory(dom.document, fakeT, fakeEscapeHtml, fakeFormatRelative)
  formatDurationShort = out.formatDurationShort
  quotaLevelClass = out.quotaLevelClass
  renderQuotaStrip = out.renderQuotaStrip
})

describe('quotaLevelClass matches the status line thresholds (>=80 danger, >=60 warn)', () => {
  it.each([
    [0, ''], [59, ''], [60, 'warn'], [79, 'warn'], [80, 'danger'], [100, 'danger'],
  ])('%i%% -> %s', (pct, expected) => {
    expect(quotaLevelClass(pct)).toBe(expected)
  })
})

describe('formatDurationShort reuses formatRelative\'s own abbreviation keys', () => {
  it('under a minute rounds up to 1 minute, never 0', () => {
    expect(formatDurationShort(30)).toBe('common.time.min_abbr|{"n":1}')
  })
  it('minutes stay minutes under an hour', () => {
    expect(formatDurationShort(90)).toBe('common.time.min_abbr|{"n":1}')
    expect(formatDurationShort(59 * 60)).toBe('common.time.min_abbr|{"n":59}')
  })
  it('hours stay hours under a day', () => {
    expect(formatDurationShort(3 * 3600)).toBe('common.time.hour_abbr|{"h":3}')
  })
  it('a day or more uses the day abbreviation', () => {
    expect(formatDurationShort(2 * 86400)).toBe('common.time.day_abbr|{"n":2}')
  })
})

describe('renderQuotaStrip: missing snapshot', () => {
  it('shows the strip with a reason-specific note, converting dashes to underscores for the key', () => {
    const dom = makeDom(['quotaStrip', 'quotaBars', 'quotaStripNote', 'quotaStripAge'])
    const { renderQuotaStrip: render } = new Function('document', 't', 'escapeHtml', 'formatRelative',
      `${extract('formatDurationShort')}\n${extract('quotaLevelClass')}\n${extract('renderQuotaStrip')}\nreturn { renderQuotaStrip }`,
    )(dom.document, fakeT, fakeEscapeHtml, fakeFormatRelative)
    render({ status: 'missing', reason: 'no-rate-limits' })
    const strip = dom.els.get('quotaStrip')!
    const note = dom.els.get('quotaStripNote')!
    expect(strip.hidden).toBe(false)
    expect(note.hidden).toBe(false)
    expect(note.textContent).toBe('overview.quota.none.no_rate_limits')
  })

  it('null input renders the no-file reason', () => {
    const dom = makeDom(['quotaStrip', 'quotaBars', 'quotaStripNote', 'quotaStripAge'])
    const { renderQuotaStrip: render } = new Function('document', 't', 'escapeHtml', 'formatRelative',
      `${extract('formatDurationShort')}\n${extract('quotaLevelClass')}\n${extract('renderQuotaStrip')}\nreturn { renderQuotaStrip }`,
    )(dom.document, fakeT, fakeEscapeHtml, fakeFormatRelative)
    render(null)
    expect(dom.els.get('quotaStripNote')!.textContent).toBe('overview.quota.none.no_file')
  })
})

describe('renderQuotaStrip: healthy snapshot', () => {
  it('renders one bar per present window, with the correct pct and level class', () => {
    const dom = makeDom(['quotaStrip', 'quotaBars', 'quotaStripNote', 'quotaStripAge'])
    const { renderQuotaStrip: render } = new Function('document', 't', 'escapeHtml', 'formatRelative',
      `${extract('formatDurationShort')}\n${extract('quotaLevelClass')}\n${extract('renderQuotaStrip')}\nreturn { renderQuotaStrip }`,
    )(dom.document, fakeT, fakeEscapeHtml, fakeFormatRelative)
    const nowSec = Math.floor(Date.now() / 1000)
    render({
      status: 'ok',
      ageSec: 120,
      fiveHour: { usedPercentage: 85, resetsAt: nowSec + 3600, expired: false },
      sevenDay: { usedPercentage: 40, resetsAt: null, expired: false },
    })
    const bars = dom.els.get('quotaBars')!
    expect(bars.children).toHaveLength(2)
    expect(bars.children[0]!.className).toBe('quota-bar')
    expect(bars.children[0]!.innerHTML).toContain('danger')
    expect(bars.children[0]!.innerHTML).toContain('85%')
    expect(bars.children[1]!.innerHTML).toContain('40%')
    expect(bars.children[1]!.innerHTML).not.toContain('danger')
    expect(bars.children[1]!.innerHTML).not.toContain('warn')
    expect(dom.els.get('quotaStripAge')!.textContent).toContain('overview.quota.measured')
    expect(dom.els.get('quotaStripNote')!.hidden).toBe(true)
  })

  it('an expired window is muted and shows the expired tail, not the countdown', () => {
    const dom = makeDom(['quotaStrip', 'quotaBars', 'quotaStripNote', 'quotaStripAge'])
    const { renderQuotaStrip: render } = new Function('document', 't', 'escapeHtml', 'formatRelative',
      `${extract('formatDurationShort')}\n${extract('quotaLevelClass')}\n${extract('renderQuotaStrip')}\nreturn { renderQuotaStrip }`,
    )(dom.document, fakeT, fakeEscapeHtml, fakeFormatRelative)
    render({
      status: 'ok',
      ageSec: 60,
      fiveHour: { usedPercentage: 99, resetsAt: Math.floor(Date.now() / 1000) - 10, expired: true },
      sevenDay: null,
    })
    const bars = dom.els.get('quotaBars')!
    expect(bars.children).toHaveLength(1)
    expect(bars.children[0]!.className).toBe('quota-bar muted')
    expect(bars.children[0]!.innerHTML).toContain('overview.quota.expired')
    expect(bars.children[0]!.innerHTML).not.toContain('danger')
  })

  it('a stale snapshot mutes every bar and shows the stale note, even though numbers are healthy', () => {
    const dom = makeDom(['quotaStrip', 'quotaBars', 'quotaStripNote', 'quotaStripAge'])
    const { renderQuotaStrip: render } = new Function('document', 't', 'escapeHtml', 'formatRelative',
      `${extract('formatDurationShort')}\n${extract('quotaLevelClass')}\n${extract('renderQuotaStrip')}\nreturn { renderQuotaStrip }`,
    )(dom.document, fakeT, fakeEscapeHtml, fakeFormatRelative)
    render({
      status: 'stale',
      ageSec: 999999,
      fiveHour: { usedPercentage: 10, resetsAt: null, expired: false },
      sevenDay: null,
    })
    const bars = dom.els.get('quotaBars')!
    expect(bars.children[0]!.className).toBe('quota-bar muted')
    const note = dom.els.get('quotaStripNote')!
    expect(note.hidden).toBe(false)
    expect(note.className).toBe('quota-strip-note warn')
    expect(note.textContent).toBe('overview.quota.stale')
  })
})

describe('loadOverview() actually calls the renderer (not just defines it)', () => {
  it('renderQuotaStrip(d.quota) is called after the stat cards are populated, inside loadOverview', () => {
    const loadStart = SRC.indexOf('async function loadOverview(')
    const callIdx = SRC.indexOf('renderQuotaStrip(d.quota)', loadStart)
    const statSkillsIdx = SRC.indexOf("statSkillsSub", loadStart)
    expect(loadStart).toBeGreaterThan(-1)
    expect(callIdx).toBeGreaterThan(loadStart)
    expect(callIdx).toBeGreaterThan(statSkillsIdx)
  })
})

describe('HTML wiring', () => {
  it('the quota-strip container and its four child ids are in index.html, inside overviewPage', () => {
    const pageStart = HTML.indexOf('id="overviewPage"')
    const stripIdx = HTML.indexOf('id="quotaStrip"', pageStart)
    expect(pageStart).toBeGreaterThan(-1)
    expect(stripIdx).toBeGreaterThan(pageStart)
    const block = HTML.slice(stripIdx, HTML.indexOf('</div>', HTML.indexOf('quotaStripNote', stripIdx)))
    expect(block).toContain('id="quotaBars"')
    expect(block).toContain('id="quotaStripNote"')
    expect(block).toContain('id="quotaStripAge"')
  })

  it('does NOT reuse overview.quota.title -- that key already names the separate Claude-Limit gauge', () => {
    const stripIdx = HTML.indexOf('id="quotaStrip"')
    const block = HTML.slice(stripIdx, stripIdx + 400)
    expect(block).toContain('overview.quota.strip_title')
    expect(block).not.toContain('data-i18n="overview.quota.title"')
  })

  it('the pre-existing Claude-Limit gauge still owns overview.quota.title, untouched', () => {
    expect(HTML).toContain('data-i18n="overview.quota.title"')
  })
})

describe('CSS wiring', () => {
  it.each(['.quota-strip', '.quota-strip-head', '.quota-bars', '.quota-bar', '.quota-bar-track', '.quota-bar-fill', '.quota-strip-note'])(
    'rule %s exists',
    (sel) => { expect(CSS).toContain(sel + ' {') },
  )
})

describe('i18n: both locales carry every key the widget calls t() with', () => {
  const keys = [
    'overview.quota.strip_title', 'overview.quota.five_hour', 'overview.quota.seven_day',
    'overview.quota.resets_in', 'overview.quota.expired', 'overview.quota.measured',
    'overview.quota.stale', 'overview.quota.none.no_file', 'overview.quota.none.unreadable',
    'overview.quota.none.no_rate_limits',
  ]
  it.each(keys)('en.js has %s', (k) => { expect(EN).toContain(`'${k}':`) })
  it.each(keys)('hu.js has %s', (k) => { expect(HU).toContain(`'${k}':`) })
})
