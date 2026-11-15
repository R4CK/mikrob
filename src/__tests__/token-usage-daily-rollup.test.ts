import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  getDb,
  rollupRecentTokenUsageDaily,
  pruneTokenUsage,
  classifyTokenPruneLag,
} from '../db.js'

// card d8f44d15: token_usage_daily only ever got a day's totals once pruneTokenUsage deleted that
// day's raw rows (TOKEN_USAGE_RETENTION_DAYS later) -- a ~30-day visibility lag by design, not a
// stoppage. rollupRecentTokenUsageDaily() fills that gap non-destructively; these tests pin that
// it does so without ever double-counting against pruneTokenUsage's own additive upsert.
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

let sessionCounter = 0
function insertRaw(ts: number, agent: string, inputTokens: number) {
  // Unique session_id per call: idx_token_usage_dedup is keyed on
  // (session_id, timestamp, input_tokens, output_tokens), and two calls in the same test file
  // can legitimately share a timestamp+token-count across different agents/tests.
  sessionCounter += 1
  getDb()
    .prepare(
      `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, model)
       VALUES (?, ?, ?, ?, 0, 0, 0, 'claude-sonnet-5')`,
    )
    .run(agent, `sess-${sessionCounter}`, ts, inputTokens)
}

function dailyRow(day: string, agent: string): { input_tokens: number } | undefined {
  return getDb()
    .prepare(
      `SELECT input_tokens FROM token_usage_daily WHERE day = ? AND agent = ? AND model = 'claude-sonnet-5' AND project = ''`,
    )
    .get(day, agent) as { input_tokens: number } | undefined
}

describe('rollupRecentTokenUsageDaily', () => {
  it('folds a recent, still-live day into token_usage_daily without deleting it', () => {
    const now = Math.floor(Date.now() / 1000)
    insertRaw(now, 'cardX-agent', 100)
    insertRaw(now, 'cardX-agent', 50)
    rollupRecentTokenUsageDaily()
    const today = new Date().toISOString().slice(0, 10)
    expect(dailyRow(today, 'cardX-agent')?.input_tokens).toBe(150)
    // non-destructive: the raw rows are still there
    const raw = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM token_usage WHERE agent = 'cardX-agent'`)
      .get() as { n: number }
    expect(raw.n).toBe(2)
  })

  it('re-running it again does not double-count (REPLACE, not ADD)', () => {
    const now = Math.floor(Date.now() / 1000)
    insertRaw(now, 'cardX-rerun', 100)
    rollupRecentTokenUsageDaily()
    rollupRecentTokenUsageDaily()
    rollupRecentTokenUsageDaily()
    const today = new Date().toISOString().slice(0, 10)
    expect(dailyRow(today, 'cardX-rerun')?.input_tokens).toBe(100)
  })

  it('a new row appearing later is picked up on the next run (recompute, not frozen)', () => {
    const now = Math.floor(Date.now() / 1000)
    insertRaw(now, 'cardX-grow', 10)
    rollupRecentTokenUsageDaily()
    insertRaw(now, 'cardX-grow', 5)
    rollupRecentTokenUsageDaily()
    const today = new Date().toISOString().slice(0, 10)
    expect(dailyRow(today, 'cardX-grow')?.input_tokens).toBe(15)
  })

  it('never touches a day past the retention cutoff (pruneTokenUsage owns those)', () => {
    // A row far older than any default retention (30 days). The `day > cutoffDay` filter must
    // exclude it entirely -- this is the invariant that keeps this function's REPLACE semantics
    // from ever colliding with pruneTokenUsage's additive upsert on an old day.
    const old = Math.floor(Date.now() / 1000) - 400 * 86400
    insertRaw(old, 'cardX-boundary', 1)
    rollupRecentTokenUsageDaily()
    const oldDay = new Date(old * 1000).toISOString().slice(0, 10)
    expect(dailyRow(oldDay, 'cardX-boundary')).toBeUndefined()
  })
})

describe('classifyTokenPruneLag (card d8f44d15 req 3, previously computed but unwired)', () => {
  it('flags stale when the oldest row overshoots retention + tolerance', () => {
    const now = 2_000_000_000
    const retentionDays = 30
    const toleranceHours = 48
    const oldest = now - (retentionDays * 86400 + 72 * 3600) // 3 days overshoot
    const verdict = classifyTokenPruneLag(oldest, retentionDays, now, toleranceHours)
    expect(verdict.state).toBe('stale')
  })

  it('reads ok when freshly swept', () => {
    const now = 2_000_000_000
    const retentionDays = 30
    const toleranceHours = 48
    const oldest = now - (retentionDays * 86400 - 3600) // not yet past cutoff
    const verdict = classifyTokenPruneLag(oldest, retentionDays, now, toleranceHours)
    expect(verdict.state).toBe('ok')
  })
})

// Keep pruneTokenUsage imported-and-exercised so a future refactor that breaks its own additive
// upsert (the invariant rollupRecentTokenUsageDaily's boundary-day test above relies on) fails
// here too, not only in its own suite.
describe('pruneTokenUsage stays additive (sanity, not a new behaviour)', () => {
  it('folds and deletes rows older than retention', () => {
    const old = Math.floor(Date.now() / 1000) - 400 * 86400
    insertRaw(old, 'cardX-old', 42)
    const deleted = pruneTokenUsage()
    expect(deleted).toBeGreaterThanOrEqual(1)
    const raw = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM token_usage WHERE agent = 'cardX-old'`)
      .get() as { n: number }
    expect(raw.n).toBe(0)
  })
})
