import type { ListingWithHistory } from '../query.js'
import type { GroupStats } from '../analysis/stats.js'

export interface ListingArHistoryPoint {
  datum: string // ISO
  ar: number
}

export type MedianRel = 'belul' | 'folott' | 'alatt' | null

// Wire contract for the listing table + detail panel (card 9ca81f45, Fron Ted's design).
export interface Listing {
  id: string
  url: string
  tipus: 'haz' | 'lakas'
  cim: string | null
  alapterulet_m2: number | null
  ar: number
  nm2_ar: number
  delta_pct: number | null // vs the PREVIOUS recorded price, null if this is the only sighting
  median_rel: MedianRel // null when that tipus has no group median yet (nothing to compare to)
  ar_history: ListingArHistoryPoint[]
  elso_eszlelt_at: string // ISO
}

function classifyMedianRel(nm2Ar: number, median: number | null, bandPct: number): MedianRel {
  if (median === null) return null
  const lo = median * (1 - bandPct)
  const hi = median * (1 + bandPct)
  if (nm2Ar >= lo && nm2Ar <= hi) return 'belul'
  return nm2Ar > hi ? 'folott' : 'alatt'
}

export function buildListings(
  listings: ListingWithHistory[],
  groupedStats: { haz: GroupStats | null; lakas: GroupStats | null },
  bandPct = 0.05,
): Listing[] {
  return listings.map((l) => {
    const groupMedian = groupedStats[l.tipus]?.medianNm2Ar ?? null
    const history = l.arHistory
    const previous = history.length >= 2 ? history[history.length - 2] : null
    const deltaPct = previous && previous.ar !== 0 ? ((l.ar - previous.ar) / previous.ar) * 100 : null

    return {
      id: l.id,
      url: l.url,
      tipus: l.tipus,
      cim: l.cim,
      alapterulet_m2: l.alapteruletM2,
      ar: l.ar,
      nm2_ar: l.nm2Ar,
      delta_pct: deltaPct,
      median_rel: classifyMedianRel(l.nm2Ar, groupMedian, bandPct),
      ar_history: history.map((h) => ({ datum: new Date(h.eszleltAt * 1000).toISOString(), ar: h.ar })),
      elso_eszlelt_at: new Date(l.elsoEszleltAt * 1000).toISOString(),
    }
  })
}
