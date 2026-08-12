import type { IngatlanTipus } from '../types.js'

// A listing's CURRENT (latest known) price snapshot -- one row per listing, not per price_history
// entry. Market stats are computed over "what is the market right now", not over every historical
// price ever recorded.
export interface Snapshot {
  id: string
  url: string
  tipus: IngatlanTipus
  nm2Ar: number
}

export interface GroupStats {
  count: number
  avgNm2Ar: number
  medianNm2Ar: number
  minNm2Ar: number
  maxNm2Ar: number
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// null (not a zeroed-out GroupStats) for an empty group -- there is no "average of nothing",
// and a stray 0 would silently look like a real, very-cheap market.
export function computeStats(nm2ArValues: number[]): GroupStats | null {
  if (nm2ArValues.length === 0) return null
  return {
    count: nm2ArValues.length,
    avgNm2Ar: nm2ArValues.reduce((a, b) => a + b, 0) / nm2ArValues.length,
    medianNm2Ar: median(nm2ArValues),
    minNm2Ar: Math.min(...nm2ArValues),
    maxNm2Ar: Math.max(...nm2ArValues),
  }
}

export interface GroupedStats {
  haz: GroupStats | null
  lakas: GroupStats | null
  combined: GroupStats | null
}

export function groupedMarketStats(snapshots: Snapshot[]): GroupedStats {
  const byTipus = (tipus: IngatlanTipus) =>
    computeStats(snapshots.filter((s) => s.tipus === tipus).map((s) => s.nm2Ar))
  return {
    haz: byTipus('haz'),
    lakas: byTipus('lakas'),
    combined: computeStats(snapshots.map((s) => s.nm2Ar)),
  }
}

// Listings whose nm2Ar falls within +-bandPct of the given median (default 5%, per the card).
export function listingsWithinBand(snapshots: Snapshot[], medianNm2Ar: number, bandPct = 0.05): Snapshot[] {
  const lo = medianNm2Ar * (1 - bandPct)
  const hi = medianNm2Ar * (1 + bandPct)
  return snapshots.filter((s) => s.nm2Ar >= lo && s.nm2Ar <= hi)
}
