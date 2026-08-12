import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { openDb, recordSighting } from '../../db.js'
import { handleApiRoute } from '../api-routes.js'
import type { ScrapedListing } from '../../types.js'

const listing = (overrides: Partial<ScrapedListing> = {}): ScrapedListing => ({
  id: 'x',
  url: 'https://ingatlan.com/x',
  tipus: 'lakas',
  allapot: null,
  epitesiEv: null,
  cim: 'Budapest II. ker.',
  alapteruletM2: 65,
  ar: 80_000_000,
  nm2Ar: 1_230_769,
  ...overrides,
})

describe('handleApiRoute', () => {
  let db: Database.Database
  beforeEach(() => { db = openDb(':memory:') })
  afterEach(() => { db.close() })

  it('GET /api/trend returns 200 with the trend series built from real DB data', () => {
    recordSighting(db, listing({ id: 'a' }), 1000)
    const result = handleApiRoute(db, 'GET', '/api/trend')
    expect(result?.status).toBe(200)
    expect(Array.isArray(result?.body)).toBe(true)
    expect((result?.body as unknown[]).length).toBeGreaterThan(0)
  })

  it('GET /api/market-summary returns 200 with a real, populated summary', () => {
    recordSighting(db, listing({ id: 'a', tipus: 'haz', nm2Ar: 1000 }), 1000)
    const result = handleApiRoute(db, 'GET', '/api/market-summary')
    expect(result?.status).toBe(200)
    expect(result?.body).toMatchObject({ aktiv_db: 1, haz_median_nm2: 1000 })
  })

  it('GET /api/listings returns 200 with the real listing including its history', () => {
    recordSighting(db, listing({ id: 'a', cim: 'Teszt utca 1.' }), 1000)
    const result = handleApiRoute(db, 'GET', '/api/listings')
    expect(result?.status).toBe(200)
    const body = result?.body as Array<{ id: string; cim: string | null }>
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ id: 'a', cim: 'Teszt utca 1.' })
  })

  it('all three endpoints work correctly against an EMPTY database (no crash, no fake data)', () => {
    expect(handleApiRoute(db, 'GET', '/api/trend')?.body).toEqual([])
    expect(handleApiRoute(db, 'GET', '/api/market-summary')?.body).toMatchObject({ aktiv_db: 0, haz_median_nm2: null })
    expect(handleApiRoute(db, 'GET', '/api/listings')?.body).toEqual([])
  })

  it('returns null (unhandled) for an unknown path', () => {
    expect(handleApiRoute(db, 'GET', '/api/nope')).toBeNull()
  })

  it('returns null (unhandled) for a non-GET method, even on a known path', () => {
    expect(handleApiRoute(db, 'POST', '/api/trend')).toBeNull()
    expect(handleApiRoute(db, 'DELETE', '/api/listings')).toBeNull()
  })
})
