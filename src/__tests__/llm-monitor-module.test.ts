// Card 87be1810 -- LLM monitor page (task-events swimlane, KPI row, workload time-series).
//
// Two layers: the pure helpers of web/app-llm-monitor.js are EXECUTED under a window shim
// (bucketing, lane grouping, KPI mapping, curve path, packer), and string contracts pin the
// page wiring (nav, page switch, i18n header map, script order) and the honesty seams
// (blockCoverage note, truncation note, no fake zero for a null average).
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '../../web')
const MODULE = readFileSync(join(WEB, 'app-llm-monitor.js'), 'utf-8')
const HTML = readFileSync(join(WEB, 'index.html'), 'utf-8')
const SWITCH = readFileSync(join(WEB, 'app-page-switch.js'), 'utf-8')
const GROUPS = readFileSync(join(WEB, 'app-sidebar-groups.js'), 'utf-8')
const NAV = readFileSync(join(WEB, 'app-i18n-nav.js'), 'utf-8')
const CSS = readFileSync(join(WEB, 'style.css'), 'utf-8')

type Ev = { id?: number; agent?: string; category?: string; startMs: number; durationMs?: number; status?: string }
type Win = {
  _i18n: Record<string, Record<string, string>>
  llmMonLanesFromEvents: (events: Ev[]) => { agent: string; events: Ev[] }[]
  llmMonTopCategories: (events: Ev[], limit: number) => string[]
  llmMonBucketize: (events: Ev[], fromMs: number, toMs: number, n: number) => {
    bucketMs: number; starts: number[]; series: { key: string; counts: number[] }[]; total: number[]
  }
  llmMonKpis: (summary: unknown) => { key: string; value: number | null; failed?: number }[]
  llmMonSmoothPath: (points: { x: number; y: number }[]) => string
  llmMonPackRows: (blocks: { leftPct: number; widthPct: number; row: number }[], gap: number) => number
}

let win: Win
beforeAll(async () => {
  const g = globalThis as unknown as { window: Record<string, unknown> }
  g.window ||= {}
  await import(/* @vite-ignore */ join(WEB, 'app-llm-monitor.js') as string)
  await import(/* @vite-ignore */ join(WEB, 'lang/hu.js') as string)
  await import(/* @vite-ignore */ join(WEB, 'lang/en.js') as string)
  win = g.window as unknown as Win
})

const T0 = 1_788_500_000_000
const ev = (agent: string, category: string, startOffsetMs: number, durationMs = 1000, status = 'done'): Ev =>
  ({ agent, category, startMs: T0 + startOffsetMs, durationMs, status })

describe('the module is importable without a DOM (all wiring happens on first load)', () => {
  it('touches no document at load and exposes its helpers on window', () => {
    // Every `document.` use sits inside a function body; nothing runs at import.
    expect(typeof win.llmMonBucketize).toBe('function')
    expect(typeof win.llmMonLanesFromEvents).toBe('function')
    expect(typeof win.llmMonKpis).toBe('function')
  })
})

describe('llmMonLanesFromEvents -- one lane per agent, busiest first', () => {
  it('groups by agent and orders by task count, name as tiebreak', () => {
    const lanes = win.llmMonLanesFromEvents([
      ev('backend', 'code', 0), ev('route-classify', 'route-triage', 1), ev('route-classify', 'route-triage', 2),
      ev('alpha', 'code', 3),
    ])
    expect(lanes.map((l) => l.agent)).toEqual(['route-classify', 'alpha', 'backend'])
    expect(lanes[0]!.events).toHaveLength(2)
  })
  it('an event without an agent still gets a lane, never dropped', () => {
    const lanes = win.llmMonLanesFromEvents([{ startMs: T0, durationMs: 5 } as Ev])
    expect(lanes).toHaveLength(1)
    expect(lanes[0]!.agent).toBe('?')
  })
})

