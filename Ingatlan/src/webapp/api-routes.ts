import type Database from 'better-sqlite3'
import { getLatestSnapshots, getPriceHistoryPoints, getListingsWithHistory, getIngestLog } from '../query.js'
import { groupedMarketStats } from '../analysis/stats.js'
import { buildTrendPoints } from './build-trend-points.js'
import { buildMarketSummary } from './build-market-summary.js'
import { buildListings } from './build-listings.js'
import { buildIngestLog } from './build-ingest-log.js'

export interface ApiRouteResult {
  status: number
  body: unknown
}

// Pure route dispatch: GET only, three read-only endpoints, no side effects. Returns null for
// anything unhandled so the caller (createApiServer below, or the eventual auth-wrapped webapp
// server in 426da6c1) can fall through to its own 404/other routes -- this function does not own
// the whole server, only these three paths.
export function handleApiRoute(db: Database.Database, method: string, pathname: string): ApiRouteResult | null {
  if (method !== 'GET') return null

  if (pathname === '/api/trend') {
    return { status: 200, body: buildTrendPoints(getPriceHistoryPoints(db)) }
  }

  if (pathname === '/api/market-summary') {
    const snapshots = getLatestSnapshots(db)
    const pricePoints = getPriceHistoryPoints(db)
    return { status: 200, body: buildMarketSummary(snapshots, pricePoints, buildTrendPoints(pricePoints)) }
  }

  if (pathname === '/api/listings') {
    const grouped = groupedMarketStats(getLatestSnapshots(db))
    return { status: 200, body: buildListings(getListingsWithHistory(db), grouped) }
  }

  if (pathname === '/api/ingest-log') {
    return { status: 200, body: buildIngestLog(getIngestLog(db)) }
  }

  return null
}
