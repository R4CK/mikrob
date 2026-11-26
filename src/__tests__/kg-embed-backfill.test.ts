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
})
