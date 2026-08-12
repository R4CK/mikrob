import { describe, it, expect } from 'vitest'
import { buildIngestLog } from '../build-ingest-log.js'
import type { IngestLogRow } from '../../query.js'

const row = (overrides: Partial<IngestLogRow> = {}): IngestLogRow => ({
  ranAt: 1000,
  ok: true,
  newListings: 0,
  priceChanges: 0,
  rejectedCount: 0,
  error: null,
  ...overrides,
})

describe('buildIngestLog', () => {
  it('converts epoch seconds to an ISO timestamp', () => {
    const [entry] = buildIngestLog([row({ ranAt: 1000 })])
    expect(entry.ran_at).toBe(new Date(1000 * 1000).toISOString())
  })

  it('passes ok/counts/error through unchanged', () => {
    const [entry] = buildIngestLog([
      row({ ok: false, newListings: 3, priceChanges: 1, rejectedCount: 2, error: 'invalid JSON' }),
    ])
    expect(entry).toMatchObject({ ok: false, new_listings: 3, price_changes: 1, rejected_count: 2, error: 'invalid JSON' })
  })

  it('an empty input returns an empty array', () => {
    expect(buildIngestLog([])).toEqual([])
  })
})
