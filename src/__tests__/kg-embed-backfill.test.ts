// Card 6d542dc9: 0/890 kg_nodes had a populated embedding column, so hybridKgSearch's
// semantic branch was dead graph-wide (root cause: upsertNode never generated one). This
// covers the fix: kgEmbedText's field join, upsertNode's fire-and-forget auto-embed on new
// writes, and backfillKgNodeEmbeddings draining existing NULL rows -- same shape as
// src/db.ts's backfillEmbeddings()/scheduleEmbedding() for memories, reusing generateEmbedding
// (local Ollama only, no external call).

import { describe, it, expect, vi, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  migrate,
  upsertNode,
  kgEmbedText,
  backfillKgNodeEmbeddings,
  EMBED_CONCURRENCY_LIMIT,
  EMBED_QUEUE_BOUND,
  getEmbedDropCount,
  getEmbedFailedCount,
  getEmbedActiveForTest,
  resetEmbedCountersForTest,
} from '../kg/store.js'

vi.mock('../db.js', () => ({
  generateEmbedding: vi.fn(async (text: string) => (text ? [0.1, 0.2, 0.3] : null)),
}))

afterEach(async () => {
  const { generateEmbedding } = await import('../db.js')
  vi.mocked(generateEmbedding).mockImplementation(async (text: string) => (text ? [0.1, 0.2, 0.3] : null))
  vi.clearAllMocks()
  resetEmbedCountersForTest()
})

describe('kgEmbedText', () => {
  it('joins title/body/snippet/keywords, skipping null/empty fields', () => {
    expect(kgEmbedText('title', 'body', null, 'kw')).toBe('title body kw')
    expect(kgEmbedText('title', null, null, null)).toBe('title')
    expect(kgEmbedText('title', '', '   ', undefined)).toBe('title')
  })
})

describe('upsertNode auto-embeds new writes', () => {
  it('schedules an embedding for a node written without one, fire-and-forget', async () => {
    const { generateEmbedding } = await import('../db.js')
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'sol:auto1', type: 'solution', project: 'marveen', title: 'fix the thing',
      body: 'did a thing', source_ref: 'kanban_comments:1', extractor: 'manual',
    })
    expect(generateEmbedding).toHaveBeenCalledWith('fix the thing did a thing')
    // fire-and-forget: wait for the microtask the .then() runs in before reading the row back
    await new Promise((r) => setTimeout(r, 0))
    const row = db.prepare('SELECT embedding, embed_model FROM kg_nodes WHERE id = ?').get('sol:auto1') as
      { embedding: Buffer; embed_model: string }
    expect(JSON.parse(row.embedding.toString())).toEqual([0.1, 0.2, 0.3])
    expect(row.embed_model).toBeTruthy()
    db.close()
  })

  it('does NOT auto-embed when the caller explicitly supplied an embedding (even null)', async () => {
    const { generateEmbedding } = await import('../db.js')
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'sol:explicit1', type: 'solution', project: 'marveen', title: 'fix',
      source_ref: 'kanban_comments:1', extractor: 'manual', embedding: null,
    })
    expect(generateEmbedding).not.toHaveBeenCalled()
    db.close()
  })
})

describe('backfillKgNodeEmbeddings', () => {
  it('embeds every NULL-embedding row and reports attempted/embedded/failed', async () => {
    const db = new Database(':memory:')
    migrate(db)
    // bypass upsertNode's own auto-embed so these rows start out NULL, as the real 0/890 did
    upsertNode(db, {
      id: 'card:a', type: 'card', project: 'marveen', title: 'a card',
      source_ref: 'kanban_cards:a', extractor: 'manual', embedding: null,
    })
    upsertNode(db, {
      id: 'card:b', type: 'card', project: 'marveen', title: 'b card',
      source_ref: 'kanban_cards:b', extractor: 'manual', embedding: null,
    })
    const result = await backfillKgNodeEmbeddings(db)
    expect(result).toEqual({ attempted: 2, embedded: 2, failed: 0 })
    const rows = db.prepare('SELECT embedding FROM kg_nodes WHERE embedding IS NULL').all()
    expect(rows).toHaveLength(0)
  })

  it('reports a failure, not a crash, when the embedding backend returns nothing', async () => {
    const { generateEmbedding } = await import('../db.js')
    vi.mocked(generateEmbedding).mockResolvedValueOnce(null)
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'card:c', type: 'card', project: 'marveen', title: 'c card',
      source_ref: 'kanban_cards:c', extractor: 'manual', embedding: null,
    })
    const result = await backfillKgNodeEmbeddings(db)
    expect(result).toEqual({ attempted: 1, embedded: 0, failed: 1 })
    db.close()
  })

  it('leaves an already-embedded row untouched (does not re-request)', async () => {
    const { generateEmbedding } = await import('../db.js')
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'card:d', type: 'card', project: 'marveen', title: 'd card',
      source_ref: 'kanban_cards:d', extractor: 'manual',
      embedding: Buffer.from(JSON.stringify([9, 9, 9])), embed_model: 'manual-test',
    })
    vi.mocked(generateEmbedding).mockClear()
    const result = await backfillKgNodeEmbeddings(db)
    expect(result).toEqual({ attempted: 0, embedded: 0, failed: 0 })
    expect(generateEmbedding).not.toHaveBeenCalled()
    db.close()
  })
})

