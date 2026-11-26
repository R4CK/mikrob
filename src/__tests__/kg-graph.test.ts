import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, upsertNode, upsertEdge, setNodeStatus } from '../kg/store.js'
import { getKgGraph } from '../kg/graph.js'

function seed(db: Database.Database, n: number, project = 'p1'): void {
  for (let i = 0; i < n; i++) {
    upsertNode(db, {
      id: `node:${project}:${i}`, type: 'solution', project, title: `title ${i}`,
      source_ref: 'test', extractor: 'manual', status: 'active',
    })
  }
}

describe('getKgGraph (card a1d57d99)', () => {
  it('returns nodes with only id/type/label/project, no body/snippet fields', () => {
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'n1', type: 'solution', project: 'p1', title: 'the title', body: 'secret body text',
      source_ref: 'test', extractor: 'manual', status: 'active',
    })
    const { nodes } = getKgGraph(db, undefined, 500)
    expect(nodes).toEqual([{ id: 'n1', type: 'solution', label: 'the title', project: 'p1' }])
    db.close()
  })

  it('caps the node count at the given limit', () => {
    const db = new Database(':memory:')
    migrate(db)
    seed(db, 10)
    const { nodes } = getKgGraph(db, undefined, 3)
    expect(nodes).toHaveLength(3)
    db.close()
  })

  it('filters by project when given', () => {
    const db = new Database(':memory:')
    migrate(db)
    seed(db, 3, 'alpha')
    seed(db, 2, 'beta')
    const { nodes } = getKgGraph(db, 'beta', 500)
    expect(nodes.every((n) => n.project === 'beta')).toBe(true)
    expect(nodes).toHaveLength(2)
    db.close()
  })

  it('excludes archived nodes, same terminal-status rule as computeKgStats', () => {
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'n1', type: 'solution', project: 'p1', title: 't', source_ref: 'test',
      extractor: 'manual', status: 'active',
    })
    setNodeStatus(db, 'n1', 'archived', 'test')
    const { nodes } = getKgGraph(db, undefined, 500)
    expect(nodes).toHaveLength(0)
    db.close()
  })

  it('only includes edges whose both endpoints survive the node cap/filter', () => {
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, { id: 'a', type: 'solution', project: 'p1', title: 'a', source_ref: 't', extractor: 'm', status: 'active' })
    upsertNode(db, { id: 'b', type: 'solution', project: 'p1', title: 'b', source_ref: 't', extractor: 'm', status: 'active' })
    upsertNode(db, { id: 'c', type: 'solution', project: 'other', title: 'c', source_ref: 't', extractor: 'm', status: 'active' })
    upsertEdge(db, { src: 'a', dst: 'b', rel: 'similar_to', source: 't' })
    upsertEdge(db, { src: 'a', dst: 'c', rel: 'similar_to', source: 't' })
    const { edges } = getKgGraph(db, 'p1', 500)
    expect(edges).toEqual([{ source: 'a', target: 'b', type: 'similar_to' }])
    db.close()
  })

  it('returns empty edges (not a crash) when there are zero matching nodes', () => {
    const db = new Database(':memory:')
    migrate(db)
    const { nodes, edges } = getKgGraph(db, 'nothing-here', 500)
    expect(nodes).toEqual([])
    expect(edges).toEqual([])
    db.close()
  })
})
