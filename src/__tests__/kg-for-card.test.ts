import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, upsertNode, upsertEdge, upsertAnchor } from '../kg/store.js'
import { buildForCardPackage } from '../kg/for-card.js'

vi.mock('../db.js', async () => {
  const actual = await vi.importActual<typeof import('../db.js')>('../db.js')
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => null),
    getKanbanCard: vi.fn((id: string) => {
      if (id === 'cardA') {
        return { id: 'cardA', title: 'Fix hybridSearch guard', description: 'touches src/db.ts', project: 'MikroB' }
      }
      return undefined
    }),
  }
})

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

describe('buildForCardPackage (MT-07 dispatch package, EK-MT-6)', () => {
  it('unknown cardId returns 200-shape (empty arrays), never throws', async () => {
    const db = freshDb()
    const pkg = await buildForCardPackage(db, 'does-not-exist')
    expect(pkg.solutions).toEqual([])
    expect(pkg.known_pitfalls).toEqual([])
    expect(pkg.decisions).toEqual([])
    expect(pkg.cross_project_refs).toEqual([])
    db.close()
  })

  it('EK-MT-6: a known pitfall anchored on a file the card mentions is included', async () => {
    const db = freshDb()
    upsertNode(db, {
      id: 'finding:1', type: 'finding', project: 'mikrob', title: 'QA FAIL',
      body: 'regression on hybridSearch', source_ref: 'kanban_verdicts:1', gate_sha: 'deadbee',
      extractor: 'manual', status: 'active',
    })
    upsertAnchor(db, { node_id: 'finding:1', repo: 'marveen', path: 'src/db.ts', sha: 'deadbee' })
    const pkg = await buildForCardPackage(db, 'cardA', { minScore: 0 })
    expect(pkg.known_pitfalls.map((e) => e.card_id)).toContain('finding:1')
    const entry = pkg.known_pitfalls.find((e) => e.card_id === 'finding:1')!
    expect(entry.verdict).toBe('QA FAIL')
    expect(entry.gate_sha).toBe('deadbee')
    db.close()
  })

  it('only structured fields leave the package -- never body/snippet free text (F1 contract)', async () => {
    const db = freshDb()
    upsertNode(db, {
      id: 'sol:1', type: 'solution', project: 'mikrob', title: 'Fix hybridSearch guard',
      body: 'SECRET PROSE THAT MUST NOT LEAK', source_ref: 'kanban_comments:1', extractor: 'manual',
      status: 'active',
    })
    const pkg = await buildForCardPackage(db, 'cardA', { minScore: 0 })
    const serialized = JSON.stringify(pkg)
    expect(serialized).not.toContain('SECRET PROSE')
    db.close()
  })

  it('cross_project_refs only carries card_id + error_class, never body', async () => {
    const db = freshDb()
    upsertNode(db, {
      id: 'sol:1', type: 'solution', project: 'mikrob', title: 'Fix hybridSearch guard',
      source_ref: 'kanban_comments:1', extractor: 'manual', status: 'active',
    })
    upsertNode(db, {
      id: 'sol:foreign', type: 'solution', project: 'mopsion', title: 'Similar fix elsewhere',
      body: 'MOPSION SECRET PROSE', source_ref: 'kanban_comments:2', extractor: 'manual', status: 'active',
    })
    upsertEdge(db, { src: 'sol:1', dst: 'sol:foreign', rel: 'similar_to', source: 'test' })
    const pkg = await buildForCardPackage(db, 'cardA', { minScore: 0 })
    expect(pkg.cross_project_refs.length).toBeGreaterThan(0)
    expect(JSON.stringify(pkg.cross_project_refs)).not.toContain('MOPSION SECRET PROSE')
    expect(Object.keys(pkg.cross_project_refs[0]!).sort()).toEqual(['card_id', 'error_class'])
    db.close()
  })

  it('truncates to maxChars, dropping decisions before solutions, and flags truncated', async () => {
    const db = freshDb()
    const bigBody = 'x'.repeat(400)
    for (let i = 0; i < 5; i++) {
      upsertNode(db, {
        id: `sol:${i}`, type: 'solution', project: 'mikrob', title: `Fix hybridSearch guard ${i}`,
        body: bigBody, source_ref: `kanban_comments:${i}`, extractor: 'manual', status: 'active',
      })
      upsertNode(db, {
        id: `dec:${i}`, type: 'decision', project: 'mikrob', title: `hybridSearch decision ${i}`,
        body: bigBody, source_ref: `DECISIONS.md:${i}`, extractor: 'manual', status: 'active',
      })
    }
    const pkg = await buildForCardPackage(db, 'cardA', { minScore: 0, k: 5, maxChars: 500 })
    expect(pkg.meta.truncated).toBe(true)
    expect(JSON.stringify(pkg).length).toBeLessThanOrEqual(500 + 200) // small slack: one pop can overshoot slightly before the next check
    expect(pkg.decisions.length).toBeLessThan(5)
    db.close()
  })
})