// Card 6d542dc9 F-1 (CYBERSEC MEDIUM, comment 24952): a re-import (upsertNode on an existing id)
// went through ON CONFLICT DO UPDATE SET embedding=excluded.embedding -- since a normal caller
// never passes `embedding`, excluded.embedding is always NULL, so EVERY re-import of an already-
// embedded node clobbered its valid embedding back to NULL. Fixed with COALESCE(excluded.x, x) on
// conflict (keep the old value unless the caller explicitly supplies a new one) plus a text-changed
// check that skips the recompute entirely when nothing that feeds the embedding actually changed.
describe('upsertNode keeps a valid embedding across re-import (F-1a)', () => {
  it('does not null out, and does not recompute, an existing embedding when the embed text is unchanged', async () => {
    const { generateEmbedding } = await import('../db.js')
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'card:f1a', type: 'card', project: 'marveen', title: 'same title', body: 'same body',
      source_ref: 'kanban_cards:f1a', extractor: 'manual',
    })
    await new Promise((r) => setTimeout(r, 0))
    const before = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:f1a') as { embedding: Buffer }
    expect(before.embedding).not.toBeNull()
    vi.mocked(generateEmbedding).mockClear()

    upsertNode(db, {
      id: 'card:f1a', type: 'card', project: 'marveen', title: 'same title', body: 'same body',
      source_ref: 'kanban_cards:f1a', extractor: 'manual',
    })
    const afterConflict = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:f1a') as { embedding: Buffer }
    expect(afterConflict.embedding.equals(before.embedding)).toBe(true)
    expect(generateEmbedding).not.toHaveBeenCalled()
    db.close()
  })

  it('recomputes the embedding when the embed text changed', async () => {
    const { generateEmbedding } = await import('../db.js')
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'card:f1b', type: 'card', project: 'marveen', title: 'old title',
      source_ref: 'kanban_cards:f1b', extractor: 'manual',
    })
    await new Promise((r) => setTimeout(r, 0))
    vi.mocked(generateEmbedding).mockClear()

    upsertNode(db, {
      id: 'card:f1b', type: 'card', project: 'marveen', title: 'new title',
      source_ref: 'kanban_cards:f1b', extractor: 'manual',
    })
    expect(generateEmbedding).toHaveBeenCalledWith('new title')
    await new Promise((r) => setTimeout(r, 0))
    const after = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:f1b') as { embedding: Buffer }
    expect(JSON.parse(after.embedding.toString())).toEqual([0.1, 0.2, 0.3])
    db.close()
  })

  // N-1 (regression, card 7f3cbe92): F-1a's COALESCE kept the OLD, now-stale vector in place on a
  // changed-text re-import when the recompute later fails/drops -- backfillKgNodeEmbeddings only
  // selects WHERE embedding IS NULL, so a stale vector was never repaired and search silently kept
  // scoring the node against text it no longer has. Fixed: a changed-text write clears to NULL
  // SYNCHRONOUSLY, before the async recompute even starts, so a failure leaves the correct,
  // backfill-visible NULL instead of a wrong-but-present vector.
  it('N-1: clears to NULL immediately on a text change, not the stale old vector, so a failed recompute stays repairable', async () => {
    const { generateEmbedding } = await import('../db.js')
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'card:n1', type: 'card', project: 'marveen', title: 'old title',
      source_ref: 'kanban_cards:n1', extractor: 'manual',
    })
    await new Promise((r) => setTimeout(r, 0))
    const before = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:n1') as { embedding: Buffer }
    expect(before.embedding).not.toBeNull()

    // Backend down for the re-embed attempt on the changed text.
    vi.mocked(generateEmbedding).mockClear()
    vi.mocked(generateEmbedding).mockRejectedValueOnce(new Error('ollama down'))

    upsertNode(db, {
      id: 'card:n1', type: 'card', project: 'marveen', title: 'new title',
      source_ref: 'kanban_cards:n1', extractor: 'manual',
    })
    const immediatelyAfterConflict = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:n1') as { embedding: Buffer | null }
    expect(immediatelyAfterConflict.embedding).toBeNull()

    await new Promise((r) => setTimeout(r, 0))
    const afterFailedRecompute = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:n1') as { embedding: Buffer | null }
    expect(afterFailedRecompute.embedding).toBeNull() // still NULL, correctly repairable by backfill -- never the stale old vector
    db.close()
  })

  // N-4 (info finding on 6d542dc9's GO, carried into card 7f3cbe92): COALESCE(excluded.embedding,
  // embedding) made an explicit `embedding: null` from a caller indistinguishable from an omitted
  // field, so a deliberate clear request silently stopped clearing anything. Restored by telling
  // "caller provided a value" (including null) apart from "caller didn't touch it".
  it('N-4: an explicit embedding:null from the caller clears an existing vector', async () => {
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'card:n4', type: 'card', project: 'marveen', title: 'title',
      source_ref: 'kanban_cards:n4', extractor: 'manual',
    })
    await new Promise((r) => setTimeout(r, 0))
    const before = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:n4') as { embedding: Buffer }
    expect(before.embedding).not.toBeNull()

    upsertNode(db, {
      id: 'card:n4', type: 'card', project: 'marveen', title: 'title',
      source_ref: 'kanban_cards:n4', extractor: 'manual', embedding: null,
    })
    const after = db.prepare('SELECT embedding, embed_model FROM kg_nodes WHERE id = ?').get('card:n4') as { embedding: Buffer | null; embed_model: string | null }
    expect(after.embedding).toBeNull()
    expect(after.embed_model).toBeNull()
    db.close()
  })

  // N-2 (card 7f3cbe92): an unchanged re-import used to skip scheduling an embed attempt entirely
  // (textChanged === false), so a row left NULL by an earlier dropped/failed attempt stayed NULL
  // forever unless its text happened to change or an operator ran a manual backfill. Any write
  // touching the node is now a free chance to heal it when it is still NULL.
  it('N-2: an unchanged re-import over a still-NULL row gets another embed attempt', async () => {
    const { generateEmbedding } = await import('../db.js')
    const db = new Database(':memory:')
    migrate(db)
    vi.mocked(generateEmbedding).mockRejectedValueOnce(new Error('ollama down'))
    upsertNode(db, {
      id: 'card:n2', type: 'card', project: 'marveen', title: 'title',
      source_ref: 'kanban_cards:n2', extractor: 'manual',
    })
    await new Promise((r) => setTimeout(r, 0))
    const afterFirstFailure = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:n2') as { embedding: Buffer | null }
    expect(afterFirstFailure.embedding).toBeNull()

    vi.mocked(generateEmbedding).mockClear()
    upsertNode(db, {
      id: 'card:n2', type: 'card', project: 'marveen', title: 'title',
      source_ref: 'kanban_cards:n2', extractor: 'manual',
    })
    expect(generateEmbedding).toHaveBeenCalledWith('title')
    await new Promise((r) => setTimeout(r, 0))
    const after = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:n2') as { embedding: Buffer }
    expect(JSON.parse(after.embedding.toString())).toEqual([0.1, 0.2, 0.3])
    db.close()
  })
})

