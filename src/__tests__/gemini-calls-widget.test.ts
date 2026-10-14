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
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    bucket: Record<string, { calls: number; ok: number; error: number; blocked: number }>,
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
    expect(geminiSummaryEntries(undefined as any, [], 'model')).toEqual([])
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
