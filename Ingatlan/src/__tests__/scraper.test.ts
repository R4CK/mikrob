import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { openDb } from '../db.js'
import { runScrapeCycle } from '../scraper.js'
import type { ScrapedListing } from '../types.js'

const listing = (overrides: Partial<ScrapedListing> = {}): ScrapedListing => ({
  id: 'l1',
  url: 'https://ingatlan.com/l1',
  tipus: 'lakas',
  allapot: null,
  epitesiEv: null,
  cim: null,
  alapteruletM2: null,
  ar: 1000,
  nm2Ar: 100,
  ...overrides,
})

describe('runScrapeCycle', () => {
  let db: Database.Database
  beforeEach(() => { db = openDb(':memory:') })
  afterEach(() => { db.close() })

  it('fetches, parses, and records each source, returning accurate per-source counts', async () => {
    const fetchHtml = vi.fn(async (url: string) => `<html for ${url}>`)
    const parseHtml = vi.fn((_html: string, tipus: string) => [
      listing({ id: 'a', tipus: tipus as 'haz' | 'lakas' }),
      listing({ id: 'b', tipus: tipus as 'haz' | 'lakas' }),
    ])

    const results = await runScrapeCycle(
      [
        { url: 'https://ingatlan.com/haz-search', tipus: 'haz' },
        { url: 'https://ingatlan.com/lakas-search', tipus: 'lakas' },
      ],
      { fetchHtml, parseHtml, db, now: () => 1000 },
    )

    expect(fetchHtml).toHaveBeenCalledWith('https://ingatlan.com/haz-search')
    expect(fetchHtml).toHaveBeenCalledWith('https://ingatlan.com/lakas-search')
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ totalSeen: 2, newListings: 2, priceChanges: 0 })
    expect(results[1]).toMatchObject({ totalSeen: 2, newListings: 2, priceChanges: 0 })
  })

  it('a re-scrape with unchanged prices reports zero new listings and zero price changes', async () => {
    const fetchHtml = vi.fn(async () => '<html>')
    const parseHtml = vi.fn(() => [listing({ ar: 500, nm2Ar: 50 })])
    const source = [{ url: 'https://ingatlan.com/x', tipus: 'lakas' as const }]

    await runScrapeCycle(source, { fetchHtml, parseHtml, db, now: () => 1000 })
    const second = await runScrapeCycle(source, { fetchHtml, parseHtml, db, now: () => 2000 })

    expect(second[0]).toMatchObject({ totalSeen: 1, newListings: 0, priceChanges: 0 })
  })

  it('a price change on a known listing is reported as priceChanges, not newListings', async () => {
    const fetchHtml = vi.fn(async () => '<html>')
    let currentAr = 500
    const parseHtml = vi.fn(() => [listing({ ar: currentAr, nm2Ar: currentAr / 10 })])
    const source = [{ url: 'https://ingatlan.com/x', tipus: 'lakas' as const }]

    await runScrapeCycle(source, { fetchHtml, parseHtml, db, now: () => 1000 })
    currentAr = 600
    const second = await runScrapeCycle(source, { fetchHtml, parseHtml, db, now: () => 2000 })

    expect(second[0]).toMatchObject({ totalSeen: 1, newListings: 0, priceChanges: 1 })
  })

  it('a fetch failure on one source is captured in its result WITHOUT aborting the other source', async () => {
    const fetchHtml = vi.fn(async (url: string) => {
      if (url.includes('broken')) throw new Error('ECONNRESET')
      return '<html>'
    })
    const parseHtml = vi.fn(() => [listing()])

    const results = await runScrapeCycle(
      [
        { url: 'https://ingatlan.com/broken', tipus: 'haz' },
        { url: 'https://ingatlan.com/ok', tipus: 'lakas' },
      ],
      { fetchHtml, parseHtml, db, now: () => 1000 },
    )

    expect(results[0]).toMatchObject({ error: 'ECONNRESET', totalSeen: 0 })
    expect(results[1]).toMatchObject({ totalSeen: 1, newListings: 1 })
  })

  it('a source whose path is disallowed by robots.txt is skipped WITHOUT ever calling fetchHtml', async () => {
    const fetchHtml = vi.fn(async () => '<html>')
    const parseHtml = vi.fn(() => [listing()])

    const results = await runScrapeCycle(
      [{ url: 'https://ingatlan.com/admin-search', tipus: 'haz' }],
      { fetchHtml, parseHtml, db, now: () => 1000, isPathAllowed: (path) => !path.startsWith('/admin') },
    )

    expect(fetchHtml).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({ skippedByRobots: true, totalSeen: 0 })
  })

  it('an allowed path is fetched normally when isPathAllowed is provided', async () => {
    const fetchHtml = vi.fn(async () => '<html>')
    const parseHtml = vi.fn(() => [listing()])

    const results = await runScrapeCycle(
      [{ url: 'https://ingatlan.com/szukites/lakas', tipus: 'lakas' }],
      { fetchHtml, parseHtml, db, now: () => 1000, isPathAllowed: (path) => !path.startsWith('/admin') },
    )

    expect(fetchHtml).toHaveBeenCalledWith('https://ingatlan.com/szukites/lakas')
    expect(results[0].skippedByRobots).toBeUndefined()
  })
})
