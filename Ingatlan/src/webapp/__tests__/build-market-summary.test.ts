import { describe, it, expect } from 'vitest'
import { buildMarketSummary } from '../build-market-summary.js'
import type { Snapshot } from '../../analysis/stats.js'
import type { PricePoint } from '../../analysis/trend.js'
import type { TrendPoint } from '../build-trend-points.js'

const snap = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  id: 'x',
  url: 'https://ingatlan.com/x',
  tipus: 'lakas',
  nm2Ar: 1000,
  ...overrides,
})

describe('buildMarketSummary', () => {
  it('computes grouped stats, active count, and the latest-update timestamp', () => {
    const snapshots = [
      snap({ id: 'h1', tipus: 'haz', nm2Ar: 900 }),
      snap({ id: 'h2', tipus: 'haz', nm2Ar: 1100 }),
      snap({ id: 'l1', tipus: 'lakas', nm2Ar: 1000 }),
    ]
    const pricePoints: PricePoint[] = [
      { listingId: 'h1', tipus: 'haz', eszleltAt: 1000, nm2Ar: 900 },
      { listingId: 'l1', tipus: 'lakas', eszleltAt: 5000, nm2Ar: 1000 },
    ]
    const summary = buildMarketSummary(snapshots, pricePoints, [])

    expect(summary.haz_median_nm2).toBe(1000)
    expect(summary.lakas_median_nm2).toBe(1000)
    expect(summary.aktiv_db).toBe(3)
    expect(summary.utolso_frissites).toBe(new Date(5000 * 1000).toISOString())
  })

  it('a group with no listings reports null, not 0, for every stat field', () => {
    const summary = buildMarketSummary([snap({ tipus: 'lakas' })], [], [])
    expect(summary.haz_median_nm2).toBeNull()
    expect(summary.haz_avg_nm2).toBeNull()
    expect(summary.haz_min_nm2).toBeNull()
    expect(summary.haz_max_nm2).toBeNull()
  })

  it('utolso_frissites is null when there are no price points at all', () => {
    expect(buildMarketSummary([], [], []).utolso_frissites).toBeNull()
  })

  it('delta_*_pct is null with fewer than 2 months of trend data', () => {
    const oneMonth: TrendPoint[] = [{ datum: '2026-01', haz_nm2: 1000, lakas_nm2: 900 }]
    const summary = buildMarketSummary([], [], oneMonth)
    expect(summary.delta_haz_pct).toBeNull()
    expect(summary.delta_lakas_pct).toBeNull()
  })

  it('delta_*_pct is the % change between the last two trend months', () => {
    const trend: TrendPoint[] = [
      { datum: '2026-01', haz_nm2: 1000, lakas_nm2: 800 },
      { datum: '2026-02', haz_nm2: 1100, lakas_nm2: 760 },
    ]
    const summary = buildMarketSummary([], [], trend)
    expect(summary.delta_haz_pct).toBeCloseTo(10) // 1000 -> 1100 = +10%
    expect(summary.delta_lakas_pct).toBeCloseTo(-5) // 800 -> 760 = -5%
  })

  it('delta_*_pct is null when either of the last two months has no data for that tipus', () => {
    const trend: TrendPoint[] = [
      { datum: '2026-01', haz_nm2: 1000, lakas_nm2: null },
      { datum: '2026-02', haz_nm2: 1100, lakas_nm2: 760 },
    ]
    expect(buildMarketSummary([], [], trend).delta_lakas_pct).toBeNull()
  })
})
