import type { IngestLogRow } from '../query.js'

// Wire contract for Napló (card 1f51f050, DESIGN-IA.md section 3.3).
export interface IngestLogEntry {
  ran_at: string // ISO
  ok: boolean
  new_listings: number
  price_changes: number
  rejected_count: number
  error: string | null
}

export function buildIngestLog(rows: IngestLogRow[]): IngestLogEntry[] {
  return rows.map((r) => ({
    ran_at: new Date(r.ranAt * 1000).toISOString(),
    ok: r.ok,
    new_listings: r.newListings,
    price_changes: r.priceChanges,
    rejected_count: r.rejectedCount,
    error: r.error,
  }))
}