// Card 6d542dc9 F-1 (b): a bulk re-import firing one scheduleKgNodeEmbedding per upsertNode with no
// cap could outrun an external abort before most rows finish, leaving them NULL. Capped concurrency
// + a bounded queue (excess requests dropped, row stays NULL for backfillKgNodeEmbeddings to pick
// up later) keeps the fan-out bounded and deterministic.
describe('upsertNode embedding fan-out is capped (F-1b)', () => {
  it('runs at most EMBED_CONCURRENCY_LIMIT embeddings concurrently, queuing the rest', async () => {
    const { generateEmbedding } = await import('../db.js')
    let active = 0
    let maxActive = 0
    const resolvers: Array<() => void> = []
    vi.mocked(generateEmbedding).mockImplementation(() => {
      active++
      maxActive = Math.max(maxActive, active)
      return new Promise((resolve) => {
        resolvers.push(() => {
          active--
          resolve([0.1, 0.2, 0.3])
        })
      })
    })

    const db = new Database(':memory:')
    migrate(db)
    const total = EMBED_CONCURRENCY_LIMIT + 3
    for (let i = 0; i < total; i++) {
      upsertNode(db, {
        id: `card:cap${i}`, type: 'card', project: 'marveen', title: `title ${i}`,
        source_ref: `kanban_cards:cap${i}`, extractor: 'manual',
      })
    }
    await new Promise((r) => setTimeout(r, 0))
    expect(maxActive).toBeLessThanOrEqual(EMBED_CONCURRENCY_LIMIT)
    expect(generateEmbedding).toHaveBeenCalledTimes(EMBED_CONCURRENCY_LIMIT)

    resolvers.splice(0).forEach((r) => r())
    await new Promise((r) => setTimeout(r, 0))
    expect(generateEmbedding).toHaveBeenCalledTimes(total)
    // fully drain so this test's in-flight slots don't leak into the next test (module-level
    // embedActive/embedQueue state is shared across tests in this file)
    resolvers.splice(0).forEach((r) => r())
    await new Promise((r) => setTimeout(r, 0))
    // CYBERSEC NO-GO 39145 F-5: a deleted `embedActive--` in runEmbedSlot's finally() does not
    // stop the queue from draining (the queued `start()` re-increments unconditionally), so
    // toHaveBeenCalledTimes(total) above cannot catch it -- only the counter staying wrong can.
    // This used to be caught by accident (the leaked count starved the NEXT test's slots); the
    // global resetEmbedCountersForTest() afterEach now wipes that leak before the next test ever
    // sees it, so pin it directly here instead.
    expect(getEmbedActiveForTest()).toBe(0)
    db.close()
  })

  it('drops embedding requests beyond EMBED_QUEUE_BOUND without crashing or losing the node write', async () => {
    const { generateEmbedding } = await import('../db.js')
    const resolvers: Array<() => void> = []
    vi.mocked(generateEmbedding).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(() => resolve([0.1, 0.2, 0.3]))
        }),
    )

    const db = new Database(':memory:')
    migrate(db)
    const total = EMBED_CONCURRENCY_LIMIT + EMBED_QUEUE_BOUND + 5
    for (let i = 0; i < total; i++) {
      upsertNode(db, {
        id: `card:bound${i}`, type: 'card', project: 'marveen', title: `title ${i}`,
        source_ref: `kanban_cards:bound${i}`, extractor: 'manual',
      })
    }
    await new Promise((r) => setTimeout(r, 0))

    // drain repeatedly: resolving active slots lets the next queued one start, until the call
    // count stops growing -- proves exactly which requests ever got a slot, queued or not,
    // versus the ones dropped outright for exceeding the bound.
    let callsBefore = -1
    while (vi.mocked(generateEmbedding).mock.calls.length !== callsBefore) {
      callsBefore = vi.mocked(generateEmbedding).mock.calls.length
      resolvers.splice(0).forEach((r) => r())
      await new Promise((r) => setTimeout(r, 0))
    }

    const count = db.prepare('SELECT COUNT(*) c FROM kg_nodes').get() as { c: number }
    expect(count.c).toBe(total) // every node write succeeded regardless of embedding fan-out
    expect(generateEmbedding).toHaveBeenCalledTimes(EMBED_CONCURRENCY_LIMIT + EMBED_QUEUE_BOUND)
    db.close()
  })
})

