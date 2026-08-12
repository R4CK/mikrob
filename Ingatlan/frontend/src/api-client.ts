import type { MarketSummary, TrendPoint, Listing, IngestLogEntry } from './types.js'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { credentials: 'same-origin' })
  } catch {
    // The local backend is not reachable at all -- the OFFLINE state (DESIGN-IA.md section 4),
    // distinct from a real HTTP error response.
    throw new ApiError(0, 'nincs kapcsolat a helyi API-val')
  }
  if (res.status === 401) throw new ApiError(401, 'not authenticated')
  if (!res.ok) throw new ApiError(res.status, `request failed: ${res.status}`)
  return res.json() as Promise<T>
}

export const fetchMarketSummary = (): Promise<MarketSummary> => getJson<MarketSummary>('/api/market-summary')
export const fetchTrend = (): Promise<TrendPoint[]> => getJson<TrendPoint[]>('/api/trend')
export const fetchListings = (): Promise<Listing[]> => getJson<Listing[]>('/api/listings')
export const fetchIngestLog = (): Promise<IngestLogEntry[]> => getJson<IngestLogEntry[]>('/api/ingest-log')
