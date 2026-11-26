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
} from '../kg/store.js'

vi.mock('../db.js', () => ({
  generateEmbedding: vi.fn(async (text: string) => (text ? [0.1, 0.2, 0.3] : null)),
}))

afterEach(async () => {
  const { generateEmbedding } = await import('../db.js')
  vi.mocked(generateEmbedding).mockImplementation(async (text: string) => (text ? [0.1, 0.2, 0.3] : null))
  vi.clearAllMocks()
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

  it('recomputes the embedding (without a NULL gap) when the embed text changed', async () => {
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
    const immediatelyAfterConflict = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:f1b') as { embedding: Buffer }
    expect(immediatelyAfterConflict.embedding).not.toBeNull() // old value kept, not nulled, during the gap
    expect(generateEmbedding).toHaveBeenCalledWith('new title')
    await new Promise((r) => setTimeout(r, 0))
    const after = db.prepare('SELECT embedding FROM kg_nodes WHERE id = ?').get('card:f1b') as { embedding: Buffer }
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
