import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ScrapedListing } from './types.js'

export function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      tipus TEXT NOT NULL,
      allapot TEXT,
      epitesi_ev INTEGER,
      cim TEXT,
      alapterulet_m2 REAL,
      elso_eszlelt_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id TEXT NOT NULL REFERENCES listings(id),
      ar INTEGER NOT NULL,
      nm2_ar REAL NOT NULL,
      eszlelt_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS price_history_listing_time
      ON price_history(listing_id, eszlelt_at)
  `)
  return db
}

export interface SightingResult {
  isNewListing: boolean
  priceChanged: boolean
}

// Records one scrape-pass sighting of a listing:
// - unseen id -> insert into `listings`, and always record the first price_history row.
// - known id, price/nm2-price unchanged from the latest recorded row -> no new price_history row
//   (the whole point of the history table is CHANGES, not a row per scrape pass).
// - known id, price changed -> new price_history row.
export function recordSighting(
  db: Database.Database,
  listing: ScrapedListing,
  nowEpochSeconds: number,
): SightingResult {
  const existing = db.prepare('SELECT 1 FROM listings WHERE id = ?').get(listing.id)
  const isNewListing = !existing

  if (isNewListing) {
    db.prepare(
      `INSERT INTO listings (id, url, tipus, allapot, epitesi_ev, cim, alapterulet_m2, elso_eszlelt_at)
       VALUES (@id, @url, @tipus, @allapot, @epitesiEv, @cim, @alapteruletM2, @nowEpochSeconds)`,
    ).run({ ...listing, nowEpochSeconds })
  }

  const latest = db
    .prepare(
      'SELECT ar, nm2_ar FROM price_history WHERE listing_id = ? ORDER BY eszlelt_at DESC, id DESC LIMIT 1',
    )
    .get(listing.id) as { ar: number; nm2_ar: number } | undefined

  const priceChanged = !latest || latest.ar !== listing.ar || latest.nm2_ar !== listing.nm2Ar

  if (priceChanged) {
    db.prepare(
      'INSERT INTO price_history (listing_id, ar, nm2_ar, eszlelt_at) VALUES (?, ?, ?, ?)',
    ).run(listing.id, listing.ar, listing.nm2Ar, nowEpochSeconds)
  }

  return { isNewListing, priceChanged: !isNewListing && priceChanged }
}
