// Card 5ecf6133: the 343-row backfill for kg_anchors.path === 'kanban_comments:<id>' (the bug
// capture-pipeline.ts:541 used to write before this card's forward-fix). Plan/apply/restore are
// all exercised against a real in-memory kg DB (migrate()), not a hand-rolled fixture table, so
// the FK + UNIQUE constraints that a live store/knowledge-graph.db enforces are exercised too.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, upsertNode, upsertAnchor, type KgAnchorRow } from '../kg/store.js'
import {
  planAnchorPathBackfill,
  applyAnchorPathBackfill,
  restoreAnchorPathBackfill,
  PLACEHOLDER_PATH_RX,
  MAX_FILE_ANCHORS_PER_PLACEHOLDER,
} from '../kg/anchor-path-backfill.js'

function freshKgDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

function seedSolutionWithPlaceholder(db: Database.Database, nodeId: string, sha: string, reviewId: number): void {
  upsertNode(db, {
    id: nodeId,
    type: 'solution',
    project: 'mikrob',
    title: 'a fix',
    source_ref: `kanban_comments:${reviewId}`,
    gate_sha: sha,
    extractor: 'local-llm:kg-capture@v1',
  })
  upsertAnchor(db, { node_id: nodeId, repo: 'marveen', path: `kanban_comments:${reviewId}`, sha, state: 'fresh' })
}

describe('PLACEHOLDER_PATH_RX', () => {
  it('matches the exact bug shape and nothing else', () => {
    expect(PLACEHOLDER_PATH_RX.test('kanban_comments:32896')).toBe(true)
    expect(PLACEHOLDER_PATH_RX.test('src/kg/search.ts')).toBe(false)
    expect(PLACEHOLDER_PATH_RX.test('kanban_comments:abc')).toBe(false) // review ids are numeric
    expect(PLACEHOLDER_PATH_RX.test('kanban_cards:abc123')).toBe(false)
  })
})