// N-3 HARD CONDITION (card 7f3cbe92, CYBERSEC comment on 6d542dc9's GO): a drop beyond the
// concurrency+queue bound used to be completely silent (no log, no counter), and
// backfillKgNodeEmbeddings had no caller at all -- so a bulk write past the bound (900 new nodes
// in one tick -> 54 embedded, 846 dropped) left most rows permanently NULL. Fixed: every drop is
// counted + logged, and a drop/failure schedules a debounced self-heal sweep that calls
// backfillKgNodeEmbeddings -- no importer needs to know this exists.
describe('N-3: drops/failures are counted, logged, and self-heal via a backfill sweep (card 7f3cbe92)', () => {
  it('counts and logs a drop beyond the concurrency+queue bound', async () => {
    const { generateEmbedding } = await import('../db.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(generateEmbedding).mockImplementation(() => new Promise(() => {})) // never resolves, nothing frees a slot
    const db = new Database(':memory:')
    migrate(db)
    const total = EMBED_CONCURRENCY_LIMIT + EMBED_QUEUE_BOUND + 3
    for (let i = 0; i < total; i++) {
      upsertNode(db, {
        id: `card:drop${i}`, type: 'card', project: 'marveen', title: `t${i}`,
        source_ref: `kanban_cards:drop${i}`, extractor: 'manual',
      })
    }
    expect(getEmbedDropCount()).toBe(3)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
    db.close()
  })

  it('a backend-down failure (not just a drop) is counted too and also triggers the sweep', async () => {
    const { generateEmbedding } = await import('../db.js')
    vi.mocked(generateEmbedding).mockRejectedValueOnce(new Error('ollama down'))
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'card:failcount', type: 'card', project: 'marveen', title: 'title',
      source_ref: 'kanban_cards:failcount', extractor: 'manual',
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(getEmbedFailedCount()).toBe(1)
    db.close()
  })

  // M6 (CYBERSEC NO-GO 39146/39187): the test above only exercises the THROW path
  // (mockRejectedValueOnce). The real backend-down shape is generateEmbedding resolving to
  // null WITHOUT throwing (src/db.ts's own catch returns null) -- a mutant that counts a falsy
  // result as success survived every other test here.
  it('a falsy (null) embedding result -- not a throw -- is counted as a failure too', async () => {
    const { generateEmbedding } = await import('../db.js')
    vi.mocked(generateEmbedding).mockResolvedValueOnce(null)
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'card:nullfail', type: 'card', project: 'marveen', title: 'title',
      source_ref: 'kanban_cards:nullfail', extractor: 'manual',
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(getEmbedFailedCount()).toBe(1)
    db.close()
  })

  it('900 new nodes in one tick: drops are counted exactly (54 embedded, 846 dropped) and the debounced sweep heals coverage to >=95%', async () => {
    vi.useFakeTimers()
    try {
      const db = new Database(':memory:')
      migrate(db)
      const total = 900
      for (let i = 0; i < total; i++) {
        upsertNode(db, {
          id: `card:bulk${i}`, type: 'card', project: 'marveen', title: `t${i}`,
          source_ref: `kanban_cards:bulk${i}`, extractor: 'manual',
        })
      }
      const expectedAccepted = EMBED_CONCURRENCY_LIMIT + EMBED_QUEUE_BOUND
      expect(getEmbedDropCount()).toBe(total - expectedAccepted)

      // Let the accepted 54 finish, then let the debounced sweep fire and drain the 846-row
      // backlog -- backfillKgNodeEmbeddings' own 100ms inter-row delay is a fake timer here, so
      // this costs no real wall-clock time.
      await vi.advanceTimersByTimeAsync(2000 + total * 100 + 5000)

      const coverage = db
        .prepare('SELECT COUNT(*) total, SUM(embedding IS NOT NULL) embedded FROM kg_nodes')
        .get() as { total: number; embedded: number }
      expect(coverage.embedded / coverage.total).toBeGreaterThanOrEqual(0.95)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  // F-2 (CYBERSEC NO-GO 39145): a single sweep only ever closed up to BACKFILL_SWEEP_LIMIT (2000)
  // rows and nothing re-armed another one -- measured by CYBERSEC: 2500 NULL rows, one sweep, 446
  // stayed NULL even after +1h of real time. The 846-row backlog in the test above fits in one
  // sweep and never exercised this at all. Re-arming until a pass comes back under the limit.
  it('a backlog bigger than BACKFILL_SWEEP_LIMIT is fully healed by re-arming, not left partially NULL (F-2)', async () => {
    vi.useFakeTimers()
    try {
      const db = new Database(':memory:')
      migrate(db)
      const total = 2500
      for (let i = 0; i < total; i++) {
        upsertNode(db, {
          id: `card:big${i}`, type: 'card', project: 'marveen', title: `t${i}`,
          source_ref: `kanban_cards:big${i}`, extractor: 'manual',
        })
      }
      const expectedAccepted = EMBED_CONCURRENCY_LIMIT + EMBED_QUEUE_BOUND
      const expectedDropped = total - expectedAccepted
      expect(getEmbedDropCount()).toBe(expectedDropped) // 2446, well past BACKFILL_SWEEP_LIMIT (2000)

      // First debounced sweep: closes BACKFILL_SWEEP_LIMIT (2000) of the backlog, hits the LIMIT
      // exactly, and must re-arm itself for the remainder instead of stopping.
      await vi.advanceTimersByTimeAsync(2000 + 2000 * 100 + 5000)
      const afterFirstSweep = db
        .prepare('SELECT COUNT(*) c FROM kg_nodes WHERE embedding IS NULL')
        .get() as { c: number }
      expect(afterFirstSweep.c).toBeGreaterThan(0) // the backlog did not fit in one sweep

      // Second, re-armed sweep: drains what the first pass could not reach.
      await vi.advanceTimersByTimeAsync(2000 + 1000 * 100 + 5000)
      const coverage = db
        .prepare('SELECT COUNT(*) total, SUM(embedding IS NOT NULL) embedded FROM kg_nodes')
        .get() as { total: number; embedded: number }
      expect(coverage.embedded).toBe(coverage.total) // no row left NULL, not just "most"
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  // F-3 (CYBERSEC NO-GO 39145): the sweep timer is cleared to null the moment it fires, before the
  // long-running backfill call it guards even starts -- so a failure arriving while that call is
  // still in flight saw no pending timer and armed a FULLY CONCURRENT second sweep over the same
  // backlog. Measured: backend down + a write every 3s -> 10,761 embed calls in 120s.
  it('a sweep stuck mid-flight is not started a second time by every new failure (F-3 single-flight)', async () => {
    vi.useFakeTimers()
    try {
      const { generateEmbedding } = await import('../db.js')
      const db = new Database(':memory:')
      migrate(db)

      let backlogRowZeroCalls = 0
      vi.mocked(generateEmbedding).mockImplementation((text: string) => {
        if (text === 'backlog-0') {
          backlogRowZeroCalls++
          return new Promise<never>(() => {}) // the sweep gets stuck here -- never settles
        }
        if (text.startsWith('backlog-')) return new Promise<never>(() => {})
        return Promise.reject(new Error('ollama down')) // every "live" write fails too
      })

      // 5 NULL backlog rows, written WITHOUT triggering an embed attempt (explicit embedding:null,
      // same as an operator-run backfill would leave them) -- the sweep itself is what reaches them.
      for (let i = 0; i < 5; i++) {
        upsertNode(db, {
          id: `card:backlog${i}`, type: 'card', project: 'marveen', title: `backlog-${i}`,
          source_ref: `kanban_cards:backlog${i}`, extractor: 'manual', embedding: null,
        })
      }

      // One real-time write fails -> arms the sweep.
      upsertNode(db, {
        id: 'card:live0', type: 'card', project: 'marveen', title: 'live-0',
        source_ref: 'kanban_cards:live0', extractor: 'manual',
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(getEmbedFailedCount()).toBe(1)

      // The debounce fires: the sweep picks up backlog-0 first and gets stuck there (never
      // resolves), simulating a long-running pass against a down backend.
      await vi.advanceTimersByTimeAsync(2000)
      expect(backlogRowZeroCalls).toBe(1)

      // "a write every 3s for 120s" while the backend stays down and the sweep is still stuck.
      for (let i = 1; i <= 40; i++) {
        upsertNode(db, {
          id: `card:live${i}`, type: 'card', project: 'marveen', title: `live-${i}`,
          source_ref: `kanban_cards:live${i}`, extractor: 'manual',
        })
        await vi.advanceTimersByTimeAsync(3000)
      }

      // Without the single-flight guard, each of the 40 failures above re-arms a fully concurrent
      // sweep, each of which re-selects the same NULL backlog and calls generateEmbedding on
      // backlog-0 again. With it, exactly the one sweep from above is ever in flight.
      expect(backlogRowZeroCalls).toBe(1)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

// F-4 (CYBERSEC NO-GO 39145): backfillKgNodeEmbeddings reads a row's text, then awaits
// generateEmbedding (can be slow) before writing it back. If the node's text changes while that
// call is in flight, an unconditional UPDATE would overwrite the row with a vector computed from
// text the row no longer has -- and since the column stops being NULL, this sweep's own
// `WHERE embedding IS NULL` filter would never pick it up again to repair it.
describe('backfillKgNodeEmbeddings guards its write against a text change mid-flight (F-4, card 7f3cbe92)', () => {
  it('does not overwrite the row with a stale-text vector if the text changed while the embed call was in flight', async () => {
    const { generateEmbedding } = await import('../db.js')
    const db = new Database(':memory:')
    migrate(db)

    // Explicit embedding:null -- a NULL row the sweep will pick up, without upsertNode's own
    // auto-embed firing first and racing the test.
    upsertNode(db, {
      id: 'card:f4', type: 'card', project: 'marveen', title: 'old title',
      source_ref: 'kanban_cards:f4', extractor: 'manual', embedding: null,
    })

    let resolveOld!: (v: number[]) => void
    vi.mocked(generateEmbedding).mockImplementation(
      (text: string) =>
        new Promise((resolve) => {
          if (text === 'old title') resolveOld = resolve
          else resolve([9, 9, 9]) // the node's own re-embed on the text change, if it ever runs
        }),
    )

    const sweep = backfillKgNodeEmbeddings(db, 10) // reads text='old title', now awaiting generateEmbedding

    // The node's text changes WHILE the sweep's embed call for the OLD text is still pending.
    upsertNode(db, {
      id: 'card:f4', type: 'card', project: 'marveen', title: 'new title',
      source_ref: 'kanban_cards:f4', extractor: 'manual',
    })
    const immediatelyAfterChange = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:f4') as {
      embedding: Buffer | null
    }
    expect(immediatelyAfterChange.embedding).toBeNull() // textChanged clears it synchronously (N-1)

    // Now the sweep's stale embed call (for text the row no longer has) resolves.
    resolveOld([1, 2, 3])
    await sweep

    const after = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:f4') as {
      embedding: Buffer | null
    }
    // Must NOT be the stale [1,2,3] vector (computed from text the row no longer has) -- the
    // guarded UPDATE must have been a no-op because the title no longer matched what the sweep
    // read. It may legitimately be [9,9,9] (the node's own fire-and-forget re-embed for 'new
    // title', which this mock resolves immediately) or still NULL if that has not run yet either
    // way -- both are correct; only the stale vector landing would be the bug.
    expect(after.embedding === null ? null : JSON.parse(after.embedding.toString())).not.toEqual([1, 2, 3])
    db.close()
  })
})

// N-A (CYBERSEC NO-GO 39187, card 7f3cbe92): a trigger arriving while a sweep is already RUNNING
// used to be silently dropped -- a second write batch landing mid-sweep (healthy backend, no
// outage) left its own drops permanently NULL, because the running sweep's SELECT snapshot
// predates them and the normal re-arm (attempted >= limit) never fires for a backlog that fits
// under the cap.
describe('N-A: a trigger that arrives while a sweep is already running is not dropped (card 7f3cbe92)', () => {
  it('a second batch landing mid-sweep (healthy backend) is still fully healed, not left 246/600 NULL forever', async () => {
    vi.useFakeTimers()
    try {
      const db = new Database(':memory:')
      migrate(db)
      const perBatch = 300
      const expectedAccepted = EMBED_CONCURRENCY_LIMIT + EMBED_QUEUE_BOUND
      const expectedDroppedPerBatch = perBatch - expectedAccepted

      for (let i = 0; i < perBatch; i++) {
        upsertNode(db, {
          id: `card:na1-${i}`, type: 'card', project: 'marveen', title: `t1-${i}`,
          source_ref: `kanban_cards:na1-${i}`, extractor: 'manual',
        })
      }
      expect(getEmbedDropCount()).toBe(expectedDroppedPerBatch)

      // Let the debounce fire so the first sweep STARTS, but stop well before it could finish
      // (246 rows * 100ms = ~24.6s) -- the second batch below lands while it is still running.
      await vi.advanceTimersByTimeAsync(2000 + 500)

      for (let i = 0; i < perBatch; i++) {
        upsertNode(db, {
          id: `card:na2-${i}`, type: 'card', project: 'marveen', title: `t2-${i}`,
          source_ref: `kanban_cards:na2-${i}`, extractor: 'manual',
        })
      }
      expect(getEmbedDropCount()).toBe(expectedDroppedPerBatch * 2)

      // Drain in a loop rather than one hand-computed window: the first sweep must finish, the
      // re-arm (requested mid-flight, N-A) must run a second sweep over the backlog batch 2 left,
      // and that needs to be observed regardless of exactly how the two sweeps interleave.
      const coverageOf = (): { total: number; embedded: number } =>
        db.prepare('SELECT COUNT(*) total, SUM(embedding IS NOT NULL) embedded FROM kg_nodes').get() as {
          total: number
          embedded: number
        }
      for (let i = 0; i < 40 && coverageOf().embedded < perBatch * 2; i++) {
        await vi.advanceTimersByTimeAsync(5000)
      }

      const coverage = coverageOf()
      expect(coverage.total).toBe(perBatch * 2)
      expect(coverage.embedded).toBe(coverage.total) // not 354/600 (the measured regression)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

// L-2 (CYBERSEC NO-GO 39187, card 7f3cbe92): `attempted >= limit` ignored whether a pass actually
// embedded anything, so a permanently-down backend re-armed forever at the base 2s cadence
// (measured: ~6k calls/10min, zero effect). Bounded exponential backoff caps this.
describe('L-2: a permanently-down backend backs off instead of re-arming forever (card 7f3cbe92)', () => {
  it('embed call count over 10 simulated minutes stays bounded, not ~300 (the base-cadence count)', async () => {
    vi.useFakeTimers()
    try {
      const { generateEmbedding } = await import('../db.js')
      vi.mocked(generateEmbedding).mockResolvedValue(null) // backend down, every call fails, never throws

      const db = new Database(':memory:')
      migrate(db)
      upsertNode(db, {
        id: 'card:l2seed', type: 'card', project: 'marveen', title: 'seed',
        source_ref: 'kanban_cards:l2seed', extractor: 'manual',
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(getEmbedFailedCount()).toBe(1) // armed the sweep

      vi.mocked(generateEmbedding).mockClear()
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

      // One NULL row per pass -> one call per pass. Base cadence (2s, never backing off) would be
      // ~300 passes in 10 minutes; capped exponential backoff (2s doubling to a 60s ceiling)
      // caps it far lower.
      expect(vi.mocked(generateEmbedding).mock.calls.length).toBeLessThan(50)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

// N-B (CYBERSEC NO-GO 39187, card 7f3cbe92): the OTHER half of F-4's stale-write race -- F-4 only
// guarded the backfill sweep's own UPDATE; scheduleKgNodeEmbedding's UPDATE (the ordinary
// fire-and-forget auto-embed path every write goes through) was still unconditional.
describe('N-B: scheduleKgNodeEmbedding guards its own write against reversed completion order (card 7f3cbe92)', () => {
  it('an older, slower embed call cannot overwrite a newer vector that already landed', async () => {
    const { generateEmbedding } = await import('../db.js')
    const db = new Database(':memory:')
    migrate(db)

    let resolveOld!: (v: number[]) => void
    vi.mocked(generateEmbedding).mockImplementation(
      (text: string) =>
        new Promise((resolve) => {
          if (text === 'old title') resolveOld = resolve
          else resolve([2, 2, 2]) // the newer write's own embed, resolves immediately
        }),
    )

    upsertNode(db, {
      id: 'card:nb', type: 'card', project: 'marveen', title: 'old title',
      source_ref: 'kanban_cards:nb', extractor: 'manual',
    })
    // Text changes WHILE the first embed call (for 'old title') is still pending -- clears to
    // NULL synchronously (N-1) and schedules its OWN embed call, which this mock resolves at once.
    upsertNode(db, {
      id: 'card:nb', type: 'card', project: 'marveen', title: 'new title',
      source_ref: 'kanban_cards:nb', extractor: 'manual',
    })
    await vi.waitFor(() => {
      const row = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:nb') as { embedding: Buffer | null }
      if (row.embedding === null) throw new Error('not written yet')
    })
    const afterNew = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:nb') as { embedding: Buffer }
    expect(JSON.parse(afterNew.embedding.toString())).toEqual([2, 2, 2])

    // Now the STALE, older call (for text the row no longer has) finally resolves.
    resolveOld([9, 9, 9])
    await new Promise((r) => setTimeout(r, 0))

    const after = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:nb') as { embedding: Buffer }
    expect(JSON.parse(after.embedding.toString())).toEqual([2, 2, 2]) // NOT overwritten with [9,9,9]
    db.close()
  })
})
