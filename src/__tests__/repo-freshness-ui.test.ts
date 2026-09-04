// Card 92a4c2e7 -- per-repo freshness on the Beépített repók grid and the Frissítések page.
//
// Two layers, on purpose:
//   1. BEHAVIOUR of the shared classification (web/app-repo-freshness.js), executed for real
//      under the lang-parity window shim -- not re-derived in the test.
//   2. STRING CONTRACTS (house idiom) that the two renderers actually route through that
//      classification and that every i18n key they reference exists in BOTH languages.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '../../web')
const CONNECTORS = readFileSync(join(WEB, 'app-connectors.js'), 'utf-8')
const OVERLAY = readFileSync(join(WEB, 'fork-updates.js'), 'utf-8')
const HTML = readFileSync(join(WEB, 'index.html'), 'utf-8')
const FRESHNESS_SRC = readFileSync(join(WEB, 'app-repo-freshness.js'), 'utf-8')

type Repo = {
  behind?: number | string
  upstreamSha?: string | null
  installed?: boolean
  reviewRequired?: boolean
  lastCheckedAt?: string | null
}
type State = 'behind' | 'up_to_date' | 'unknown'
type Summary = {
  total: number
  upToDate: number
  behind: number
  unknown: number
  reviewRequired: number
  neverChecked: number
  lastCheckedAt: string | null
}
type Win = {
  _i18n: Record<string, Record<string, string>>
  repoFreshnessState: (r: Repo | null | undefined) => State
  summarizeRepoFreshness: (repos: Repo[] | undefined) => Summary
  sortReposForFreshnessTable: (repos: (Repo & { name?: string })[] | undefined) => (Repo & { name?: string })[]
}

let win: Win
beforeAll(async () => {
  const g = globalThis as unknown as { window: Record<string, unknown> }
  g.window ||= {}
  await import(/* @vite-ignore */ join(WEB, 'app-repo-freshness.js') as string)
  await import(/* @vite-ignore */ join(WEB, 'lang/hu.js') as string)
  await import(/* @vite-ignore */ join(WEB, 'lang/en.js') as string)
  win = g.window as unknown as Win
})

describe('repoFreshnessState (executed, not re-derived)', () => {
  it('behind > 0 is "behind" even with an upstream ref and an install', () => {
    expect(win.repoFreshnessState({ behind: 7, upstreamSha: 'abc', installed: true })).toBe('behind')
  })
  it('a numeric string behind still counts (the API is JSON, but be tolerant)', () => {
    expect(win.repoFreshnessState({ behind: '3', upstreamSha: 'abc' })).toBe('behind')
  })
  it('behind 0 WITH an upstream ref is measured up to date', () => {
    expect(win.repoFreshnessState({ behind: 0, upstreamSha: 'abc', installed: true })).toBe('up_to_date')
  })
  it('RULE 12: behind 0 WITHOUT an upstream ref is unknown, never fresh (pipx / never fetched)', () => {
    expect(win.repoFreshnessState({ behind: 0, upstreamSha: null, installed: true })).toBe('unknown')
  })
  it('a not-installed entry is unknown even if a ref exists', () => {
    expect(win.repoFreshnessState({ behind: 0, upstreamSha: 'abc', installed: false })).toBe('unknown')
  })
  it('null / undefined input is unknown, not a throw', () => {
    expect(win.repoFreshnessState(null)).toBe('unknown')
    expect(win.repoFreshnessState(undefined)).toBe('unknown')
  })
})

describe('summarizeRepoFreshness', () => {
  const fixture: Repo[] = [
    { behind: 11, upstreamSha: 'a', installed: true, reviewRequired: true, lastCheckedAt: '2026-08-27' },
    { behind: 1, upstreamSha: 'b', installed: true, reviewRequired: false, lastCheckedAt: '2026-09-03' },
    { behind: 0, upstreamSha: 'c', installed: true, reviewRequired: false, lastCheckedAt: '2026-09-02' },
    { behind: 0, upstreamSha: null, installed: true, reviewRequired: false, lastCheckedAt: null },
    { behind: 0, upstreamSha: null, installed: false, reviewRequired: false, lastCheckedAt: '' },
  ]
  it('counts every state exactly once and totals add up', () => {
    const s = win.summarizeRepoFreshness(fixture)
    expect(s).toEqual({
      total: 5,
      upToDate: 1,
      behind: 2,
      unknown: 2,
      reviewRequired: 1,
      neverChecked: 2,
      lastCheckedAt: '2026-09-03',
    })
    expect(s.upToDate + s.behind + s.unknown).toBe(s.total)
  })
  it('lastCheckedAt is the NEWEST date, not the first one seen', () => {
    const s = win.summarizeRepoFreshness([fixture[1], fixture[0]])
    expect(s.lastCheckedAt).toBe('2026-09-03')
  })
  it('empty and undefined input give all zeros and no date', () => {
    const zero: Summary = { total: 0, upToDate: 0, behind: 0, unknown: 0, reviewRequired: 0, neverChecked: 0, lastCheckedAt: null }
    expect(win.summarizeRepoFreshness([])).toEqual(zero)
    expect(win.summarizeRepoFreshness(undefined)).toEqual(zero)
  })
})

