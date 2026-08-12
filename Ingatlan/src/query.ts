import type Database from 'better-sqlite3'
import type { Snapshot } from './analysis/stats.js'
import type { PricePoint } from './analysis/trend.js'
import type { IngatlanTipus } from './types.js'

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

export interface ArHistoryEntry {
  ar: number
  nm2Ar: number
  eszleltAt: number
}

// A listing's full record (not just its current price) -- id/url/tipus plus the descriptive
// fields from `listings`, its CURRENT price (the last entry of arHistory), and the complete
// price_history so the webapp (3d04350b) can render a per-listing price chart and a "did the
// price drop or rise" delta. arHistory is always non-empty: db.ts's recordSighting() writes one
// on first sighting, so a listings row can never exist without at least one price_history row.
export interface ListingWithHistory {
  id: string
  url: string
  tipus: IngatlanTipus
  allapot: string | null
  cim: string | null
  alapteruletM2: number | null
  elsoEszleltAt: number
  ar: number
  nm2Ar: number
  arHistory: ArHistoryEntry[]
}

export function getListingsWithHistory(db: Database.Database): ListingWithHistory[] {
  const listings = db
    .prepare(
      `SELECT id, url, tipus, allapot, cim, alapterulet_m2 as alapteruletM2, elso_eszlelt_at as elsoEszleltAt
       FROM listings`,
    )
    .all() as Array<{
    id: string
    url: string
    tipus: IngatlanTipus
    allapot: string | null
    cim: string | null
    alapteruletM2: number | null
    elsoEszleltAt: number
  }>

  const historyStmt = db.prepare(
    'SELECT ar, nm2_ar as nm2Ar, eszlelt_at as eszleltAt FROM price_history WHERE listing_id = ? ORDER BY eszlelt_at',
  )

  return listings.map((l) => {
    const arHistory = historyStmt.all(l.id) as ArHistoryEntry[]
    const latest = arHistory[arHistory.length - 1]
    return { ...l, ar: latest.ar, nm2Ar: latest.nm2Ar, arHistory }
  })
}

export interface IngestLogRow {
  ranAt: number
  ok: boolean
  newListings: number
  priceChanges: number
  rejectedCount: number
  error: string | null
}

// Napló (DESIGN-IA.md section 3.3): most recent run first. `limit` bounds the payload -- the log
// grows one row per extension POST forever, and the UI only ever shows a chronological list, not
// a full-history report.
export function getIngestLog(db: Database.Database, limit = 100): IngestLogRow[] {
  const rows = db
    .prepare(
      `SELECT ran_at as ranAt, ok, new_listings as newListings, price_changes as priceChanges,
              rejected_count as rejectedCount, error
       FROM ingest_log ORDER BY ran_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as Array<Omit<IngestLogRow, 'ok'> & { ok: number }>
  return rows.map((r) => ({ ...r, ok: r.ok === 1 }))
}
