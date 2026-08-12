import type Database from 'better-sqlite3'
import type { Snapshot } from './analysis/stats.js'
import type { PricePoint } from './analysis/trend.js'

// Each listing's LATEST known price (the most recent price_history row), joined with its
// tipus/url -- the "current market" snapshot that stats.ts operates on.
export function getLatestSnapshots(db: Database.Database): Snapshot[] {
  return db
    .prepare(
      `SELECT l.id as id, l.url as url, l.tipus as tipus, ph.nm2_ar as nm2Ar
       FROM listings l
       JOIN price_history ph ON ph.listing_id = l.id
       WHERE ph.id = (
         SELECT id FROM price_history WHERE listing_id = l.id ORDER BY eszlelt_at DESC, id DESC LIMIT 1
       )`,
    )
    .all() as Snapshot[]
}

// The full price history (every recorded change, not just the latest), joined with tipus --
// trend.ts's dailyMedianSeries reconstructs the day-by-day market state from this.
export function getPriceHistoryPoints(db: Database.Database): PricePoint[] {
  return db
    .prepare(
      `SELECT ph.listing_id as listingId, l.tipus as tipus, ph.eszlelt_at as eszleltAt, ph.nm2_ar as nm2Ar
       FROM price_history ph
       JOIN listings l ON l.id = ph.listing_id
       ORDER BY ph.eszlelt_at`,
    )
    .all() as PricePoint[]
}