describe('llmMonBucketize -- tasks per bucket, top categories + other', () => {
  const events = [
    ev('a', 'route-triage', 0), ev('a', 'route-triage', 1_000), ev('a', 'route-triage', 59_000),
    ev('b', 'code', 30_000), ev('b', 'subtask-draft', 31_000),
    ev('c', 'rare-1', 45_000), ev('c', 'rare-2', 46_000), ev('c', 'rare-3', 47_000), ev('c', 'rare-4', 48_000),
  ]
  it('splits the window into n equal buckets and counts each task ONCE by its start', () => {
    const b = win.llmMonBucketize(events, T0, T0 + 60_000, 6)
    expect(b.bucketMs).toBe(10_000)
    expect(b.starts).toHaveLength(6)
    expect(b.total).toEqual([2, 0, 0, 2, 4, 1])
    expect(b.total.reduce((x, y) => x + y, 0)).toBe(events.length)
  })
  it('keeps the top 4 categories as their own series and folds the rest into "(other)"', () => {
    const b = win.llmMonBucketize(events, T0, T0 + 60_000, 6)
    const keys = b.series.map((s) => s.key)
    expect(keys[0]).toBe('route-triage')
    expect(keys).toHaveLength(5)
    expect(keys[keys.length - 1]).toBe('(other)')
    const other = b.series[b.series.length - 1]!
    expect(other.counts.reduce((x, y) => x + y, 0)).toBeGreaterThan(0)
  })
  it('omits "(other)" when every category fits', () => {
    const b = win.llmMonBucketize([ev('a', 'x', 0), ev('a', 'y', 1)], T0, T0 + 10, 2)
    expect(b.series.map((s) => s.key)).toEqual(['x', 'y'])
  })
  it('a start outside the window (overlapping task) is clamped to the edge bucket, not lost', () => {
    const b = win.llmMonBucketize([ev('a', 'x', -5_000), ev('a', 'x', 70_000)], T0, T0 + 60_000, 6)
    expect(b.total).toEqual([1, 0, 0, 0, 0, 1])
  })
  it('empty input is an empty answer, not a NaN', () => {
    const b = win.llmMonBucketize([], T0, T0 + 60_000, 4)
    expect(b.total).toEqual([0, 0, 0, 0])
    expect(b.series).toEqual([])
  })
})

describe('llmMonKpis -- the five tiles from the summary contract', () => {
  it('sums requests across models and derives the error rate from failed/tasks', () => {
    const k = win.llmMonKpis({
      activeModels: 4, taskCount: 200, failedCount: 10, avgDurationMs: 32680,
      models: [{ requests: 100 }, { requests: 250 }],
    })
    expect(k.map((x) => x.key)).toEqual(['active_models', 'tasks', 'avg_duration', 'total_requests', 'error_rate'])
    expect(k[0]!.value).toBe(4)
    expect(k[1]!.value).toBe(200)
    expect(k[1]!.failed).toBe(10)
    expect(k[2]!.value).toBe(32680)
    expect(k[3]!.value).toBe(350)
    expect(k[4]!.value).toBe(5)
  })
  it('RULE 12: a null average and a zero-task error rate stay null -- never a fake 0', () => {
    const k = win.llmMonKpis({ activeModels: 0, taskCount: 0, failedCount: 0, avgDurationMs: null, models: [] })
    expect(k[2]!.value).toBeNull()
    expect(k[4]!.value).toBeNull()
  })
  it('tolerates a missing summary', () => {
    const k = win.llmMonKpis(undefined)
    expect(k[1]!.value).toBe(0)
    expect(k[3]!.value).toBe(0)
  })
})

describe('llmMonSmoothPath / llmMonPackRows', () => {
  it('builds a cubic path through every point, starting with M and one C per segment', () => {
    const d = win.llmMonSmoothPath([{ x: 0, y: 10 }, { x: 10, y: 0 }, { x: 20, y: 10 }])
    expect(d.startsWith('M0.0 10.0')).toBe(true)
    expect(d.match(/ C/g)).toHaveLength(2)
    expect(d.endsWith('20.0 10.0')).toBe(true)
  })
  it('one point is a bare move, none is empty', () => {
    expect(win.llmMonSmoothPath([{ x: 1, y: 2 }])).toBe('M1.0 2.0')
    expect(win.llmMonSmoothPath([])).toBe('')
  })
  it('packs overlapping rendered boxes onto separate rows and reuses a row once it is clear', () => {
    const blocks = [
      { leftPct: 0, widthPct: 10, row: 0 },
      { leftPct: 5, widthPct: 10, row: 0 },
      { leftPct: 30, widthPct: 5, row: 0 },
    ]
    expect(win.llmMonPackRows(blocks, 0.25)).toBe(2)
    expect(blocks.map((b) => b.row)).toEqual([0, 1, 0])
  })
})

