// Card 6d542dc9: 0/890 kg_nodes had a populated embedding column, so hybridKgSearch's
// semantic branch was dead graph-wide (root cause: upsertNode never generated one). This
// covers the fix: kgEmbedText's field join, upsertNode's fire-and-forget auto-embed on new
// writes, and backfillKgNodeEmbeddings draining existing NULL rows -- same shape as
// src/db.ts's backfillEmbeddings()/scheduleEmbedding() for memories, reusing generateEmbedding
// (local Ollama only, no external call).

import { describe, it, expect, vi, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, upsertNode, kgEmbedText, backfillKgNodeEmbeddings } from '../kg/store.js'

vi.mock('../db.js', () => ({
  generateEmbedding: vi.fn(async (text: string) => (text ? [0.1, 0.2, 0.3] : null)),
}))

afterEach(() => {
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