describe('sortReposForFreshnessTable (card 184dc8d7, executed)', () => {
  const input = [
    { name: 'zeta', behind: 0, upstreamSha: 'x', installed: true },
    { name: 'alpha', behind: 0, upstreamSha: 'x', installed: true },
    { name: 'pipx-thing', behind: 0, upstreamSha: null, installed: true },
    { name: 'small-lag', behind: 1, upstreamSha: 'x', installed: true },
    { name: 'big-lag', behind: 88, upstreamSha: 'x', installed: true },
  ]
  it('orders attention-first: behind (most commits first), then unknown, then up to date by name', () => {
    const names = win.sortReposForFreshnessTable(input).map((r) => r.name)
    expect(names).toEqual(['big-lag', 'small-lag', 'pipx-thing', 'alpha', 'zeta'])
  })
  it('does not mutate its input and tolerates undefined', () => {
    const before = input.map((r) => r.name)
    win.sortReposForFreshnessTable(input)
    expect(input.map((r) => r.name)).toEqual(before)
    expect(win.sortReposForFreshnessTable(undefined)).toEqual([])
  })
})

describe('the module is pure and loaded before both consumers', () => {
  it('app-repo-freshness.js touches no DOM at load', () => {
    expect(FRESHNESS_SRC).not.toMatch(/\bdocument\./)
  })
  it('index.html loads app-repo-freshness.js before app-connectors.js and before fork-updates.js', () => {
    const fresh = HTML.indexOf('src="/app-repo-freshness.js"')
    const conn = HTML.indexOf('src="/app-connectors.js"')
    const fork = HTML.indexOf('src="/fork-updates.js"')
    expect(fresh).toBeGreaterThan(-1)
    expect(conn).toBeGreaterThan(fresh)
    expect(fork).toBeGreaterThan(fresh)
  })
})

describe('Beépített repók grid renders the three states through the shared classification', () => {
  it('normalises upstreamSha from the API (without it behind 0 could never be unknown)', () => {
    expect(CONNECTORS).toContain('upstreamSha: r.upstreamSha || null')
  })
  it('classifies via repoFreshnessState and emits all three badges', () => {
    expect(CONNECTORS).toContain('const freshness = repoFreshnessState(r)')
    expect(CONNECTORS).toContain("t('repos.fresh.up_to_date')")
    expect(CONNECTORS).toContain("t('repos.fresh.unknown')")
    expect(CONNECTORS).toContain("t('repos.update_available_badge')")
  })
  it('the last-checked row is never omitted: a missing date reads as "not yet"', () => {
    expect(CONNECTORS).toContain("t('repos.last_checked_never')")
    expect(CONNECTORS).not.toMatch(/const checkedRow = r\.lastCheckedAt\s*\?[^\n]*\n\s*: ''/)
  })
  it('fills the four freshness tiles from summarizeRepoFreshness over the adopted set', () => {
    expect(CONNECTORS).toContain('const fresh = summarizeRepoFreshness(adopted)')
    for (const id of ['reposStatFresh', 'reposStatBehind', 'reposStatReview', 'reposStatUnknown']) {
      expect(CONNECTORS).toContain(`getElementById('${id}')`)
      expect(HTML).toContain(`id="${id}"`)
    }
  })
  it('the page no longer claims update detection is unavailable', () => {
    expect(win._i18n.hu['repos.detect_info_box']).not.toContain('még nem elérhető')
    expect(win._i18n.en['repos.detect_info_box']).not.toContain('not available yet')
  })
})

