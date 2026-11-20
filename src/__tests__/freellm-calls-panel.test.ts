// Card ebe20efe (Peti 14295): FreeLLM page call list + per-outcome counters.
// Contract (agreed with backend2, Pair-BE 685f25cb): GET /api/freellm/calls?since=&limit= ->
//   { calls: [{ ts, agent, card, model, provider, outcome, duration_ms, attempt }, ...],
//     counts_24h: { ok, fail, stalled, rate_429, auth }, counts_7d: { same shape } }
//
// House idiom (see freellm-error-section-visibility.test.ts, llm-ledger-dashboard.test.ts): the
// real functions are extracted from the shipped web/app-freellm.js and executed against a
// minimal hand-rolled DOM stub, not jsdom.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'app-freellm.js'), 'utf8')
const HTML = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
const CSS = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')

function extract(name: string): string {
  let start = SRC.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`missing function ${name}`)
  if (SRC.slice(Math.max(0, start - 6), start) === 'async ') start -= 6
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
  children: FakeEl[] = []
  private listeners: Record<string, Array<() => void>> = {}
  constructor(tag: string) { this.tag = tag }
  appendChild(child: FakeEl) { this.children.push(child); return child }
  addEventListener(event: string, cb: () => void) {
    ;(this.listeners[event] ||= []).push(cb)
  }
  dispatch(event: string) {
    (this.listeners[event] || []).forEach((cb) => cb())
  }
}

function makeDocument(ids: string[]) {
  const registry = new Map<string, FakeEl>()
  for (const id of ids) registry.set(id, new FakeEl('div'))
  return {
    document: {
      getElementById: (id: string) => registry.get(id) ?? null,
      createElement: (tag: string) => new FakeEl(tag),
    },
    els: registry,
  }
}

function fakeT(key: string): string {
  const map: Record<string, string> = {
    'freellm.calls.outcome.ok': 'Success',
    'freellm.calls.outcome.fail': 'Failed',
    'freellm.calls.outcome.stalled': 'Stalled',
    'freellm.calls.outcome.429': 'Rate limited (429)',
    'freellm.calls.outcome.auth': 'Auth error',
    'freellm.calls.fail_reason.http_404': 'endpoint not found (404)',
    'freellm.calls.load_error': 'Could not load the call log. Try again.',
  }
  return map[key] ?? ''
}

let freellmOutcomeLabel: (outcome: string) => string
let freellmFmtDuration: (ms: number | null | undefined) => string

beforeAll(() => {
  // Only the two DOM-free helpers are needed at this scope -- freellmRenderCountsRow and
  // freellmRenderCallsTable are extracted fresh inside their own describe blocks below, each
  // against its own DOM stub, since they touch getElementById/createElement.
  const body =
    `${extract('freellmOutcomeLabel')}\n${extract('freellmOutcomeIsFailure')}\n` +
    `${extract('freellmFmtDuration')}\n${extract('freellmFmtTime')}\n` +
    'return { freellmOutcomeLabel, freellmFmtDuration }'
  const factory = new Function('document', 't', body) as (
    document: unknown, t: unknown,
  ) => {
    freellmOutcomeLabel: typeof freellmOutcomeLabel
    freellmFmtDuration: typeof freellmFmtDuration
  }
  // These two helpers don't touch the DOM, so a throwaway document is fine here.
  const out = factory(makeDocument([]).document, fakeT)
  freellmOutcomeLabel = out.freellmOutcomeLabel
  freellmFmtDuration = out.freellmFmtDuration
})

describe('freellmOutcomeLabel', () => {
  it('resolves a known outcome to its translated label', () => {
    expect(freellmOutcomeLabel('ok')).toBe('Success')
    expect(freellmOutcomeLabel('429')).toBe('Rate limited (429)')
  })

  it('falls back to the raw outcome string for an unexpected value (future-proofing the enum)', () => {
    expect(freellmOutcomeLabel('some_new_outcome')).toBe('some_new_outcome')
  })
})

