import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../kg/store.js'
import { recordKgSearchEvent, getKgActivityEvents } from '../kg/search-events.js'

describe('kg search-events (card a1d57d99)', () => {
  it('records an event and reads it back via getKgActivityEvents', () => {
    const db = new Database(':memory:')
    migrate(db)
    recordKgSearchEvent(db, { agent: 'backend2', tsMs: 1000, query: 'fix guard', hitNodeIds: ['n1', 'n2'] }, 5000)
    const events = getKgActivityEvents(db, 0, 500)
    expect(events).toEqual([{ agent_id: 'backend2', ts: 1000, hit: ['n1', 'n2'] }])
    db.close()
  })

  it('getKgActivityEvents only returns events strictly newer than since', () => {
    const db = new Database(':memory:')
    migrate(db)
    recordKgSearchEvent(db, { agent: 'a', tsMs: 100, query: null, hitNodeIds: [] }, 5000)
    recordKgSearchEvent(db, { agent: 'b', tsMs: 200, query: null, hitNodeIds: [] }, 5000)
    const events = getKgActivityEvents(db, 100, 500)
    expect(events.map((e) => e.agent_id)).toEqual(['b'])
    db.close()
  })

  it('a search-event query must still be stored even when secret-shaped -- redacted, not dropped', () => {
    const db = new Database(':memory:')
    migrate(db)
    recordKgSearchEvent(db, { agent: 'a', tsMs: 100, query: 'api_key=sk-abcdef1234567890', hitNodeIds: [] }, 5000)
    const row = db.prepare('SELECT query FROM kg_search_events').get() as { query: string }
    expect(row.query).not.toContain('sk-abcdef1234567890')
    expect(row.query).toContain('[redacted:secret]')
  })

  it('query is truncated to a bounded length (same ReDoS-adjacent discipline as kg.ts MAX_Q_LEN)', () => {
    const db = new Database(':memory:')
    migrate(db)
    recordKgSearchEvent(db, { agent: 'a', tsMs: 100, query: 'x'.repeat(5000), hitNodeIds: [] }, 5000)
    const row = db.prepare('SELECT query FROM kg_search_events').get() as { query: string }
    expect(row.query.length).toBeLessThanOrEqual(2000)
  })

  it('retention cap: writing beyond the cap trims the oldest rows, keeps the newest', () => {
    const db = new Database(':memory:')
    migrate(db)
    for (let i = 0; i < 5; i++) {
      recordKgSearchEvent(db, { agent: 'a', tsMs: i, query: null, hitNodeIds: [] }, 3)
    }
    const rows = db.prepare('SELECT ts_ms FROM kg_search_events ORDER BY ts_ms ASC').all() as { ts_ms: number }[]
    expect(rows.map((r) => r.ts_ms)).toEqual([2, 3, 4])
  })

  it('retentionRows=0 disables trimming (no DELETE issued)', () => {
    const db = new Database(':memory:')
    migrate(db)
    for (let i = 0; i < 5; i++) {
      recordKgSearchEvent(db, { agent: 'a', tsMs: i, query: null, hitNodeIds: [] }, 0)
    }
    const count = (db.prepare('SELECT COUNT(*) AS n FROM kg_search_events').get() as { n: number }).n
    expect(count).toBe(5)
  })
})
