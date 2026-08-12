import { groupedMarketStats, listingsWithinBand, type GroupStats, type Snapshot } from './stats.js'
import { dailyMedianSeries, forecastTrend, type ForecastResult, type PricePoint } from './trend.js'
import type { IngatlanTipus } from '../types.js'

export interface GroupReport {
  stats: GroupStats | null
  withinBand: Snapshot[]
  forecast: ForecastResult | null
}

export interface MarketReport {
  haz: GroupReport
  lakas: GroupReport
  combined: GroupReport
}

export interface AnalyzeMarketOptions {
  bandPct?: number
  minDaysRequired?: number
  forecastDaysAhead?: number
}

// Assembles the card's three asks (grouped stats, +-band listing, trend forecast) for each of
// haz/lakas/combined. Pure function over already-queried data (query.ts) -- no DB access here,
// so this is directly testable with fixtures.
export function analyzeMarket(
  snapshots: Snapshot[],
  pricePoints: PricePoint[],
  opts: AnalyzeMarketOptions = {},
): MarketReport {
  const bandPct = opts.bandPct ?? 0.05
  const minDaysRequired = opts.minDaysRequired ?? 14
  const forecastDaysAhead = opts.forecastDaysAhead ?? 180
  const grouped = groupedMarketStats(snapshots)

  const buildGroup = (tipus: IngatlanTipus | 'combined'): GroupReport => {
    const stats = tipus === 'combined' ? grouped.combined : grouped[tipus]
    if (!stats) return { stats: null, withinBand: [], forecast: null }
    const relevantSnapshots = tipus === 'combined' ? snapshots : snapshots.filter((s) => s.tipus === tipus)
    const series = dailyMedianSeries(pricePoints, tipus)
    return {
      stats,
      withinBand: listingsWithinBand(relevantSnapshots, stats.medianNm2Ar, bandPct),
      forecast: forecastTrend(series, { minDaysRequired, forecastDaysAhead }),
    }
  }

  return { haz: buildGroup('haz'), lakas: buildGroup('lakas'), combined: buildGroup('combined') }
}
