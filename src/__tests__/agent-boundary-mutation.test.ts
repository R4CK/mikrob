// Card 52654aff (WhiteHat F2 on 86d5de34, msg 10474): the agent/shared boundary
// (`agent_id = ? OR category = 'shared'`) regression coverage only caught 1 of
// the 4 SQL variants that enforce it. Mutating the real src/db.ts to widen the
// filter (e.g. dropping the agent check) left 102 search/DB tests green on 3 of
// the 4 variants -- including the FTS "plain" branch, which WhiteHat proved
// leaks another agent's row through a direct call. The caught variant (vector
// search, no category) already has a regression test in embed-model-split.test.ts
// ("vectorSearch: the agent/shared boundary is enforced, not incidental", card
// 0a34377f WhiteHat N4); this file adds the 3 that were missing:
//   1. searchAgentMemories FTS branch, no category (the hook's lexical branch)
//   2. searchAgentMemories FTS branch, with category
//   3. vectorSearch branch, with category (via hybridSearch, vectorSearch itself
//      is not exported)
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase, getDb, hybridSearch, searchAgentMemories, clearMemoryCache } from '../db.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => clearMemoryCache())
afterEach(() => vi.unstubAllGlobals())

function insertMemory(agentId: string, category: string, content: string, keywords: string, extra?: { embedding?: number[] }) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, embedding)
     VALUES ('0', ?, 'semantic', 1.0, ?, ?, ?, ?, ?, ?)`
  ).run(content, now, now, agentId, category, keywords, extra?.embedding ? JSON.stringify(extra.embedding) : null)
}

describe('searchAgentMemories FTS branch, no category: agent/shared boundary (card 52654aff F2, the hook lexical branch)', () => {
  it('never returns another agent\'s non-shared row', () => {
    insertMemory('attacker', 'warm', 'attacker own row zzzftsplainboundary', 'zzzftsplainboundary')
    insertMemory('victim', 'warm', 'victim non-shared row zzzftsplainboundary', 'zzzftsplainboundary')

    const hits = searchAgentMemories('attacker', 'zzzftsplainboundary', 10)
    const contents = hits.map(m => m.content)
    expect(contents).toContain('attacker own row zzzftsplainboundary')
    expect(contents).not.toContain('victim non-shared row zzzftsplainboundary')
  })

  it('still returns a shared-category row belonging to another agent', () => {
    insertMemory('other-agent', 'shared', 'other agent shared row zzzftsplainshared', 'zzzftsplainshared')

    const hits = searchAgentMemories('requesting-agent', 'zzzftsplainshared', 10)
    expect(hits.map(m => m.content)).toContain('other agent shared row zzzftsplainshared')
  })
})

describe('searchAgentMemories FTS branch, with category: agent/shared boundary (card 52654aff F2)', () => {
  it('never returns another agent\'s non-shared row even when a category filter is also applied', () => {
    insertMemory('attacker', 'hot', 'attacker own row zzzftscatboundary', 'zzzftscatboundary')
    insertMemory('victim', 'hot', 'victim non-shared row zzzftscatboundary', 'zzzftscatboundary')

    const hits = searchAgentMemories('attacker', 'zzzftscatboundary', 10, undefined, true, 'hot')
    const contents = hits.map(m => m.content)
    expect(contents).toContain('attacker own row zzzftscatboundary')
    expect(contents).not.toContain('victim non-shared row zzzftscatboundary')
  })

  it('still returns a shared-category row belonging to another agent when it matches the category filter', () => {
    insertMemory('other-agent', 'shared', 'other agent shared row zzzftscatshared', 'zzzftscatshared')

    const hits = searchAgentMemories('requesting-agent', 'zzzftscatshared', 10, undefined, true, 'shared')
    expect(hits.map(m => m.content)).toContain('other agent shared row zzzftscatshared')
  })
})

describe('vectorSearch branch, with category: agent/shared boundary (card 52654aff F2)', () => {
  function stubEmbedding(vec: number[]) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ embedding: vec }) })))
  }

  it('never returns another agent\'s non-shared row through hybridSearch with a category filter', async () => {
    // Identical embeddings to the query on both rows: only the agent/category
    // boundary, not cosine distance, can explain the victim row's exclusion.
    insertMemory('attacker', 'cold', 'attacker own row zzzvectorcatboundary', 'alpha', { embedding: [1, 0, 0, 0] })
    insertMemory('victim', 'cold', 'victim non-shared row zzzvectorcatboundary', 'alpha', { embedding: [1, 0, 0, 0] })

    stubEmbedding([1, 0, 0, 0])
    const hits = await hybridSearch('attacker', 'zzzznincsilyenszovectorcat', 10, undefined, 'cold')
    const contents = hits.map(m => m.content)
    expect(contents).toContain('attacker own row zzzvectorcatboundary')
    expect(contents).not.toContain('victim non-shared row zzzvectorcatboundary')
  })

  it('still returns a shared-category row belonging to another agent when it matches the category filter', async () => {
    insertMemory('other-agent', 'shared', 'other agent shared row zzzvectorcatshared', 'alpha', { embedding: [1, 0, 0, 0] })

    stubEmbedding([1, 0, 0, 0])
    const hits = await hybridSearch('requesting-agent', 'zzzznincsilyenszovectorcatshared', 10, undefined, 'shared')
    expect(hits.map(m => m.content)).toContain('other agent shared row zzzvectorcatshared')
  })
})
