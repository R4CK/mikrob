import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { openDb, recordSighting, recordIngestRun } from '../db.js'
import { getLatestSnapshots, getPriceHistoryPoints, getListingsWithHistory, getIngestLog } from '../query.js'
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

  describe('getListingsWithHistory', () => {
    it('returns the descriptive fields, the CURRENT price, and the full history in order', () => {
      recordSighting(
        db,
        listing({ id: 'a', cim: 'Budapest II. ker.', alapteruletM2: 65, ar: 1000, nm2Ar: 100 }),
        1000,
      )
      recordSighting(db, listing({ id: 'a', ar: 1200, nm2Ar: 120 }), 2000)

      const [row] = getListingsWithHistory(db)
      expect(row.id).toBe('a')
      expect(row.cim).toBe('Budapest II. ker.')
      expect(row.alapteruletM2).toBe(65)
      expect(row.elsoEszleltAt).toBe(1000)
      // current price is the LATEST, not the first
      expect(row.ar).toBe(1200)
      expect(row.nm2Ar).toBe(120)
      expect(row.arHistory).toEqual([
        { ar: 1000, nm2Ar: 100, eszleltAt: 1000 },
        { ar: 1200, nm2Ar: 120, eszleltAt: 2000 },
      ])
    })

    it('a listing with no price change has a ONE-entry history, not a duplicate', () => {
      recordSighting(db, listing({ id: 'a', ar: 1000, nm2Ar: 100 }), 1000)
      recordSighting(db, listing({ id: 'a', ar: 1000, nm2Ar: 100 }), 2000) // unchanged re-sighting

      const [row] = getListingsWithHistory(db)
      expect(row.arHistory).toHaveLength(1)
    })

    it('multiple listings are each returned with their OWN history', () => {
      recordSighting(db, listing({ id: 'a', tipus: 'haz', ar: 1000, nm2Ar: 100 }), 1000)
      recordSighting(db, listing({ id: 'b', tipus: 'lakas', ar: 2000, nm2Ar: 200 }), 1000)

      const rows = getListingsWithHistory(db).sort((x, y) => x.id.localeCompare(y.id))
      expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
      expect(rows[0].tipus).toBe('haz')
      expect(rows[1].tipus).toBe('lakas')
    })

    it('returns an empty array for an empty DB', () => {
      expect(getListingsWithHistory(db)).toEqual([])
    })
  })

  describe('getIngestLog', () => {
    it('returns runs newest-first', () => {
      recordIngestRun(db, { ok: true, newListings: 1, priceChanges: 0, rejectedCount: 0, error: null }, 1000)
      recordIngestRun(db, { ok: true, newListings: 2, priceChanges: 0, rejectedCount: 0, error: null }, 2000)
      const rows = getIngestLog(db)
      expect(rows.map((r) => r.ranAt)).toEqual([2000, 1000])
    })

    it('respects the limit', () => {
      recordIngestRun(db, { ok: true, newListings: 0, priceChanges: 0, rejectedCount: 0, error: null }, 1000)
      recordIngestRun(db, { ok: true, newListings: 0, priceChanges: 0, rejectedCount: 0, error: null }, 2000)
      expect(getIngestLog(db, 1)).toHaveLength(1)
    })

    it('returns an empty array when no runs are logged', () => {
      expect(getIngestLog(db)).toEqual([])
    })
  })
})
