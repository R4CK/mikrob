import type Database from 'better-sqlite3'
import { recordSighting } from './db.js'
import type { IngatlanTipus, ScrapedListing } from './types.js'

export interface ScrapeSource {
  url: string
  tipus: IngatlanTipus
}

export type FetchHtml = (url: string) => Promise<string>
export type ParseHtml = (html: string, tipus: IngatlanTipus) => ScrapedListing[]

export interface ScrapeCyclePorts {
  fetchHtml: FetchHtml
  parseHtml: ParseHtml
  db: Database.Database
  now: () => number
  // Optional: checked against each source's path before fetching. Omit only in tests that don't
  // care about robots.txt; the real composition root (run.ts) always provides it.
  isPathAllowed?: (path: string) => boolean
}

export interface ScrapeCycleResult {
  source: ScrapeSource
  totalSeen: number
  newListings: number
  priceChanges: number
  skippedByRobots?: boolean
  error?: string
}

function pathOf(url: string): string {
  const parsed = new URL(url)
  return parsed.pathname + parsed.search
}

// Pure orchestration of one scrape pass over all configured sources: fetch, parse, and reconcile
// each listing into the DB's price history. fetchHtml/parseHtml are injected ports so this whole
// dedup/new-vs-price-changed decision flow is testable without a real HTTP call or a real parser.
// One source's failure does not abort the others (a transient fetch error on the "ház" URL must
// not also skip the independent "lakás" source).
export async function runScrapeCycle(
  sources: ScrapeSource[],
  ports: ScrapeCyclePorts,
): Promise<ScrapeCycleResult[]> {
  const results: ScrapeCycleResult[] = []

  for (const source of sources) {
    if (ports.isPathAllowed && !ports.isPathAllowed(pathOf(source.url))) {
      results.push({ source, totalSeen: 0, newListings: 0, priceChanges: 0, skippedByRobots: true })
      continue
    }
    try {
      const html = await ports.fetchHtml(source.url)
      const listings = ports.parseHtml(html, source.tipus)
      const nowEpochSeconds = Math.floor(ports.now() / 1000)
      let newListings = 0
      let priceChanges = 0
      for (const listing of listings) {
        const outcome = recordSighting(ports.db, listing, nowEpochSeconds)
        if (outcome.isNewListing) newListings++
        if (outcome.priceChanged) priceChanges++
      }
      results.push({ source, totalSeen: listings.length, newListings, priceChanges })
    } catch (err) {
      results.push({
        source,
        totalSeen: 0,
        newListings: 0,
        priceChanges: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return results
}
