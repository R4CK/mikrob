// Contract tests for the upstream-update banner reader (card 3c09ba6b / FÁZIS3).
// Rule 10: the banner REUSES update-checker.ts's existing per-repo `behind` (the `marveen`
// upstream repo out of getUpdateStatus's aggregate) instead of a parallel check. These prove
// readUpstreamUpdate is FAIL-SAFE: it surfaces the upstream repo's behind ONLY when a clean
// check ran, and yields null/hidden on absent-repo / errored / never-checked states.
import { describe, it, expect } from 'vitest'
import { readUpstreamUpdate } from '../web/routes/overview.js'
import type { AggregateUpdateStatus, RepoStatus } from '../web/update-checker.js'

function marveenRepo(over: Partial<RepoStatus> = {}): RepoStatus {
  return {
    key: 'marveen',
    label: 'Marveen (upstream)',
    branch: 'main',
    current: 'c863e81',
    latest: '260aaab',
    behind: 0,
    commits: [],
    remote: 'Szotasz/marveen',
    lastChecked: 1784913893000,
    ...over,
  }
}

function agg(repos: RepoStatus[]): AggregateUpdateStatus {
  return {
    current: 'c863e81',
    latest: 'c863e81',
    behind: 0,
    commits: [],
    remote: 'Szotasz/marveen',
    lastChecked: 1784913893000,
    repos,
  }
}

describe('readUpstreamUpdate (reuses update-checker)', () => {
  it('surfaces the upstream repo behind when a clean check ran', () => {
    expect(readUpstreamUpdate(agg([marveenRepo({ behind: 7 })]))).toEqual({
      behind: 7,
      upstreamBranch: 'main',
      remote: 'Szotasz/marveen',
      checkedAt: 1784913893000,
      ok: true,
    })
  })

  it('returns null when there is no marveen (upstream) repo in the aggregate', () => {
    const mikrobOnly = { ...marveenRepo(), key: 'mikrob', label: 'MikroB fork' }
    expect(readUpstreamUpdate(agg([mikrobOnly]))).toBeNull()
  })

  it('ok=false (banner hidden) when the upstream check ERRORED', () => {
    const r = readUpstreamUpdate(agg([marveenRepo({ behind: 5, error: 'rate limited' })]))
    expect(r?.ok).toBe(false)
  })

  it('ok=false when the check has NEVER run (lastChecked 0)', () => {
    const r = readUpstreamUpdate(agg([marveenRepo({ behind: 3, lastChecked: 0 })]))
    expect(r?.ok).toBe(false)
  })

  it('behind 0 -> the overview keeps the banner hidden', () => {
    expect(readUpstreamUpdate(agg([marveenRepo({ behind: 0 })]))?.behind).toBe(0)
  })

  it('is fail-safe on a malformed aggregate (no repos array) -> null', () => {
    expect(readUpstreamUpdate({} as AggregateUpdateStatus)).toBeNull()
  })
})