describe('freellmFmtDuration', () => {
  it('formats sub-second durations in ms', () => {
    expect(freellmFmtDuration(450)).toBe('450 ms')
  })
  it('formats >= 1s durations in seconds', () => {
    expect(freellmFmtDuration(4200)).toBe('4.2 s')
  })
  it('returns a dash for missing/invalid values', () => {
    expect(freellmFmtDuration(null)).toBe('—')
    expect(freellmFmtDuration(undefined)).toBe('—')
    expect(freellmFmtDuration(NaN)).toBe('—')
  })
})

describe('freellmRenderCountsRow', () => {
  function run(counts: Record<string, number> | undefined) {
    const { document, els } = makeDocument(['row'])
    const body =
      `const FREELLM_COUNT_FIELDS = ['ok', 'fail', 'stalled', 'rate_429', 'auth']\n` +
      `${extract('freellmOutcomeLabel')}\n${extract('freellmCountFieldLabel')}\n${extract('freellmRenderCountsRow')}\n` +
      'return { freellmRenderCountsRow }'
    const factory = new Function('document', 't', body) as (
      document: unknown, t: unknown,
    ) => { freellmRenderCountsRow: (elId: string, counts: Record<string, number> | undefined) => void }
    factory(document, fakeT).freellmRenderCountsRow('row', counts)
    return els.get('row')!
  }

  it('renders one chip per outcome field (ok/fail/stalled/rate_429/auth), in order, with real counts', () => {
    const row = run({ ok: 10, fail: 2, stalled: 1, rate_429: 0, auth: 0 })
    expect(row.children.length).toBe(5)
    expect(row.children[0].textContent).toBe('Success: 10')
    expect(row.children[1].textContent).toBe('Failed: 2')
  })

  it("maps the counts object's 'rate_429' key to the same label as a row's '429' outcome value", () => {
    const row = run({ ok: 0, fail: 0, stalled: 0, rate_429: 3, auth: 0 })
    expect(row.children[3].textContent).toBe('Rate limited (429): 3')
  })

  it('defaults every missing count to 0 rather than throwing or rendering "undefined"', () => {
    const row = run(undefined)
    expect(row.children[0].textContent).toBe('Success: 0')
  })
})

describe('freellmRenderCallsTable', () => {
  function run(calls: Array<Record<string, unknown>>) {
    const { document, els } = makeDocument(['freellmCallsTbody'])
    const body =
      `${extract('freellmOutcomeLabel')}\n${extract('freellmFailReasonLabel')}\n${extract('freellmOutcomeIsFailure')}\n` +
      `${extract('freellmFmtDuration')}\n${extract('freellmFmtTime')}\n${extract('freellmRenderCallsTable')}\n` +
      'return { freellmRenderCallsTable }'
    const factory = new Function('document', 't', body) as (
      document: unknown, t: unknown,
    ) => { freellmRenderCallsTable: (calls: Array<Record<string, unknown>>) => void }
    factory(document, fakeT).freellmRenderCallsTable(calls)
    return els.get('freellmCallsTbody')!
  }

  it('renders one row per call with 6 cells in column order (ts is unix SECONDS)', () => {
    const tbody = run([{ ts: 1700000000, agent: 'backend2', card: 'ebe20efe', model: 'llama3', outcome: 'ok', duration_ms: 1200 }])
    expect(tbody.children.length).toBe(1)
    const row = tbody.children[0]
    expect(row.children.length).toBe(6)
    expect(row.children[1].textContent).toBe('backend2')
    expect(row.children[2].textContent).toBe('ebe20efe')
    expect(row.children[3].textContent).toBe('llama3')
    expect(row.children[4].textContent).toBe('Success')
    expect(row.children[5].textContent).toBe('1.2 s')
  })

  it('marks a non-ok outcome row as failed (rule 12: it must stand out)', () => {
    const tbody = run([{ ts: 1, agent: 'a', card: 'c', model: 'm', outcome: 'fail', duration_ms: 1 }])
    expect(tbody.children[0].className).toBe('freellm-calls-row--failed')
  })

  it('does not mark a successful row as failed', () => {
    const tbody = run([{ ts: 1, agent: 'a', card: 'c', model: 'm', outcome: 'ok', duration_ms: 1 }])
    expect(tbody.children[0].className).toBe('')
  })

  it('shows a dash for a missing agent/card/model instead of "null" or "undefined"', () => {
    const tbody = run([{ ts: 1, agent: null, card: null, model: null, outcome: 'ok', duration_ms: 1 }])
    const row = tbody.children[0]
    expect(row.children[1].textContent).toBe('—')
    expect(row.children[2].textContent).toBe('—')
    expect(row.children[3].textContent).toBe('—')
  })

  it('appends the fail_reason to the outcome text when present (rule 12: show WHY, not just that it failed)', () => {
    const tbody = run([{ ts: 1, agent: 'a', card: 'c', model: 'm', outcome: 'fail', fail_reason: 'http_404', duration_ms: 1 }])
    expect(tbody.children[0].children[4].textContent).toBe('Failed (endpoint not found (404))')
  })

  it('falls back to a de-snaked fail_reason for an unrecognized reason code', () => {
    const tbody = run([{ ts: 1, agent: 'a', card: 'c', model: 'm', outcome: 'fail', fail_reason: 'some_new_reason', duration_ms: 1 }])
    expect(tbody.children[0].children[4].textContent).toBe('Failed (some new reason)')
  })

  it('shows the plain outcome with no parenthetical when fail_reason is null', () => {
    const tbody = run([{ ts: 1, agent: 'a', card: 'c', model: 'm', outcome: 'ok', fail_reason: null, duration_ms: 1 }])
    expect(tbody.children[0].children[4].textContent).toBe('Success')
  })

  it('does NOT append fail_reason for auth/429/stalled -- the raw backend string (auth_401, quota_429, http_) would look broken appended verbatim; the outcome label already says why', () => {
    const auth = run([{ ts: 1, agent: 'a', card: 'c', model: 'm', outcome: 'auth', fail_reason: 'auth_401', duration_ms: 1 }])
    expect(auth.children[0].children[4].textContent).toBe('Auth error')
    const rate = run([{ ts: 1, agent: 'a', card: 'c', model: 'm', outcome: '429', fail_reason: 'quota_429', duration_ms: 1 }])
    expect(rate.children[0].children[4].textContent).toBe('Rate limited (429)')
    const stalled = run([{ ts: 1, agent: 'a', card: 'c', model: 'm', outcome: 'stalled', fail_reason: 'http_', duration_ms: 1 }])
    expect(stalled.children[0].children[4].textContent).toBe('Stalled')
  })
})

