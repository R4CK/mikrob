// String-contract guard for card 57da740c: Gemini (agy) calls page + Overview tile
// (pair-BE 64788453, contract CONFIRMED by backend, inter-agent msg_id 11816 --
// src/web/routes/gemini-calls.ts tryHandleGeminiCalls).
// House idiom (see local-llm-distribution-widget.test.ts): source files read as strings,
// asserted against short, formatting-proof fragments -- no DOM/runtime needed.
//
// Key contracts:
//   - GET /api/gemini-calls fetched with Bearer token, both from the dedicated page
//     (loadGeminiCalls) and the Overview tile (loadGeminiOverviewTile)
//   - 404 hides the Overview tile (pair-BE 64788453 not yet landed) and renders an honest
//     "not available yet" status on the dedicated page -- never invented data
//   - summary.byModel/byTaskType are OBJECTS keyed by name ({[key]: {calls,ok,error,blocked}}),
//     with no avgScore/unrated field -- geminiSummaryEntries() derives both from the calls
//     array itself, so the backend cannot ship a summary table that disagrees with the log
//   - status is one of 'ok'|'error'|'blocked'|'timeout'|'started' (5 states, not a simple
//     ok/error binary) and rating.result is the backend's raw 'elfogadva'|'javitva'|'eldobva'
//     used directly as the i18n key suffix
//   - Dedicated page renders: quota bar, STOP-flag banner, summary-by-model table,
//     summary-by-taskType table, call-log table with 9 columns incl. rating
//   - An unrated call renders a distinct "unrated" marker, not a blank cell
//   - Nothing on the Overview page is removed: ovwCostCard and its footer/detail-link survive
//     alongside the new ovwGeminiCard (Peti 11285 -- "egyetlen elem sem tűnhet el")
//   - i18n parity: all geminiCalls.* and the two overview.gemini.* keys exist in both hu.js
//     and en.js
//   - CSS: page section classes, overview tile classes, responsive breakpoint
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCallRows, buildSummary, type RawRow } from '../web/routes/gemini-calls.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_GEMINI   = readFileSync(join(__dirname, '../../web/app-gemini-calls.js'), 'utf-8')
const APP_OVERVIEW = readFileSync(join(__dirname, '../../web/app-overview.js'), 'utf-8')
const APP_PAGESW   = readFileSync(join(__dirname, '../../web/app-page-switch.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS  = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HU   = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN   = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

function fnBody(source: string, startMarker: string, maxLen = 4000): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nasync function ', start + startMarker.length)
  const nextSyncFn = source.indexOf('\nfunction ', start + startMarker.length)
  const candidates = [nextFn, nextSyncFn].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + maxLen
  return source.slice(start, end)
}

describe('gemini-calls: dedicated page loader (loadGeminiCalls)', () => {
  const FN = 'async function loadGeminiCalls('

  it('function is defined in app-gemini-calls.js', () => {
    expect(APP_GEMINI).toContain(FN)
  })

  it('fetches /api/gemini-calls with a Bearer token', () => {
    const body = fnBody(APP_GEMINI, FN)
    expect(body).toContain("fetch('/api/gemini-calls'")
    expect(body).toContain('Authorization')
    expect(body).toContain('Bearer ')
  })

  it('renders an honest "not available" status on 404, never invented data', () => {
    const body = fnBody(APP_GEMINI, FN)
    expect(body).toContain('res.status === 404')
    expect(body).toContain('geminiCalls.not_available')
  })

  it('renders a load-error status on a non-ok, non-404 response', () => {
    const body = fnBody(APP_GEMINI, FN)
    expect(body).toContain('geminiCalls.load_error')
  })

  it('renders quota, stop banner, both summaries, and the call table', () => {
    const body = fnBody(APP_GEMINI, FN)
    expect(body).toContain('geminiRenderQuota(d.quota)')
    expect(body).toContain('geminiRenderStop(d.stop)')
    expect(body).toContain('geminiSummaryEntries(d.summary')
    expect(body).toContain('geminiRenderCallsTable(d.calls)')
  })
})

describe('gemini-calls: Overview tile loader (loadGeminiOverviewTile)', () => {
  const FN = 'async function loadGeminiOverviewTile('

  it('function is defined in app-gemini-calls.js', () => {
    expect(APP_GEMINI).toContain(FN)
  })

  it('fetches /api/gemini-calls with a Bearer token', () => {
    const body = fnBody(APP_GEMINI, FN)
    expect(body).toContain("fetch('/api/gemini-calls'")
    expect(body).toContain('Bearer ')
  })

  it('hides the card on 404 (pair-BE not landed yet), same convention as the cost widget', () => {
    const body = fnBody(APP_GEMINI, FN)
    expect(body).toContain('res.status === 404')
    expect(body).toContain('card.hidden = true')
  })

  it('is invoked from loadOverview() in app-overview.js', () => {
    const loadOverviewBody = fnBody(APP_OVERVIEW, 'async function loadOverview(', 3000)
    expect(loadOverviewBody).toContain('loadGeminiOverviewTile()')
  })

  it('wires the detail link to switchPage, same pattern as the cost widget', () => {
    expect(APP_OVERVIEW).toContain('wireGeminiDetailLink')
    expect(APP_OVERVIEW).toContain('.ovw-gemini-detail-link[data-page]')
  })
})

describe('gemini-calls: geminiSummaryEntries (real execution, not string-match)', () => {
  const body = fnBody(APP_GEMINI, 'function geminiSummaryEntries(')
  const geminiSummaryEntries = new Function(body + '\nreturn geminiSummaryEntries')() as (
    bucket: Record<string, { calls: number; ok: number; error: number; blocked: number }> | undefined,
    calls: Array<{ model?: string; taskType?: string; rating: { score: number } | null }>,
    field: 'model' | 'taskType',
  ) => Array<{ key: string; total: number; ok: number; avgScore: number | null; unrated: number }>

  it('derives avgScore and unrated from the calls array, not from the bucket', () => {
    const bucket = { 'gemini-3.8-flash-medium': { calls: 3, ok: 2, error: 1, blocked: 0 } }
    const calls = [
      { model: 'gemini-3.8-flash-medium', rating: { score: 8 } },
      { model: 'gemini-3.8-flash-medium', rating: { score: 4 } },
      { model: 'gemini-3.8-flash-medium', rating: null },
      { model: 'other-model', rating: { score: 10 } }, // must not leak into the row below
    ]
    const rows = geminiSummaryEntries(bucket, calls, 'model')
    expect(rows).toEqual([
      { key: 'gemini-3.8-flash-medium', total: 3, ok: 2, avgScore: 6, unrated: 1 },
    ])
  })

  it('avgScore is null when every call in the bucket is unrated, not 0 (0 is a valid score)', () => {
    const bucket = { code: { calls: 2, ok: 2, error: 0, blocked: 0 } }
    const calls = [
      { taskType: 'code', rating: null },
      { taskType: 'code', rating: null },
    ]
    const rows = geminiSummaryEntries(bucket, calls, 'taskType')
    expect(rows[0].avgScore).toBeNull()
    expect(rows[0].unrated).toBe(2)
  })

  it('returns an empty array for a missing/undefined bucket (summary not yet populated)', () => {
    expect(geminiSummaryEntries(undefined, [], 'model')).toEqual([])
  })
})

describe('gemini-calls: rating rendering', () => {
  it('shows a distinct unrated marker, not a blank cell, when rating is null', () => {
    const body = fnBody(APP_GEMINI, 'function geminiRatingHtml(')
    expect(body).toContain('if (!rating)')
    expect(body).toContain('gemini-unrated')
    expect(body).toContain('geminiCalls.rating.unrated')
  })

  it('renders result + numeric score + optional opinion when a rating exists', () => {
    const body = fnBody(APP_GEMINI, 'function geminiRatingHtml(')
    expect(body).toContain('rating.result')
    expect(body).toContain('rating.score')
    expect(body).toContain('rating.opinion')
  })
})

// WhiteHat2 F1 (MEDIUM, NO-GO on Gate-SHA ee85533e): stored XSS via rating.score. The ledger is a
// plain JSONL file any same-uid fleet process can write; geminiRatingHtml() used to interpolate
// rating.score straight into innerHTML with no escaping, so an HTML-shaped score string became a
// live DOM element in the dashboard origin. Fixed on both layers (defense-in-depth, not "trust
// the one upstream fix"): the backend now coerces to a finite number or null, and the FE
// independently coerces + escapes regardless of what the backend sends.
describe('gemini-calls: rating.score XSS regression (WhiteHat2 F1, card 57da740c)', () => {
  const XSS_PAYLOAD = '<img src=x onerror=alert(1)>'

  describe('backend: buildCallRows coerces a non-numeric pont to null', () => {
    const CALL_IDO = '2026-10-14T06:00:00.000Z'
    function rowsFor(pont: unknown): ReturnType<typeof buildCallRows> {
      const rows: RawRow[] = [
        { tipus: 'hivas', ido: CALL_IDO, seged: 'agy' },
        { tipus: 'ertekeles', hivas: CALL_IDO, eredmeny: 'elfogadva', pont: pont as unknown as number, velemeny: 'ok' },
      ]
      return buildCallRows(rows)
    }

    it('a malicious string pont becomes score: null, not the raw string', () => {
      const rows = rowsFor(XSS_PAYLOAD)
      expect(rows).toHaveLength(1)
      expect(rows[0].rating).not.toBeNull()
      expect(rows[0].rating!.score).toBeNull()
    })

    it('a genuine numeric pont still passes through unchanged', () => {
      const rows = rowsFor(8)
      expect(rows[0].rating!.score).toBe(8)
    })
  })

  describe('frontend: geminiRatingHtml never emits the raw payload', () => {
    const escapeHtml = (v: unknown) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const t = (key: string) => 'i18n:' + key
    const fnSrc = fnBody(APP_GEMINI, 'function geminiRatingHtml(')

    it('a malicious score string never reaches the output as a raw tag', () => {
      const call = (rating: unknown) =>
        new Function('escapeHtml', 't', 'rating', fnSrc + '\nreturn geminiRatingHtml(rating)')(escapeHtml, t, rating) as string
      const html = call({ result: 'elfogadva', score: XSS_PAYLOAD, opinion: 'ok' })
      expect(html).not.toContain('<img')
      expect(html).toContain('—') // non-numeric score falls back to the em-dash placeholder
    })

    it('a genuine numeric score still renders normally', () => {
      const call = (rating: unknown) =>
        new Function('escapeHtml', 't', 'rating', fnSrc + '\nreturn geminiRatingHtml(rating)')(escapeHtml, t, rating) as string
      const html = call({ result: 'elfogadva', score: 8, opinion: 'ok' })
      expect(html).toContain('8/10')
    })
  })
})

describe('gemini-calls: non-blocking hardening (card 13671607, WhiteHat2 findings on 57da740c)', () => {
  describe('N1: buildCallRows does not throw on a non-callable-toString pont', () => {
    const CALL_IDO = '2026-10-14T06:00:00.000Z'
    function rowsFor(pont: unknown): ReturnType<typeof buildCallRows> {
      const rows: RawRow[] = [
        { tipus: 'hivas', ido: CALL_IDO, seged: 'agy' },
        { tipus: 'ertekeles', hivas: CALL_IDO, eredmeny: 'elfogadva', pont: pont as unknown as number, velemeny: 'ok' },
      ]
      return buildCallRows(rows)
    }

    it('an object whose own toString is not a function does not throw -- score becomes null', () => {
      // Number({toString: 1}) throws TypeError: coerceScore must never call Number() on a
      // non-primitive, not just filter the result afterwards.
      expect(() => rowsFor({ toString: 1 })).not.toThrow()
      const rows = rowsFor({ toString: 1 })
      expect(rows[0].rating!.score).toBeNull()
    })

    it('a genuine numeric pont still passes through unchanged', () => {
      const rows = rowsFor(8)
      expect(rows[0].rating!.score).toBe(8)
    })
  })

  describe('N2: buildSummary does not pollute Object.prototype on a __proto__ model/taskType', () => {
    afterEach(() => {
      // Belt-and-suspenders: if a future regression reintroduces the pollution, fail loudly
      // instead of leaking corrupted state into every other test in this process.
      expect((Object.prototype as unknown as { calls?: unknown }).calls).toBeUndefined()
    })

    it('a __proto__ model key does not become reachable via Object.prototype', () => {
      const protoBefore = (Object.prototype as unknown as { calls?: unknown }).calls
      expect(protoBefore).toBeUndefined()

      const summary = buildSummary([{ model: '__proto__', taskType: 'x', status: 'ok' }])

      // Object.prototype itself must be untouched.
      expect((Object.prototype as unknown as { calls?: unknown }).calls).toBeUndefined()
      // The bucket is an OWN property on the returned plain object, not the object's prototype.
      expect(Object.prototype.hasOwnProperty.call(summary.byModel, '__proto__')).toBe(true)
      expect(summary.byModel['__proto__']).toEqual({ calls: 1, ok: 1, error: 0, blocked: 0 })
    })

    it('a __proto__ taskType key behaves the same way', () => {
      const summary = buildSummary([{ model: 'm', taskType: '__proto__', status: 'error' }])
      expect((Object.prototype as unknown as { ok?: unknown }).ok).toBeUndefined()
      expect(summary.byTaskType['__proto__']).toEqual({ calls: 1, ok: 0, error: 1, blocked: 0 })
    })

    it('ordinary keys still aggregate correctly across multiple calls', () => {
      const summary = buildSummary([
        { model: 'gemini-pro', taskType: 'code', status: 'ok' },
        { model: 'gemini-pro', taskType: 'code', status: 'error' },
        { model: 'gemini-pro', taskType: 'review', status: 'blocked' },
      ])
      expect(summary.byModel['gemini-pro']).toEqual({ calls: 3, ok: 1, error: 1, blocked: 1 })
      expect(summary.byTaskType['code']).toEqual({ calls: 2, ok: 1, error: 1, blocked: 0 })
      expect(summary.byTaskType['review']).toEqual({ calls: 1, ok: 0, error: 0, blocked: 1 })
    })
  })
})

describe('gemini-calls: HTML wiring', () => {
  it('sidebar nav has a geminiCalls link', () => {
    expect(HTML).toContain('data-page="geminiCalls"')
  })

  it('the dedicated page section exists with status + body regions', () => {
    expect(HTML).toContain('id="geminiCallsPage"')
    expect(HTML).toContain('id="geminiPageStatus"')
    expect(HTML).toContain('id="geminiPageBody"')
    expect(HTML).toContain('id="geminiStopBanner"')
    expect(HTML).toContain('id="geminiQuotaBarFill"')
    expect(HTML).toContain('id="geminiSummaryByModel"')
    expect(HTML).toContain('id="geminiSummaryByTaskType"')
    expect(HTML).toContain('id="geminiCallsTableWrap"')
  })

  it('switchPage calls loadGeminiCalls for the geminiCalls page', () => {
    expect(APP_PAGESW).toContain("pageId === 'geminiCalls'")
    expect(APP_PAGESW).toContain('loadGeminiCalls()')
  })

  it('the Overview tile markup exists, hidden by default until the loader confirms data', () => {
    expect(HTML).toMatch(/id="ovwGeminiCard"[^>]*hidden/)
    expect(HTML).toContain('id="ovwGeminiBarFill"')
    expect(HTML).toContain('id="ovwGeminiQuotaLabel"')
    expect(HTML).toContain('id="ovwGeminiToday"')
    expect(HTML).toContain('id="ovwGeminiStopBadge"')
  })

  it('the new script is loaded after app-overview.js', () => {
    const overviewIdx = HTML.indexOf('/app-overview.js')
    const geminiIdx = HTML.indexOf('/app-gemini-calls.js')
    expect(overviewIdx).toBeGreaterThan(-1)
    expect(geminiIdx).toBeGreaterThan(overviewIdx)
  })

  // Peti 11285 (kanban comment 18088): the Overview page can be rearranged, but nothing that
  // already renders there may disappear. Pin every element the cost widget (the closest existing
  // neighbour) exposes, so a future edit that accidentally deletes one of these instead of just
  // moving it turns this test red.
  it('does not remove any existing Overview elements (cost widget survives unchanged)', () => {
    expect(HTML).toContain('id="ovwCostCard"')
    expect(HTML).toContain('id="ovwCostBody"')
    expect(HTML).toContain('id="ovwCostFooter"')
    expect(HTML).toContain('id="ovwCostTotal"')
    expect(HTML).toContain('class="ovw-cost-detail-link"')
    expect(HTML).toContain('id="ovwLlmDistCard"')
    expect(HTML).toContain('id="overviewTeamGrid"')
    expect(HTML).toContain('id="overviewActivity"')
    expect(HTML).toContain('id="statAgents"')
    expect(HTML).toContain('id="statTasks"')
    expect(HTML).toContain('id="statMemories"')
    expect(HTML).toContain('id="statSkills"')
  })
})

describe('gemini-calls: i18n parity (hu.js / en.js)', () => {
  const KEYS = [
    'overview.gemini.title',
    'overview.gemini.detail_link',
    'nav.geminiCalls',
    'geminiCalls.title',
    'geminiCalls.subtitle',
    'geminiCalls.not_available',
    'geminiCalls.load_error',
    'geminiCalls.quota.title',
    'geminiCalls.quota.label',
    'geminiCalls.quota.next_free',
    'geminiCalls.overview.today',
    'geminiCalls.stop.title',
    'geminiCalls.stop.badge',
    'geminiCalls.stop.reason_unknown',
    'geminiCalls.summary.by_model_title',
    'geminiCalls.summary.by_task_title',
    'geminiCalls.summary.empty',
    'geminiCalls.summary.col_key',
    'geminiCalls.summary.col_total',
    'geminiCalls.summary.col_ok_pct',
    'geminiCalls.summary.col_avg_score',
    'geminiCalls.summary.col_unrated',
    'geminiCalls.list.title',
    'geminiCalls.list.empty',
    'geminiCalls.list.col_time',
    'geminiCalls.list.col_model',
    'geminiCalls.list.col_caller',
    'geminiCalls.list.col_card',
    'geminiCalls.list.col_task',
    'geminiCalls.list.col_status',
    'geminiCalls.list.col_duration',
    'geminiCalls.list.col_tokens',
    'geminiCalls.list.col_rating',
    'geminiCalls.status.ok',
    'geminiCalls.status.error',
    'geminiCalls.status.blocked',
    'geminiCalls.status.timeout',
    'geminiCalls.status.started',
    'geminiCalls.status.unknown',
    'geminiCalls.rating.unrated',
    'geminiCalls.rating.unrated_title',
    'geminiCalls.rating.result.elfogadva',
    'geminiCalls.rating.result.javitva',
    'geminiCalls.rating.result.eldobva',
    'geminiCalls.rating.result.unknown',
  ]

  for (const key of KEYS) {
    it(`'${key}' exists in both hu.js and en.js`, () => {
      expect(HU).toContain(`'${key}'`)
      expect(EN).toContain(`'${key}'`)
    })
  }
})

describe('gemini-calls: CSS', () => {
  it('page-level classes are defined', () => {
    expect(CSS).toContain('.gemini-page-status')
    expect(CSS).toContain('.gemini-stop-banner')
    expect(CSS).toContain('.gemini-quota-bar')
    expect(CSS).toContain('.gemini-summary-table')
    expect(CSS).toContain('.gemini-calls-table')
    expect(CSS).toContain('.gemini-rating')
    expect(CSS).toContain('.gemini-unrated')
  })

  it('all 5 status states have a distinct class rule (not just ok/error)', () => {
    expect(CSS).toContain('.gemini-status--ok')
    expect(CSS).toContain('.gemini-status--error')
    expect(CSS).toContain('.gemini-status--blocked')
    expect(CSS).toContain('.gemini-status--timeout')
    expect(CSS).toContain('.gemini-status--started')
  })

  it('overview tile classes are defined', () => {
    expect(CSS).toContain('.ovw-gemini-card')
    expect(CSS).toContain('.ovw-gemini-bar-fill')
    expect(CSS).toContain('.ovw-gemini-detail-link')
    expect(CSS).toContain('.gemini-stop-badge')
  })

  it('has a responsive breakpoint for the tables', () => {
    expect(CSS).toMatch(/@media \(max-width: 640px\)[\s\S]{0,200}gemini-(summary|calls)-table/)
  })
})
