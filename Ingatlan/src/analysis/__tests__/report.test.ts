import { describe, it, expect } from 'vitest'
import { analyzeMarket } from '../report.js'
import type { Snapshot } from '../stats.js'
import type { PricePoint } from '../trend.js'

const DAY = 86400

describe('analyzeMarket', () => {
  it('assembles stats + band + forecast per group, and combined includes both tipus', () => {
    const snapshots: Snapshot[] = [
      { id: 'h1', url: 'https://ingatlan.com/h1', tipus: 'haz', nm2Ar: 900 },
      { id: 'h2', url: 'https://ingatlan.com/h2', tipus: 'haz', nm2Ar: 1100 },
      { id: 'l1', url: 'https://ingatlan.com/l1', tipus: 'lakas', nm2Ar: 1000 },
    ]
    const pricePoints: PricePoint[] = [
      { listingId: 'h1', tipus: 'haz', eszleltAt: 0, nm2Ar: 900 },
      { listingId: 'h2', tipus: 'haz', eszleltAt: 0, nm2Ar: 1100 },
      { listingId: 'l1', tipus: 'lakas', eszleltAt: 0, nm2Ar: 1000 },
    ]

    const report = analyzeMarket(snapshots, pricePoints)

    expect(report.haz.stats).toMatchObject({ count: 2, medianNm2Ar: 1000 })
    expect(report.lakas.stats).toMatchObject({ count: 1, medianNm2Ar: 1000 })
    expect(report.combined.stats).toMatchObject({ count: 3, medianNm2Ar: 1000 })
    // h1 (900) is exactly -10% off the haz median (1000) -> outside the default 5% band.
    expect(report.haz.withinBand.map((s) => s.id)).toEqual([])
    expect(report.lakas.withinBand.map((s) => s.id)).toEqual(['l1'])
  })

  it('a group with no listings of that tipus reports null stats, no band, no forecast', () => {
    const snapshots: Snapshot[] = [{ id: 'l1', url: 'https://ingatlan.com/l1', tipus: 'lakas', nm2Ar: 1000 }]
    const report = analyzeMarket(snapshots, [])
    expect(report.haz).toEqual({ stats: null, withinBand: [], forecast: null })
  })

  it('forecast is insufficient-data with too little history, ok once minDaysRequired is met', () => {
    const snapshots: Snapshot[] = [{ id: 'l1', url: 'https://ingatlan.com/l1', tipus: 'lakas', nm2Ar: 1000 }]
    const shortHistory: PricePoint[] = [{ listingId: 'l1', tipus: 'lakas', eszleltAt: 0, nm2Ar: 1000 }]
    const shortReport = analyzeMarket(snapshots, shortHistory, { minDaysRequired: 14 })
    expect(shortReport.lakas.forecast).toMatchObject({ status: 'insufficient-data' })

    const longHistory: PricePoint[] = Array.from({ length: 14 }, (_, i) => ({
      listingId: 'l1',
      tipus: 'lakas' as const,
      eszleltAt: i * DAY,
      nm2Ar: 1000 + i * 5,
    }))
    const longReport = analyzeMarket(snapshots, longHistory, { minDaysRequired: 14 })
    expect(longReport.lakas.forecast).toMatchObject({ status: 'ok' })
  })

  it('respects a custom bandPct option', () => {
    const snapshots: Snapshot[] = [
      { id: 'a', url: 'https://ingatlan.com/a', tipus: 'lakas', nm2Ar: 900 },
      { id: 'b', url: 'https://ingatlan.com/b', tipus: 'lakas', nm2Ar: 1000 },
    ]
    const report = analyzeMarket(snapshots, [], { bandPct: 0.2 })
    expect(report.lakas.withinBand.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })
})