describe('freellmLoadCalls (fetch wiring)', () => {
  function build() {
    const ids = ['freellmCallsLoading', 'freellmCallsError', 'freellmCallsEmpty', 'freellmCallsCounts', 'freellmCallsTableWrap', 'freellmCounts24h', 'freellmCounts7d', 'freellmCallsTbody']
    const { document, els } = makeDocument(ids)
    const body =
      'const FREELLM_CALLS_LIMIT = 50\n' +
      `const FREELLM_COUNT_FIELDS = ['ok', 'fail', 'stalled', 'rate_429', 'auth']\n` +
      `${extract('freellmOutcomeLabel')}\n${extract('freellmCountFieldLabel')}\n${extract('freellmFailReasonLabel')}\n${extract('freellmOutcomeIsFailure')}\n` +
      `${extract('freellmFmtDuration')}\n${extract('freellmFmtTime')}\n` +
      `${extract('freellmSetCallsLoading')}\n${extract('freellmSetCallsError')}\n${extract('freellmSetCallsEmpty')}\n` +
      `${extract('freellmRenderCountsRow')}\n${extract('freellmRenderCallsTable')}\n${extract('freellmLoadCalls')}\n` +
      'return { freellmLoadCalls }'
    const factory = new Function('document', 't', 'fetch', body) as (
      document: unknown, t: unknown, fetch: unknown,
    ) => { freellmLoadCalls: () => Promise<void> }
    return { document, els, factory }
  }

  it('fetches /api/freellm/calls with the limit param and renders the empty state for 0 calls', async () => {
    const { els, factory, document } = build()
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ calls: [], counts_24h: { ok: 0, fail: 0, stalled: 0, rate_429: 0, auth: 0 }, counts_7d: { ok: 0, fail: 0, stalled: 0, rate_429: 0, auth: 0 } }),
    })
    const { freellmLoadCalls } = factory(document, fakeT, fetchSpy)
    await freellmLoadCalls()
    expect(fetchSpy).toHaveBeenCalledWith('/api/freellm/calls?limit=50')
    expect(els.get('freellmCallsEmpty')!.hidden).toBe(false)
    expect(els.get('freellmCallsTableWrap')!.hidden).toBe(true)
    expect(els.get('freellmCallsCounts')!.hidden).toBe(false)
  })

  it('renders the table and hides the empty state when calls exist', async () => {
    const { els, factory, document } = build()
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        calls: [{ ts: 1, agent: 'a', card: 'c', model: 'm', outcome: 'ok', duration_ms: 1 }],
        counts_24h: { ok: 1, fail: 0, stalled: 0, rate_429: 0, auth: 0 }, counts_7d: { ok: 1, fail: 0, stalled: 0, rate_429: 0, auth: 0 },
      }),
    })
    const { freellmLoadCalls } = factory(document, fakeT, fetchSpy)
    await freellmLoadCalls()
    expect(els.get('freellmCallsEmpty')!.hidden).toBe(true)
    expect(els.get('freellmCallsTableWrap')!.hidden).toBe(false)
  })

  it('shows the load-error state and hides counts/table on a rejecting fetch', async () => {
    const { els, factory, document } = build()
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network down'))
    const { freellmLoadCalls } = factory(document, fakeT, fetchSpy)
    await freellmLoadCalls()
    expect(els.get('freellmCallsError')!.hidden).toBe(false)
    expect(els.get('freellmCallsCounts')!.hidden).toBe(true)
    expect(els.get('freellmCallsTableWrap')!.hidden).toBe(true)
  })

  it('shows the load-error state on a non-ok HTTP response too', async () => {
    const { els, factory, document } = build()
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const { freellmLoadCalls } = factory(document, fakeT, fetchSpy)
    await freellmLoadCalls()
    expect(els.get('freellmCallsError')!.hidden).toBe(false)
  })
})

