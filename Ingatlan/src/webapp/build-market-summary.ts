import { groupedMarketStats, type Snapshot } from '../analysis/stats.js'
import type { PricePoint } from '../analysis/trend.js'
import type { TrendPoint } from './build-trend-points.js'

// Wire contract for the KPI strip (card 9ca81f45, Fron Ted's design). Every *_nm2 field is
// nullable rather than 0 when a group has no listings yet -- a fabricated 0 would read as "the
// market is free", not "no data"; the frontend's Empty state (DESIGN-IA.md section 4) is what
// should render instead. Raw HUF throughout, same reasoning as build-trend-points.ts.
export interface MarketSummary {
  haz_median_nm2: number | null
  lakas_median_nm2: number | null
  haz_avg_nm2: number | null
  lakas_avg_nm2: number | null
  haz_min_nm2: number | null
  lakas_min_nm2: number | null
  haz_max_nm2: number | null
  lakas_max_nm2: number | null
  aktiv_db: number
  utolso_frissites: string | null // ISO, or null if nothing has ever been recorded
  delta_haz_pct: number | null // month-over-month change, null until 2 months of trend data exist
  delta_lakas_pct: number | null
}

function pctChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null || from === 0) return null
  return ((to - from) / from) * 100
}

export function buildMarketSummary(
  snapshots: Snapshot[],
  pricePoints: PricePoint[],
  trendPoints: TrendPoint[],
): MarketSummary {
  const grouped = groupedMarketStats(snapshots)
  const [prevMonth, curMonth] = trendPoints.length >= 2 ? trendPoints.slice(-2) : [null, null]
  const latestEszleltAt = pricePoints.reduce<number | null>(
    (max, p) => (max === null || p.eszleltAt > max ? p.eszleltAt : max),
    null,
  )

  return {
    haz_median_nm2: grouped.haz?.medianNm2Ar ?? null,
    lakas_median_nm2: grouped.lakas?.medianNm2Ar ?? null,
    haz_avg_nm2: grouped.haz?.avgNm2Ar ?? null,
    lakas_avg_nm2: grouped.lakas?.avgNm2Ar ?? null,
    haz_min_nm2: grouped.haz?.minNm2Ar ?? null,
    lakas_min_nm2: grouped.lakas?.minNm2Ar ?? null,
    haz_max_nm2: grouped.haz?.maxNm2Ar ?? null,
    lakas_max_nm2: grouped.lakas?.maxNm2Ar ?? null,
    aktiv_db: snapshots.length,
    utolso_frissites: latestEszleltAt === null ? null : new Date(latestEszleltAt * 1000).toISOString(),
    delta_haz_pct: pctChange(prevMonth?.haz_nm2 ?? null, curMonth?.haz_nm2 ?? null),
    delta_lakas_pct: pctChange(prevMonth?.lakas_nm2 ?? null, curMonth?.lakas_nm2 ?? null),
  }
}
