// Composition root for the daily scrape (card 61283865, 1/4). Wires the real HTTP layer,
// robots.txt check, DB, and the (currently stubbed, see parser.ts) real-page parser together.
//
// BLOCKED on two things -- see README.md "Blokkolt":
//   1. The two real ingatlan.com search URLs are not in the card/epic description. Read from
//      env vars below rather than hardcoded, so this fails loudly and specifically instead of
//      silently scraping nothing (or something wrong) once someone fills them in.
//   2. parseSearchResultsHtml() (parser.ts) throws NotImplementedError -- the real ingatlan.com
//      page structure hasn't been inspected (egress-allowlist blocks it, see README).
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.js'
import { isAllowedByRobots } from './robots.js'
import { createRateLimitedFetcher } from './http.js'
import { runScrapeCycle, type ScrapeSource } from './scraper.js'
import { parseSearchResultsHtml } from './parser.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(HERE, '..', 'data', 'ingatlan.db')
const USER_AGENT = 'IngatlanArkovetoBot/1.0 (personal, non-commercial use)'
const MIN_INTERVAL_MS = 3000

function requireSources(): ScrapeSource[] {
  const haz = process.env.INGATLAN_SEARCH_URL_HAZ
  const lakas = process.env.INGATLAN_SEARCH_URL_LAKAS
  if (!haz || !lakas) {
    throw new Error(
      'INGATLAN_SEARCH_URL_HAZ / INGATLAN_SEARCH_URL_LAKAS is not set. These are the two real ' +
        'ingatlan.com search URLs (missing from card 61283865 / epic 6c69851f -- see README.md ' +
        '"Blokkolt"). Set them in Ingatlan/.env (gitignored) or the environment before running.',
    )
  }
  return [
    { url: haz, tipus: 'haz' },
    { url: lakas, tipus: 'lakas' },
  ]
}

async function main(): Promise<void> {
  const sources = requireSources()
  const fetchText = createRateLimitedFetcher({ userAgent: USER_AGENT, minIntervalMs: MIN_INTERVAL_MS })

  const origin = new URL(sources[0].url).origin
  const robots = await fetchText(`${origin}/robots.txt`)
  if (robots.status < 200 || robots.status >= 300) {
    // Fail closed: if robots.txt cannot be retrieved, do not assume permission to scrape.
    throw new Error(`Could not fetch ${origin}/robots.txt (status ${robots.status}) -- refusing to scrape.`)
  }
  const isPathAllowed = (path: string) => isAllowedByRobots(robots.body, USER_AGENT, path)

  const db = openDb(DB_PATH)
  try {
    const results = await runScrapeCycle(sources, {
      fetchHtml: async (url) => {
        const res = await fetchText(url)
        if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} fetching ${url}`)
        return res.body
      },
      parseHtml: parseSearchResultsHtml,
      db,
      now: Date.now,
      isPathAllowed,
    })

    for (const r of results) {
      if (r.skippedByRobots) {
        console.log(`[ingatlan] SKIPPED (robots.txt disallows) ${r.source.url}`)
      } else if (r.error) {
        console.error(`[ingatlan] ERROR ${r.source.url}: ${r.error}`)
      } else {
        console.log(
          `[ingatlan] ${r.source.tipus}: ${r.totalSeen} hirdetés, ${r.newListings} új, ${r.priceChanges} ár-változás`,
        )
      }
    }
    if (results.some((r) => r.error)) process.exitCode = 1
  } finally {
    db.close()
  }
}

main().catch((err) => {
  console.error('[ingatlan] fatal:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