describe('planAnchorPathBackfill', () => {
  it('groups placeholder rows by sha and calls filesForSha once per distinct sha', () => {
    const db = freshKgDb()
    seedSolutionWithPlaceholder(db, 'sol:a:0', '1111111', 1)
    seedSolutionWithPlaceholder(db, 'sol:a:1', '1111111', 2) // same sha, second solution on the same card
    seedSolutionWithPlaceholder(db, 'sol:b:0', '2222222', 3)
    let calls = 0
    const plan = planAnchorPathBackfill(db, {
      filesForSha: (sha) => {
        calls++
        return sha === '1111111' ? ['src/a.ts'] : ['src/b.ts', 'src/c.ts']
      },
    })
    expect(calls).toBe(2) // one call per distinct sha, not per row
    expect(plan.toBackfill).toHaveLength(3)
    expect(plan.unresolved).toHaveLength(0)
    const forB = plan.toBackfill.find((i) => i.placeholder.node_id === 'sol:b:0')!
    expect(forB.resolvedPaths).toEqual(['src/b.ts', 'src/c.ts'])
  })

  it('a sha that resolves to nothing goes to unresolved, not a guessed path', () => {
    const db = freshKgDb()
    seedSolutionWithPlaceholder(db, 'sol:a:0', 'deadbee', 1)
    const plan = planAnchorPathBackfill(db, { filesForSha: () => [] })
    expect(plan.toBackfill).toHaveLength(0)
    expect(plan.unresolved).toHaveLength(1)
    expect(plan.unresolved[0]!.path).toBe('kanban_comments:1')
  })

  it('caps resolved paths at MAX_FILE_ANCHORS_PER_PLACEHOLDER', () => {
    const db = freshKgDb()
    seedSolutionWithPlaceholder(db, 'sol:a:0', 'bb11111', 1)
    const manyFiles = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`)
    const plan = planAnchorPathBackfill(db, { filesForSha: () => manyFiles })
    expect(plan.toBackfill[0]!.resolvedPaths).toHaveLength(MAX_FILE_ANCHORS_PER_PLACEHOLDER)
  })

  it('a non-placeholder anchor already holding a real path is left out of the plan entirely', () => {
    const db = freshKgDb()
    upsertNode(db, { id: 'sol:a:0', type: 'solution', project: 'mikrob', title: 't', source_ref: 'kanban_comments:1', extractor: 'x' })
    upsertAnchor(db, { node_id: 'sol:a:0', repo: 'marveen', path: 'src/already-real.ts', sha: 'abc1234', state: 'fresh' })
    const plan = planAnchorPathBackfill(db, { filesForSha: () => ['src/other.ts'] })
    expect(plan.toBackfill).toHaveLength(0)
    expect(plan.unresolved).toHaveLength(0)
  })
})

describe('applyAnchorPathBackfill + restoreAnchorPathBackfill (tested rollback)', () => {
  it('replaces each placeholder with one real-path anchor per resolved file, backup written before any mutation', () => {
    const db = freshKgDb()
    seedSolutionWithPlaceholder(db, 'sol:a:0', '1111111', 1)
    const plan = planAnchorPathBackfill(db, { filesForSha: () => ['src/a.ts', 'src/b.ts'] })

    let backupSeenBeforeMutation: unknown = null
    const result = applyAnchorPathBackfill(
      db,
      plan,
      (backup) => {
        // The backup must be taken from the PRE-mutation state: the placeholder row must still
        // be the one and only anchor for this node_id at the moment writeBackup is called.
        const live = db.prepare('SELECT * FROM kg_anchors WHERE node_id = ?').all('sol:a:0') as KgAnchorRow[]
        backupSeenBeforeMutation = { backup, liveCountAtBackupTime: live.length, liveStillPlaceholder: live[0]?.path }
      },
      () => 1000,
    )

    expect((backupSeenBeforeMutation as { liveCountAtBackupTime: number }).liveCountAtBackupTime).toBe(1)
    expect((backupSeenBeforeMutation as { liveStillPlaceholder: string }).liveStillPlaceholder).toBe('kanban_comments:1')

    expect(result.backfilled).toBe(1)
    expect(result.created).toBe(2)
    expect(result.unresolved).toBe(0)

    const anchorsNow = db.prepare('SELECT * FROM kg_anchors WHERE node_id = ?').all('sol:a:0') as KgAnchorRow[]
    expect(anchorsNow.map((a) => a.path).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(anchorsNow.every((a) => a.path !== 'kanban_comments:1')).toBe(true)
    expect(result.backup.createdIds).toHaveLength(2)
    expect(result.backup.originals).toHaveLength(1)
  })

  it('leaves an unresolved placeholder untouched and still counts it in the backup', () => {
    const db = freshKgDb()
    seedSolutionWithPlaceholder(db, 'sol:a:0', 'deadbee', 1)
    const plan = planAnchorPathBackfill(db, { filesForSha: () => [] })
    const result = applyAnchorPathBackfill(db, plan, () => {}, () => 1000)
    expect(result.backfilled).toBe(0)
    expect(result.created).toBe(0)
    expect(result.unresolved).toBe(1)
    const anchorsNow = db.prepare('SELECT * FROM kg_anchors WHERE node_id = ?').all('sol:a:0') as KgAnchorRow[]
    expect(anchorsNow).toHaveLength(1)
    expect(anchorsNow[0]!.path).toBe('kanban_comments:1')
  })

  it('restoreAnchorPathBackfill undoes an apply exactly: deletes created rows, re-inserts the original by its own id', () => {
    const db = freshKgDb()
    seedSolutionWithPlaceholder(db, 'sol:a:0', '1111111', 1)
    const before = db.prepare('SELECT * FROM kg_anchors WHERE node_id = ?').get('sol:a:0') as KgAnchorRow

    const plan = planAnchorPathBackfill(db, { filesForSha: () => ['src/a.ts', 'src/b.ts'] })
    const result = applyAnchorPathBackfill(db, plan, () => {}, () => 1000)

    restoreAnchorPathBackfill(db, result.backup)

    const after = db.prepare('SELECT * FROM kg_anchors WHERE node_id = ?').all('sol:a:0') as KgAnchorRow[]
    expect(after).toHaveLength(1)
    expect(after[0]).toEqual(before) // byte-identical to the pre-apply row, including its own id
  })

  it('restore after a multi-row apply removes ALL created rows and restores ALL originals', () => {
    const db = freshKgDb()
    seedSolutionWithPlaceholder(db, 'sol:a:0', '1111111', 1)
    seedSolutionWithPlaceholder(db, 'sol:b:0', '2222222', 2)
    const beforeRows = db.prepare('SELECT * FROM kg_anchors ORDER BY id').all() as KgAnchorRow[]

    const plan = planAnchorPathBackfill(db, {
      filesForSha: (sha) => (sha === '1111111' ? ['src/a.ts'] : ['src/b.ts', 'src/c.ts']),
    })
    const result = applyAnchorPathBackfill(db, plan, () => {}, () => 1000)
    expect(db.prepare('SELECT COUNT(*) AS c FROM kg_anchors').get()).toEqual({ c: 3 }) // 1 + 2 created

    restoreAnchorPathBackfill(db, result.backup)
    const afterRows = db.prepare('SELECT * FROM kg_anchors ORDER BY id').all() as KgAnchorRow[]
    expect(afterRows).toEqual(beforeRows)
  })

  // Regression: caught by hand against a copy of the live db before this card ever touched it
  // for real. An unresolved row is never deleted during apply, so it must NOT be in the backup's
  // "originals" -- restoring used to try to re-INSERT it over itself and hit
  // SQLITE_CONSTRAINT_PRIMARYKEY, because its id was still live in the table the whole time.
  it('restore is safe when the run had BOTH resolved and unresolved placeholders mixed together', () => {
    const db = freshKgDb()
    seedSolutionWithPlaceholder(db, 'sol:a:0', '1111111', 1) // resolves
    seedSolutionWithPlaceholder(db, 'sol:b:0', 'deadbee', 2) // does not resolve
    const beforeRows = db.prepare('SELECT * FROM kg_anchors ORDER BY id').all() as KgAnchorRow[]

    const plan = planAnchorPathBackfill(db, {
      filesForSha: (sha) => (sha === '1111111' ? ['src/a.ts'] : []),
    })
    const result = applyAnchorPathBackfill(db, plan, () => {}, () => 1000)
    expect(result.backfilled).toBe(1)
    expect(result.unresolved).toBe(1)

    expect(() => restoreAnchorPathBackfill(db, result.backup)).not.toThrow()
    const afterRows = db.prepare('SELECT * FROM kg_anchors ORDER BY id').all() as KgAnchorRow[]
    expect(afterRows).toEqual(beforeRows)
  })
})
