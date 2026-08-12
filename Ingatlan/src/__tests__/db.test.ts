import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, recordSighting } from '../db.js'
import type { ScrapedListing } from '../types.js'

const listing = (overrides: Partial<ScrapedListing> = {}): ScrapedListing => ({
  id: 'abc123',
  url: 'https://ingatlan.com/abc123',
  tipus: 'lakas',
  allapot: 'jó állapotú',
  epitesiEv: 1990,
  cim: 'Budapest II. ker.',
  alapteruletM2: 65,
  ar: 80_000_000,
  nm2Ar: 1_230_769,
  ...overrides,
})

describe('Ingatlan db', () => {
  let dir: string
  let db: Database.Database

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ingatlan-db-'))
    db = openDb(join(dir, 'test.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a first sighting of an unknown id inserts the listing and one price_history row', () => {
    const result = recordSighting(db, listing(), 1000)
    expect(result).toEqual({ isNewListing: true, priceChanged: false })

    const rows = db.prepare('SELECT * FROM listings WHERE id = ?').all('abc123')
    expect(rows).toHaveLength(1)
    const history = db.prepare('SELECT * FROM price_history WHERE listing_id = ?').all('abc123')
    expect(history).toHaveLength(1)
    expect((history[0] as { ar: number }).ar).toBe(80_000_000)
  })

  it('re-sighting the SAME price does NOT insert a new price_history row', () => {
    recordSighting(db, listing(), 1000)
    const result = recordSighting(db, listing(), 2000) // same price, later timestamp

    expect(result).toEqual({ isNewListing: false, priceChanged: false })
    const history = db.prepare('SELECT * FROM price_history WHERE listing_id = ?').all('abc123')
    expect(history).toHaveLength(1) // still just the original row
  })

  it('re-sighting with a CHANGED price inserts a second price_history row, listing row untouched', () => {
    recordSighting(db, listing({ ar: 80_000_000, nm2Ar: 1_230_769 }), 1000)
    const result = recordSighting(db, listing({ ar: 78_000_000, nm2Ar: 1_200_000 }), 2000)

    expect(result).toEqual({ isNewListing: false, priceChanged: true })
    const listingsRows = db.prepare('SELECT * FROM listings WHERE id = ?').all('abc123')
    expect(listingsRows).toHaveLength(1) // no duplicate listing row
    const history = db
      .prepare('SELECT ar, nm2_ar, eszlelt_at FROM price_history WHERE listing_id = ? ORDER BY eszlelt_at')
      .all('abc123')
    expect(history).toEqual([
      { ar: 80_000_000, nm2_ar: 1_230_769, eszlelt_at: 1000 },
      { ar: 78_000_000, nm2_ar: 1_200_000, eszlelt_at: 2000 },
    ])
  })

  it('a change in nm2Ar alone (e.g. a corrected area) also counts as a price change', () => {
    recordSighting(db, listing({ ar: 80_000_000, nm2Ar: 1_230_769 }), 1000)
    const result = recordSighting(db, listing({ ar: 80_000_000, nm2Ar: 1_000_000 }), 2000)
    expect(result.priceChanged).toBe(true)
  })

  it('two different listing ids are tracked independently', () => {
    recordSighting(db, listing({ id: 'a', ar: 1 }), 1000)
    recordSighting(db, listing({ id: 'b', ar: 2 }), 1000)
    expect(db.prepare('SELECT COUNT(*) c FROM listings').get()).toEqual({ c: 2 })
  })

  it('reopening the DB at the same path preserves data (schema is idempotent, not re-created empty)', () => {
    recordSighting(db, listing(), 1000)
    db.close()
    const reopened = openDb(join(dir, 'test.db'))
    const rows = reopened.prepare('SELECT * FROM listings').all()
    expect(rows).toHaveLength(1)
    reopened.close()
  })
})
