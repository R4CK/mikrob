import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { openDb, recordSighting } from '../db.js'
import { getLatestSnapshots, getPriceHistoryPoints } from '../query.js'
import type { ScrapedListing } from '../types.js'

const listing = (overrides: Partial<ScrapedListing> = {}): ScrapedListing => ({
  id: 'x',
  url: 'https://ingatlan.com/x',
  tipus: 'lakas',
  allapot: null,
  epitesiEv: null,
  cim: null,
  alapteruletM2: null,
  ar: 1000,
  nm2Ar: 100,
  ...overrides,
})

describe('query adapters', () => {
  let db: Database.Database
  beforeEach(() => { db = openDb(':memory:') })
  afterEach(() => { db.close() })

  it('getLatestSnapshots returns the MOST RECENT price per listing, not the first', () => {
    recordSighting(db, listing({ id: 'a', ar: 1000, nm2Ar: 100 }), 1000)
    recordSighting(db, listing({ id: 'a', ar: 1200, nm2Ar: 120 }), 2000)
    recordSighting(db, listing({ id: 'b', tipus: 'haz', ar: 5000, nm2Ar: 50 }), 1000)

    const snapshots = getLatestSnapshots(db).sort((x, y) => x.id.localeCompare(y.id))
    expect(snapshots).toEqual([
      { id: 'a', url: 'https://ingatlan.com/x', tipus: 'lakas', nm2Ar: 120 },
      { id: 'b', url: 'https://ingatlan.com/x', tipus: 'haz', nm2Ar: 50 },
    ])
  })

  it('getPriceHistoryPoints returns every recorded row, chronologically, with tipus joined', () => {
    recordSighting(db, listing({ id: 'a', ar: 1000, nm2Ar: 100 }), 3000)
    recordSighting(db, listing({ id: 'a', ar: 1200, nm2Ar: 120 }), 1000) // out-of-order insert on purpose
    recordSighting(db, listing({ id: 'a', ar: 1300, nm2Ar: 130 }), 2000)

    // recordSighting compares against the LATEST-by-eszlelt_at row regardless of insert order, so
    // inserting 3000 first, then 1000, then 2000 still yields 3 distinct rows here (each price
    // differs from whatever was the max-eszlelt_at row at the time of that particular call).
    const points = getPriceHistoryPoints(db)
    expect(points.map((p) => p.eszleltAt)).toEqual([1000, 2000, 3000])
    expect(points.every((p) => p.tipus === 'lakas' && p.listingId === 'a')).toBe(true)
  })

  it('returns empty arrays for an empty DB', () => {
    expect(getLatestSnapshots(db)).toEqual([])
    expect(getPriceHistoryPoints(db)).toEqual([])
  })
})
