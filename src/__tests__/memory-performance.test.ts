import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import {
  initDatabase,
  getDb,
  saveAgentMemory,
  getAgentMemories,
  updateMemory,
  clearMemoryCache,
  getMemoryCacheSize,
  backfillEmbeddings,
} from '../db.js'

// All tests use an in-memory SQLite database so they never touch the real store.
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  clearMemoryCache()
})

// ---------------------------------------------------------------------------
// 1. SQLite pragmas
// ---------------------------------------------------------------------------
describe('SQLite performance pragmas', () => {
  it('cache_size is set to -65536 (64 MB)', () => {
    const row = getDb().pragma('cache_size', { simple: true })
    expect(row).toBe(-65536)
  })

  it('synchronous is NORMAL (1)', () => {
    // SQLite reports NORMAL as integer 1.
    const row = getDb().pragma('synchronous', { simple: true })
    expect(row).toBe(1)
  })

  // journal_mode and mmap_size cannot be verified on :memory: databases:
  // - WAL is silently downgraded to 'memory' journal for in-memory DBs.
  // - mmap_size is a no-op without a backing file.
  // Both are applied on the real on-disk DB; here we only test the pragmas
  // that behave identically regardless of the storage path.
})

// ---------------------------------------------------------------------------
// 2. In-process TTL cache
// ---------------------------------------------------------------------------
describe('getAgentMemories in-process cache', () => {
  const AGENT = 'cache-test-agent'

  it('cold miss: returns data from DB, cache is populated', () => {
    saveAgentMemory(AGENT, 'First memory', 'warm', 'keyword1')
    const before = getMemoryCacheSize()
    getAgentMemories(AGENT, 5)
    expect(getMemoryCacheSize()).toBe(before + 1)
  })

  it('warm hit: second call returns same object from cache (no DB round-trip)', () => {
    saveAgentMemory(AGENT, 'Cache hit check', 'warm', 'keyword2')
    const first = getAgentMemories(AGENT, 5)
    const second = getAgentMemories(AGENT, 5)
    // Same array reference means the cache was hit.
    expect(second).toBe(first)
  })

  it('cache key is per agentId+limit: different limit = separate entry', () => {
    getAgentMemories(AGENT, 5)
    getAgentMemories(AGENT, 10)
    // Both limit variants should be cached as separate entries.
    expect(getMemoryCacheSize()).toBeGreaterThanOrEqual(2)
  })

  it('saveAgentMemory invalidates the cache for that agent', () => {
    const before = getAgentMemories(AGENT, 5)
    saveAgentMemory(AGENT, 'Invalidation trigger', 'hot', 'new')
    // After write the cache for this agent should be gone.
    expect(getMemoryCacheSize()).toBe(0)
    const after = getAgentMemories(AGENT, 5)
    // Different reference: fresh DB read.
    expect(after).not.toBe(before)
    // New memory must appear.
    expect(after.some(m => m.content === 'Invalidation trigger')).toBe(true)
  })

  it('updateMemory with agentId invalidates the cache', () => {
    const { id } = saveAgentMemory(AGENT, 'Update me', 'warm', 'upd')
    getAgentMemories(AGENT, 5) // warm the cache
    const sizeBefore = getMemoryCacheSize()
    updateMemory(id, 'Updated content', 'warm', AGENT, 'upd')
    expect(getMemoryCacheSize()).toBeLessThan(sizeBefore)
  })

  it('cache is isolated between agents', () => {
    const OTHER = 'other-agent'
    saveAgentMemory(AGENT, 'Agent A memory', 'cold', 'a')
    saveAgentMemory(OTHER, 'Agent B memory', 'cold', 'b')
    getAgentMemories(AGENT, 5)
    getAgentMemories(OTHER, 5)
    const sizeBefore = getMemoryCacheSize()
    // Write to AGENT should not evict OTHER's cache entry.
    saveAgentMemory(AGENT, 'New for agent A', 'hot')
    const sizeAfter = getMemoryCacheSize()
    // At least one entry (OTHER's) should survive.
    expect(sizeAfter).toBeGreaterThan(0)
    expect(sizeAfter).toBeLessThan(sizeBefore)
  })

  it('clearMemoryCache wipes all entries', () => {
    getAgentMemories(AGENT, 5)
    expect(getMemoryCacheSize()).toBeGreaterThan(0)
    clearMemoryCache()
    expect(getMemoryCacheSize()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Embedding backfill
// ---------------------------------------------------------------------------
describe('backfillEmbeddings', () => {
  it('returns 0 when every memory already has an embedding', async () => {
    // FLAKY FIX (card 0677c9ad). This used to assume "Ollama is not running in the test
    // environment" and simply call backfillEmbeddings() on whatever the shared DB happened to
    // contain. Both halves of that were wrong:
    //   * backfillEmbeddings() walks EVERY memory with a NULL embedding and sleeps 100ms per row,
    //     so its runtime is a function of how many rows OTHER test files inserted before it. Run
    //     alone it saw a handful and passed; run in the full suite it saw enough to blow the 5s
    //     test timeout. That is the order-dependence -- via row COUNT, not via state leakage.
    //   * Ollama IS running on this host now (the local-LLM queue work made it a live dependency),
    //     so each row also costs a real network round-trip instead of failing fast.
    // The assertion was vacuous anyway: `typeof count === 'number'` and `>= 0` hold for every
    // possible return value, so the test could only ever fail by timing out.
    //
    // Now the test establishes its OWN precondition -- the exact one its name claims -- so it is
    // independent of suite order and does no network I/O at all.
    getDb().prepare("UPDATE memories SET embedding = ? WHERE embedding IS NULL").run('[]')
    const remaining = getDb()
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NULL')
      .get() as { n: number }
    expect(remaining.n).toBe(0) // precondition actually holds

    const count = await backfillEmbeddings()
    expect(count).toBe(0) // nothing to backfill -> exactly 0, not merely ">= 0"
  })

  // FLAKY FIX #2 (card ac74b0e9, QA2 found it red in a full fleet-test run). One test here was
  // repaired for suite-order dependence under card 0677c9ad; THIS one was left calling the real
  // Ollama, which is the same defect class one door down -- a pattern gets fixed in the copy that
  // happened to fail.
  //
  // MEASURED CAUSE, not guessed: `nomic-embed-text` costs 4.15s on its FIRST call (the model load)
  // and 0.022s once warm -- 190x. The 5s budget therefore decided the verdict by whether some other
  // process had warmed the model, and the fleet's local-LLM work keeps a 7B model resident on the
  // same GPU. Raising the timeout would only move the coin-flip.
  //
  // But the timeout was the smaller problem. The old test was named "...updates them when Ollama
  // responds" and asserted NOTHING about that -- its own comment said "no assertion on count here",
  // and its other comment claimed a stub that did not exist. It could not fail for a real reason:
  // an embedding that came back mangled, a count that did not match, a row updated when the backend
  // was down. Stubbing `fetch` (the idiom already used in six suites here) makes both branches
  // deterministic and finally tests the sentence in the name.
  const OLLAMA_EMBEDDING = [0.1, 0.2, 0.3]

  /** The one row this test cares about, with every other NULL closed off first. */
  function insertRowNeedingBackfill(content: string): number {
    const db = getDb()
    // Establish the precondition instead of assuming it: backfillEmbeddings walks EVERY NULL row,
    // so a neighbour's leftover would make the count assertions below meaningless.
    db.prepare("UPDATE memories SET embedding = ? WHERE embedding IS NULL").run('[]')
    const now = Math.floor(Date.now() / 1000)
    const result = db.prepare(
      `INSERT INTO memories (chat_id, topic_key, content, sector, salience,
       created_at, accessed_at, agent_id, category, auto_generated, keywords)
       VALUES (?, NULL, ?, 'semantic', 1.0, ?, ?, ?, 'cold', 0, NULL)`
    ).run('test-chat', content, now, now, 'backfill-test-agent')
    const id = Number(result.lastInsertRowid)
    const before = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as { embedding: string | null }
    expect(before.embedding).toBeNull()
    return id
  }

  it('updates the row when Ollama responds -- the case the name always claimed', async () => {
    const id = insertRowNeedingBackfill('Backfill target content')
    try {
      vi.stubGlobal('fetch', async () => ({
        ok: true,
        status: 200,
        json: async () => ({ embedding: OLLAMA_EMBEDDING }),
      }))
      const count = await backfillEmbeddings()
      expect(count).toBe(1) // exactly the one row, not ">= 0"

      const after = getDb().prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as { embedding: string | null }
      // The stored value must be the embedding that came back -- "some valid JSON array" would pass
      // just as happily on a row that was written with the wrong vector.
      expect(JSON.parse(after.embedding!)).toEqual(OLLAMA_EMBEDDING)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('leaves the row NULL when Ollama is unreachable, and does not throw', async () => {
    const id = insertRowNeedingBackfill('Backfill target while Ollama is down')
    try {
      vi.stubGlobal('fetch', async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
      })
      const count = await backfillEmbeddings()
      expect(count).toBe(0) // nothing was written, and the failure was swallowed on purpose

      const after = getDb().prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as { embedding: string | null }
      expect(after.embedding).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('CONTROL: a malformed response is not written -- the stub can express failure', async () => {
    // Without this, the two tests above share one blind spot: a `generateEmbedding` that returned
    // something truthy for ANY response would satisfy both. Ollama answering 200 with no embedding
    // field is the realistic shape (wrong model name, for instance).
    const id = insertRowNeedingBackfill('Backfill target with a malformed reply')
    try {
      vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }))
      expect(await backfillEmbeddings()).toBe(0)
      const after = getDb().prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as { embedding: string | null }
      expect(after.embedding).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