describe('freellm calls panel: static wiring in the shipped page', () => {
  it('index.html has the calls section, toolbar, counts groups and table scaffold', () => {
    expect(HTML).toContain('id="freellmCallsRefreshBtn"')
    expect(HTML).toContain('id="freellmCallsLoading"')
    expect(HTML).toContain('id="freellmCallsError"')
    expect(HTML).toContain('id="freellmCallsEmpty"')
    expect(HTML).toContain('id="freellmCallsCounts"')
    expect(HTML).toContain('id="freellmCounts24h"')
    expect(HTML).toContain('id="freellmCounts7d"')
    expect(HTML).toContain('id="freellmCallsTableWrap"')
    expect(HTML).toContain('id="freellmCallsTbody"')
  })

  it('loadFreellm wires freellmSetupCalls and polls freellmLoadCalls', () => {
    expect(SRC).toContain('freellmSetupCalls()')
    expect(SRC).toContain('freellmLoadCalls()')
  })

  it('CSS has the table/toolbar/counts/failed-row classes', () => {
    expect(CSS).toContain('.freellm-toolbar')
    expect(CSS).toContain('.freellm-calls-table-wrap')
    expect(CSS).toContain('.freellm-calls-counts')
    expect(CSS).toContain('.freellm-calls-row--failed')
  })
})

const FREELLM_CALLS_I18N_KEYS = [
  'freellm.calls.title',
  'freellm.calls.refresh',
  'freellm.calls.loading',
  'freellm.calls.load_error',
  'freellm.calls.empty',
  'freellm.calls.window_24h',
  'freellm.calls.window_7d',
  'freellm.calls.col.time',
  'freellm.calls.col.agent',
  'freellm.calls.col.card',
  'freellm.calls.col.model',
  'freellm.calls.col.outcome',
  'freellm.calls.col.duration',
  'freellm.calls.outcome.ok',
  'freellm.calls.outcome.fail',
  'freellm.calls.outcome.stalled',
  'freellm.calls.outcome.429',
  'freellm.calls.outcome.auth',
  'freellm.calls.fail_reason.http_404',
]

describe('freellm calls panel: i18n parity', () => {
  for (const key of FREELLM_CALLS_I18N_KEYS) {
    it(`key "${key}" exists in both hu.js and en.js`, () => {
      expect(HU).toContain(`'${key}':`)
      expect(EN).toContain(`'${key}':`)
    })
  }
})