describe('page wiring (string contracts)', () => {
  it('index.html has the page, the sidebar link in the stats group, and the script after app-overview.js', () => {
    expect(HTML).toContain('id="llmMonitorPage"')
    expect(HTML).toContain('data-page="llmMonitor"')
    const stats = HTML.indexOf('id="sbGroupStats"')
    const link = HTML.indexOf('data-page="llmMonitor"')
    const system = HTML.indexOf('id="sbGroupSystem"')
    expect(link).toBeGreaterThan(stats)
    expect(link).toBeLessThan(system)
    const ovw = HTML.indexOf('src="/app-overview.js"')
    const mon = HTML.indexOf('src="/app-llm-monitor.js"')
    expect(ovw).toBeGreaterThan(-1)
    expect(mon).toBeGreaterThan(ovw)
    for (const id of ['llmMonWindow', 'llmMonRefreshBtn', 'llmMonKpis', 'llmMonLanes', 'llmMonSeries', 'llmMonModels', 'llmMonDetail', 'llmMonNotes']) {
      expect(HTML).toContain(`id="${id}"`)
    }
  })
  it('switchPage loads it, the sidebar group lists it, and the i18n nav/header maps know it', () => {
    expect(SWITCH).toContain("if (pageId === 'llmMonitor') loadLlmMonitor()")
    expect(GROUPS).toContain("pages: ['costs', 'tokenUsage', 'llmMonitor']")
    expect(NAV).toContain("llmMonitor: 'nav.llmMonitor'")
    expect(NAV).toContain("llmMonitorPage: { title: 'llmMon.page_title',     sub: 'llmMon.page_subtitle' }")
  })
  it('fetches BOTH contract endpoints with the ms window and the 2000 cap', () => {
    expect(MODULE).toContain('/api/task-summary?from=${fromMs}&to=${toMs}')
    expect(MODULE).toContain('/api/task-events?from=${fromMs}&to=${toMs}&limit=${LLM_MON_MAX_EVENTS}')
    expect(MODULE).toContain('const LLM_MON_MAX_EVENTS = 2000')
  })
  it('surfaces the blockCoverage seam and the truncation flag instead of hiding them', () => {
    expect(MODULE).toContain("t('llmMon.coverage_note'")
    expect(MODULE).toContain('summary.blockCoverage.lanes')
    expect(MODULE).toContain("if (feed.truncated) notes.push(")
  })
  it('blocks are buttons that open the detail panel; the panel is a dialog closed by Escape', () => {
    expect(MODULE).toContain('class="ovw-llmdist-block llm-mon-block"')
    expect(MODULE).toContain("llmMonOpenDetail(Number(block.dataset.idx), block)")
    expect(MODULE).toContain("if (e.key === 'Escape') llmMonCloseDetail()")
    expect(HTML).toContain('id="llmMonDetail" role="dialog"')
    expect(MODULE).toContain("t('llmMon.detail.tokens_note')")
  })
  it('the 400 body of the API (which names the parameter) reaches the operator; other errors get the localized text + retry', () => {
    expect(MODULE).toContain("err.status === 400 ? err.message : ''")
    expect(MODULE).toContain('id="llmMonRetryBtn"')
    expect(MODULE).toContain("t('llmMon.error')")
  })
  it('the detail panel becomes a bottom sheet on narrow screens and the close target is 44px (rule 13)', () => {
    const mobile = CSS.slice(CSS.indexOf('@media (max-width: 720px) {\n  .llm-mon-detail'))
    expect(mobile).toContain('bottom: calc(12px + env(safe-area-inset-bottom, 0px))')
    expect(CSS).toMatch(/\.llm-mon-detail-close \{[^}]*min-height: 44px/)
  })
})

describe('every llmMon i18n key the module or the page references exists in hu AND en', () => {
  it('module + html keys are defined in both languages', () => {
    const keys = new Set<string>()
    for (const m of (MODULE + HTML).matchAll(/'(llmMon\.[a-z0-9_.]*[a-z0-9_])'/g)) keys.add(m[1]!)
    for (const m of HTML.matchAll(/data-i18n="(llmMon\.[a-z0-9_.]+)"/g)) keys.add(m[1]!)
    expect(keys.size).toBeGreaterThan(30)
    for (const k of keys) {
      expect(typeof win._i18n.hu[k], `hu ${k}`).toBe('string')
      expect(typeof win._i18n.en[k], `en ${k}`).toBe('string')
    }
    // Keys built at runtime from a prefix:
    for (const k of ['active_models', 'tasks', 'avg_duration', 'total_requests', 'error_rate']) {
      expect(typeof win._i18n.hu['llmMon.kpi.' + k]).toBe('string')
      expect(typeof win._i18n.en['llmMon.kpi.' + k]).toBe('string')
    }
    expect(typeof win._i18n.hu['nav.llmMonitor']).toBe('string')
    expect(typeof win._i18n.en['nav.llmMonitor']).toBe('string')
  })
})