describe('Frissítések page carries the adopted repos strip', () => {
  it('index.html has the container inside the updates page', () => {
    const updatesPage = HTML.indexOf('id="updatesPage"')
    const reposPage = HTML.indexOf('id="reposPage"')
    const strip = HTML.indexOf('id="updatesIntegratedRepos"')
    expect(strip).toBeGreaterThan(updatesPage)
    expect(strip).toBeLessThan(reposPage)
  })
  it('the overlay fetches /api/integrated-repos in its own function and calls it from forkLoadUpdates', () => {
    expect(OVERLAY).toContain("fetch('/api/integrated-repos')")
    expect(OVERLAY.match(/async function renderIntegratedReposSummary\(\)/g)).toHaveLength(1)
    const body = OVERLAY.slice(OVERLAY.indexOf('async function forkLoadUpdates()'))
    expect(body).toContain('renderIntegratedReposSummary()')
  })
  it('summarises through the shared functions and renders the FULL per-repo table in attention-first order (card 184dc8d7)', () => {
    expect(OVERLAY).toContain('summarizeRepoFreshness(repos)')
    expect(OVERLAY).toContain('sortReposForFreshnessTable(repos).map(')
    expect(OVERLAY).toContain('const state = repoFreshnessState(r)')
    expect(OVERLAY).toContain("t('updates.integrated.behind_item'")
    expect(OVERLAY).toContain('<table class="updates-integrated-table">')
  })
  it('every table cell carries a data-label so the mobile stacked layout stays labelled (rule 13)', () => {
    const fn = OVERLAY.slice(OVERLAY.indexOf('function integratedReposSummaryHtml'), OVERLAY.indexOf('async function renderIntegratedReposSummary'))
    const tds = fn.match(/<td\b[^>]*>/g) || []
    expect(tds.length).toBeGreaterThanOrEqual(7)
    for (const td of tds) expect(td).toContain('data-label=')
  })
  it('shows enabled/disabled and adoption per row (the narrowed-scope columns)', () => {
    expect(OVERLAY).toContain("t('updates.integrated.col.enabled')")
    expect(OVERLAY).toContain('esc(r.adoption)')
    expect(OVERLAY).toContain("t('common.yes')")
  })
  it('the review-note column exists ONLY when the API carries the field -- absence is not "no note"', () => {
    expect(OVERLAY).toContain("repos.some((r) => typeof r.note === 'string')")
    expect(OVERLAY).toContain('<details class="updates-integrated-note">')
    expect(OVERLAY).not.toContain("r.description.length")
  })
  it('the details button jumps to the repos page (no dead-end link, rule 9)', () => {
    expect(OVERLAY).toContain("switchPage('repos')")
  })
  it('a failed fetch renders a localized error, not a blank strip', () => {
    expect(OVERLAY).toContain("t('updates.integrated.error')")
  })
})

describe('every new i18n key exists in hu AND en', () => {
  const keys = [
    'repos.stat.fresh', 'repos.stat.behind', 'repos.stat.review', 'repos.stat.unknown',
    'repos.fresh.up_to_date', 'repos.fresh.up_to_date_title',
    'repos.fresh.unknown', 'repos.fresh.unknown_title', 'repos.last_checked_never',
    'updates.integrated.title', 'updates.integrated.counts', 'updates.integrated.last_checked',
    'updates.integrated.never_checked', 'updates.integrated.never_count',
    'updates.integrated.behind_item', 'updates.integrated.empty',
    'updates.integrated.link', 'updates.integrated.error',
    'updates.integrated.col.name', 'updates.integrated.col.kind', 'updates.integrated.col.enabled',
    'updates.integrated.col.installed', 'updates.integrated.col.last_checked',
    'updates.integrated.col.state', 'updates.integrated.col.note', 'updates.integrated.note_summary',
  ]
  for (const k of keys) {
    it(k, () => {
      expect(typeof win._i18n.hu[k]).toBe('string')
      expect(typeof win._i18n.en[k]).toBe('string')
      expect(win._i18n.hu[k].length).toBeGreaterThan(0)
      expect(win._i18n.en[k].length).toBeGreaterThan(0)
    })
  }
  it('the counts key carries every placeholder the renderer fills', () => {
    for (const lang of ['hu', 'en'] as const) {
      for (const ph of ['{total}', '{fresh}', '{behind}', '{review}', '{unknown}']) {
        expect(win._i18n[lang]['updates.integrated.counts']).toContain(ph)
      }
    }
  })
})
