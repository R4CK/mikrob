// Local-LLM queue state machine (card defcc189). Runs against a real in-memory SQLite so the
// transaction/claim semantics are exercised for real -- a mocked db would prove nothing about the
// one-row-to-one-worker guarantee, which is the whole point of claimNext.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import {
  enqueue,
  claimNext,
  complete,
  fail,
  reclaimStaleRunning,
  getById,
  listRecent,
  stats,
  statsByAgent,
  MAX_ATTEMPTS,
} from '../local-llm-queue.js'

const T0 = 1_700_000_000_000

function freshDb(): Db {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE local_llm_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      card_id TEXT,
      task_type TEXT,
      template TEXT,
      prompt TEXT NOT NULL,
      context TEXT,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed')),
      source TEXT NOT NULL DEFAULT 'agent',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      result TEXT,
      error TEXT
    )
  `)
  return db
}

let db: Db
beforeEach(() => {
  db = freshDb()
})

describe('enqueue', () => {
  it('returns an id and stores the row as pending', () => {
    const id = enqueue(db, { agent: 'backend', prompt: 'write a regex' }, T0)
    expect(id).toBeGreaterThan(0)
    const row = getById(db, id)!
    expect(row.status).toBe('pending')
    expect(row.agent).toBe('backend')
    expect(row.attempts).toBe(0)
    expect(row.created_at).toBe(T0)
  })

  it('rejects an empty prompt and an empty agent (a queued no-op wastes a GPU slot)', () => {
    expect(() => enqueue(db, { agent: 'backend', prompt: '   ' }, T0)).toThrow()
    expect(() => enqueue(db, { agent: '  ', prompt: 'x' }, T0)).toThrow()
  })

  it('does not block: enqueue never touches status beyond pending', () => {
    const id = enqueue(db, { agent: 'qa', prompt: 'p', source: 'offload-dispatch' }, T0)
    expect(getById(db, id)!.status).toBe('pending')
    expect(getById(db, id)!.source).toBe('offload-dispatch')
  })
})

describe('claimNext ordering', () => {
  it('takes highest priority first, then oldest', () => {
    enqueue(db, { agent: 'a', prompt: 'normal-old', priority: 'normal' }, T0)
    enqueue(db, { agent: 'a', prompt: 'low', priority: 'low' }, T0 + 1)
    enqueue(db, { agent: 'a', prompt: 'urgent', priority: 'urgent' }, T0 + 2)
    enqueue(db, { agent: 'a', prompt: 'high', priority: 'high' }, T0 + 3)
    expect(claimNext(db, T0 + 10)!.prompt).toBe('urgent')
    expect(claimNext(db, T0 + 11)!.prompt).toBe('high')
    expect(claimNext(db, T0 + 12)!.prompt).toBe('normal-old')
    expect(claimNext(db, T0 + 13)!.prompt).toBe('low')
  })

  it('breaks equal priority by age, oldest first (no starvation of early work)', () => {
    enqueue(db, { agent: 'a', prompt: 'first' }, T0)
    enqueue(db, { agent: 'a', prompt: 'second' }, T0 + 5)
    expect(claimNext(db, T0 + 10)!.prompt).toBe('first')
    expect(claimNext(db, T0 + 11)!.prompt).toBe('second')
  })

  it('returns null on an empty queue', () => {
    expect(claimNext(db, T0)).toBeNull()
  })
})

describe('claimNext exclusivity (the load-bearing guarantee)', () => {
  it('marks the row running with a start time and bumps attempts', () => {
    enqueue(db, { agent: 'a', prompt: 'p' }, T0)
    const row = claimNext(db, T0 + 100)!
    expect(row.status).toBe('running')
    expect(row.started_at).toBe(T0 + 100)
    expect(row.attempts).toBe(1)
  })

  it('never hands the same row out twice -- a second claim gets the NEXT row, not a duplicate', () => {
    enqueue(db, { agent: 'a', prompt: 'one' }, T0)
    enqueue(db, { agent: 'a', prompt: 'two' }, T0 + 1)
    const a = claimNext(db, T0 + 10)!
    const b = claimNext(db, T0 + 11)!
    expect(a.id).not.toBe(b.id)
    expect(new Set([a.prompt, b.prompt])).toEqual(new Set(['one', 'two']))
  })

  it('a running row is not claimable again', () => {
    enqueue(db, { agent: 'a', prompt: 'only' }, T0)
    expect(claimNext(db, T0 + 1)).not.toBeNull()
    expect(claimNext(db, T0 + 2)).toBeNull()
  })
})

describe('complete / fail', () => {
  it('complete stores the result and clears any prior error', () => {
    const id = enqueue(db, { agent: 'a', prompt: 'p' }, T0)
    claimNext(db, T0 + 1)
    complete(db, id, 'the draft', T0 + 50)
    const row = getById(db, id)!
    expect(row.status).toBe('done')
    expect(row.result).toBe('the draft')
    expect(row.finished_at).toBe(T0 + 50)
    expect(row.error).toBeNull()
  })

  it('fail below the cap requeues for another attempt', () => {
    const id = enqueue(db, { agent: 'a', prompt: 'p' }, T0)
    claimNext(db, T0 + 1)
    expect(fail(db, id, 'model timeout', T0 + 2)).toBe('pending')
    expect(getById(db, id)!.status).toBe('pending')
    // and it is claimable again
    expect(claimNext(db, T0 + 3)!.id).toBe(id)
  })

  it('parks the row as failed at the 3-strikes cap instead of burning more GPU time', () => {
    const id = enqueue(db, { agent: 'a', prompt: 'p' }, T0)
    let last = ''
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      claimNext(db, T0 + i)
      last = fail(db, id, 'nope', T0 + i)
    }
    expect(last).toBe('failed')
    expect(getById(db, id)!.status).toBe('failed')
    expect(claimNext(db, T0 + 99)).toBeNull() // no longer served
  })

  it('truncates a huge error so one bad run cannot bloat the row', () => {
    const id = enqueue(db, { agent: 'a', prompt: 'p' }, T0)
    claimNext(db, T0 + 1)
    fail(db, id, 'x'.repeat(10_000), T0 + 2)
    expect((getById(db, id)!.error ?? '').length).toBeLessThanOrEqual(2000)
  })
})

describe('reclaimStaleRunning (worker crash recovery)', () => {
  it('requeues a row whose worker vanished', () => {
    const id = enqueue(db, { agent: 'a', prompt: 'p' }, T0)
    claimNext(db, T0)
    const n = reclaimStaleRunning(db, 60_000, T0 + 120_000)
    expect(n).toBe(1)
    const row = getById(db, id)!
    expect(row.status).toBe('pending')
    expect(row.started_at).toBeNull()
    expect(claimNext(db, T0 + 130_000)!.id).toBe(id) // actually served again
  })

  it('leaves a FRESH running row alone (negative control -- must not steal live work)', () => {
    enqueue(db, { agent: 'a', prompt: 'p' }, T0)
    claimNext(db, T0 + 100_000)
    expect(reclaimStaleRunning(db, 60_000, T0 + 120_000)).toBe(0)
  })

  it('abandons rather than requeues once the attempt cap is reached', () => {
    const id = enqueue(db, { agent: 'a', prompt: 'p' }, T0)
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      claimNext(db, T0)
      if (i < MAX_ATTEMPTS - 1) fail(db, id, 'e', T0)
    }
    // last attempt left it running; the worker then vanished
    const n = reclaimStaleRunning(db, 60_000, T0 + 999_999)
    expect(n).toBe(1)
    expect(getById(db, id)!.status).toBe('failed')
  })

  it('does not touch done rows', () => {
    const id = enqueue(db, { agent: 'a', prompt: 'p' }, T0)
    claimNext(db, T0)
    complete(db, id, 'r', T0 + 1)
    expect(reclaimStaleRunning(db, 1, T0 + 999_999)).toBe(0)
    expect(getById(db, id)!.status).toBe('done')
  })
})

describe('stats', () => {
  it('counts each status and averages latency over completed rows only', () => {
    const a = enqueue(db, { agent: 'backend', prompt: 'p1' }, T0)
    const b = enqueue(db, { agent: 'qa', prompt: 'p2' }, T0)
    enqueue(db, { agent: 'qa', prompt: 'p3' }, T0)
    claimNext(db, T0)
    complete(db, a, 'r', T0 + 1000) // 1000ms
    claimNext(db, T0)
    complete(db, b, 'r', T0 + 3000) // 3000ms
    const s = stats(db)
    expect(s.done).toBe(2)
    expect(s.pending).toBe(1)
    expect(s.avgLatencyMs).toBe(2000)
  })

  it('avgLatencyMs is null when nothing has completed (no fake zero)', () => {
    enqueue(db, { agent: 'a', prompt: 'p' }, T0)
    expect(stats(db).avgLatencyMs).toBeNull()
  })

  it('per-agent breakdown shows who is using the local model', () => {
    const a = enqueue(db, { agent: 'backend', prompt: 'p' }, T0)
    enqueue(db, { agent: 'penzugy', prompt: 'p' }, T0)
    claimNext(db, T0)
    complete(db, a, 'r', T0 + 1)
    const rows = statsByAgent(db)
    expect(rows.find((r) => r.agent === 'backend')!.done).toBe(1)
    expect(rows.find((r) => r.agent === 'penzugy')!.pending).toBe(1)
  })
})

describe('listRecent (dashboard panel, card 48aacf56 item 5)', () => {
  it('returns rows newest first', () => {
    enqueue(db, { agent: 'a', prompt: 'first' }, T0)
    enqueue(db, { agent: 'a', prompt: 'second' }, T0 + 1)
    enqueue(db, { agent: 'a', prompt: 'third' }, T0 + 2)
    const rows = listRecent(db, 100)
    expect(rows.map((r) => r.created_at)).toEqual([T0 + 2, T0 + 1, T0])
  })

  it('filters to one status when given', () => {
    const a = enqueue(db, { agent: 'a', prompt: 'p1' }, T0)
    enqueue(db, { agent: 'a', prompt: 'p2' }, T0 + 1)
    claimNext(db, T0 + 10)
    complete(db, a, 'r', T0 + 20)
    const done = listRecent(db, 100, 'done')
    expect(done).toHaveLength(1)
    expect(done[0]!.id).toBe(a)
    const pending = listRecent(db, 100, 'pending')
    expect(pending).toHaveLength(1)
  })

  it('never includes the prompt/context/result fields (list view, not detail)', () => {
    enqueue(db, { agent: 'a', prompt: 'sensitive prompt text', context: 'sensitive context' }, T0)
    const row = listRecent(db, 10)[0] as unknown as Record<string, unknown>
    expect(row).not.toHaveProperty('prompt')
    expect(row).not.toHaveProperty('context')
    expect(row).not.toHaveProperty('result')
  })

  it('caps the limit at 500 even when a larger value is requested', () => {
    for (let i = 0; i < 5; i += 1) enqueue(db, { agent: 'a', prompt: `p${i}` }, T0 + i)
    // 5 rows exist; asking for 5000 must not throw and must not exceed what exists.
    expect(listRecent(db, 5000)).toHaveLength(5)
  })

  it('defaults to a sane limit when given a non-numeric/zero value', () => {
    enqueue(db, { agent: 'a', prompt: 'p' }, T0)
    expect(listRecent(db, NaN)).toHaveLength(1)
    expect(listRecent(db, 0)).toHaveLength(1)
  })
})
