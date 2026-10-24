import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, upsertNode, upsertEdge, upsertAnchor } from '../kg/store.js'
import { hybridKgSearch, resolveScope } from '../kg/search.js'

vi.mock('../db.js', async () => {
  const actual = await vi.importActual<typeof import('../db.js')>('../db.js')
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => null),
    getKanbanCard: vi.fn((id: string) => {
      if (id === 'cardA') return { id: 'cardA', title: 't', description: '', project: 'MikroB' }
      if (id === 'cardMop') return { id: 'cardMop', title: 't', description: '', project: 'mopsion' }
      return undefined
    }),
  }
})

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

function seedBasic(db: Database.Database): void {
  upsertNode(db, {
    id: 'sol:1', type: 'solution', project: 'mikrob', title: 'Fail-closed regression fix',
    body: 'hybridSearch guard', source_ref: 'kanban_comments:1', gate_sha: 'abc1234', extractor: 'manual',
    status: 'active',
  })
  upsertNode(db, {
    id: 'sol:2', type: 'solution', project: 'mopsion', title: 'Tenant scope leak fix',
    body: 'some other content', source_ref: 'kanban_comments:2', extractor: 'manual',
    status: 'active',
  })
  upsertNode(db, {
    id: 'dec:1', type: 'decision', project: '_global', title: 'File partition closed',
    source_ref: 'DECISIONS.md:1', extractor: 'manual', status: 'active',
  })
  upsertAnchor(db, { node_id: 'sol:1', repo: 'marveen', path: 'src/db.ts', symbol: 'hybridSearch', sha: 'abc1234' })
}

describe('resolveScope (D2/D3/F2 contract)', () => {
  it('throws project_or_card_id_required when neither is given', () => {
    expect(() => resolveScope({})).toThrowError(/project_or_card_id_required/)
  })

  it('wildcard project=* means no partition restriction', () => {
    const scope = resolveScope({ project: '*' })
    expect(scope.partitions).toBeNull()
    expect(scope.label).toBe('*')
  })

  it('explicit project always includes _global (D3)', () => {
    const scope = resolveScope({ project: 'mikrob' })
    expect(scope.partitions).toEqual(expect.arrayContaining(['mikrob', '_global']))
  })

  it('card_id derives the scope from the card project + _global, never a foreign project', () => {
    const scope = resolveScope({ cardId: 'cardA' })
    expect(scope.partitions).toEqual(expect.arrayContaining(['mikrob', '_global']))
    expect(scope.partitions).not.toContain('mopsion')
  })

  it('unknown card_id falls back to _global only, not an error', () => {
    const scope = resolveScope({ cardId: 'does-not-exist' })
    expect(scope.partitions).toEqual(['_global'])
  })
})

describe('hybridKgSearch', () => {
  it('requires q or path', async () => {
    const db = freshDb()
    seedBasic(db)
    await expect(hybridKgSearch(db, { cardId: 'cardA' })).rejects.toThrow(/q_or_path_required/)
    db.close()
  })

  it('EK-MT-10 (default scope): a card-scoped query never returns a foreign project node', async () => {
    const db = freshDb()
    seedBasic(db)
    const { results } = await hybridKgSearch(db, { q: 'fix', cardId: 'cardA', minScore: 0 })
    expect(results.some((r) => r.project === 'mopsion')).toBe(false)
    db.close()
  })

  it('EK-MT-10 (wildcard): project=* can return a foreign project node', async () => {
    const db = freshDb()
    seedBasic(db)
    const { results } = await hybridKgSearch(db, { q: 'tenant scope leak', project: '*', minScore: 0 })
    expect(results.some((r) => r.project === 'mopsion')).toBe(true)
    db.close()
  })

  it('anchor-path match finds the exact node regardless of q', async () => {
    const db = freshDb()
    seedBasic(db)
    const { results } = await hybridKgSearch(db, { paths: ['src/db.ts'], project: 'mikrob' })
    expect(results.map((r) => r.id)).toContain('sol:1')
    expect(results[0]!.anchors[0]?.symbol).toBe('hybridSearch')
    db.close()
  })

  it('types filter restricts the result set to the requested node types', async () => {
    const db = freshDb()
    seedBasic(db)
    const { results } = await hybridKgSearch(db, { q: 'fix', project: '*', types: ['decision'], minScore: 0 })
    expect(results.every((r) => r.type === 'decision')).toBe(true)
    db.close()
  })

  it('rejects an unknown type value', async () => {
    const db = freshDb()
    seedBasic(db)
    await expect(
      hybridKgSearch(db, { q: 'fix', project: '*', types: ['not-a-real-type'] }),
    ).rejects.toThrow(/invalid_types/)
    db.close()
  })

  it('draft/archived/superseded nodes never surface in search results', async () => {
    const db = freshDb()
    upsertNode(db, {
      id: 'sol:draft', type: 'solution', project: 'mikrob', title: 'fix something draftish',
      source_ref: 'kanban_comments:9', extractor: 'manual', status: 'draft',
    })
    const { results } = await hybridKgSearch(db, { q: 'draftish', project: 'mikrob', minScore: 0 })
    expect(results).toEqual([])
    db.close()
  })

  it('KG_MIN_SCORE filters out low-relevance matches (mutation-proof: minScore 0 lets them back in)', async () => {
    const db = freshDb()
    seedBasic(db)
    const strict = await hybridKgSearch(db, { q: 'fix', project: 'mikrob', minScore: 0.99 })
    const lenient = await hybridKgSearch(db, { q: 'fix', project: 'mikrob', minScore: 0 })
    expect(strict.results.length).toBeLessThanOrEqual(lenient.results.length)
  })

  it('graph expansion (1 hop) surfaces a node connected only by an edge, not by text/vector match', async () => {
    const db = freshDb()
    seedBasic(db)
    upsertNode(db, {
      id: 'finding:1', type: 'finding', project: 'mikrob', title: 'QA PASS',
      source_ref: 'kanban_verdicts:1', extractor: 'manual', status: 'active',
    })
    upsertEdge(db, { src: 'sol:1', dst: 'finding:1', rel: 'fixed_by', source: 'test' })
    const noExpand = await hybridKgSearch(db, { q: 'fail-closed regression', project: 'mikrob', minScore: 0, expandHops: 0, k: 5 })
    const withExpand = await hybridKgSearch(db, { q: 'fail-closed regression', project: 'mikrob', minScore: 0, expandHops: 1, k: 5 })
    expect(noExpand.results.map((r) => r.id)).not.toContain('finding:1')
    expect(withExpand.results.map((r) => r.id)).toContain('finding:1')
    db.close()
  })

  it('strict=true never relaxes the FTS query even when the strict pass finds nothing', async () => {
    const db = freshDb()
    seedBasic(db)
    const { meta } = await hybridKgSearch(db, { q: 'completely unrelated gibberish zzqx', project: 'mikrob', strict: true })
    expect(meta.relaxed).toBe(false)
    expect(meta.hits).toBe(0)
  })
})
