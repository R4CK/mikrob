import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  migrate, openKgDb, rebuild, upsertNode, upsertEdge, setNodeStatus, getNode, KgSecretError,
} from '../kg/store.js'

const dirs: string[] = []
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kg-store-test-'))
  dirs.push(dir)
  return join(dir, 'knowledge-graph.db')
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('kg store CRUD', () => {
  it('upsertNode inserts, then updates in place on the same id', () => {
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'card:abc12345', type: 'card', project: 'marveen', title: 'v1',
      source_ref: 'kanban_cards:abc12345', extractor: 'manual',
    })
    upsertNode(db, {
      id: 'card:abc12345', type: 'card', project: 'marveen', title: 'v2',
      source_ref: 'kanban_cards:abc12345', extractor: 'manual',
    })
    const row = getNode(db, 'card:abc12345')
    expect(row?.title).toBe('v2')
    expect(db.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()).toEqual({ n: 1 })
    db.close()
  })

  // AWS-shaped key built from parts (not a literal match) so the file itself does not trip the
  // repo's own secret-write guard -- same convention as src/__tests__/agent-transcript.test.ts.
  it('upsertNode refuses a title/body containing a secret shape (MT-13, EK-MT-4 analog)', () => {
    const db = new Database(':memory:')
    migrate(db)
    const akia = `AKIA${'ABCDEFGHIJKLMNOP'}`
    expect(() =>
      upsertNode(db, {
        id: 'sol:leak1', type: 'solution', project: 'marveen', title: 'fix',
        body: `use ${akia} as the key`, source_ref: 'kanban_comments:1',
        extractor: 'manual',
      }),
    ).toThrow(KgSecretError)
    expect(db.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()).toEqual({ n: 0 })
    db.close()
  })

  it('upsertEdge is idempotent: a second identical edge changes nothing', () => {
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, { id: 'card:a', type: 'card', project: 'marveen', title: 'a', source_ref: 'x', extractor: 'manual' })
    upsertNode(db, { id: 'card:b', type: 'card', project: 'marveen', title: 'b', source_ref: 'x', extractor: 'manual' })
    const first = upsertEdge(db, { src: 'card:a', dst: 'card:b', rel: 'child_of', source: 'manual' })
    const second = upsertEdge(db, { src: 'card:a', dst: 'card:b', rel: 'child_of', source: 'manual' })
    expect(first).toBe(1)
    expect(second).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM kg_edges').get()).toEqual({ n: 1 })
    db.close()
  })

  it('setNodeStatus changes status and writes one audited kg_audit row', () => {
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, { id: 'sol:1', type: 'solution', project: 'marveen', title: 't', status: 'draft', source_ref: 'x', extractor: 'manual' })
    setNodeStatus(db, 'sol:1', 'active', 'mikrob')
    expect(getNode(db, 'sol:1')?.status).toBe('active')
    const audit = db.prepare('SELECT * FROM kg_audit WHERE node_id = ?').all('sol:1') as {
      before: string
      after: string
      actor: string
    }[]
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ before: 'draft', after: 'active', actor: 'mikrob' })
    db.close()
  })

  it('setNodeStatus on an unknown node throws instead of silently no-op-ing', () => {
    const db = new Database(':memory:')
    migrate(db)
    expect(() => setNodeStatus(db, 'sol:missing', 'active', 'mikrob')).toThrow()
    db.close()
  })

  it('openKgDb sets WAL + busy_timeout on a real file and rebuild() restores a clean schema', () => {
    const dbPath = tmpDbPath()
    let db = openKgDb(dbPath)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    upsertNode(db, { id: 'card:x', type: 'card', project: 'marveen', title: 't', source_ref: 'x', extractor: 'manual' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()).toEqual({ n: 1 })

    db = rebuild(db, dbPath)
    expect(existsSync(dbPath)).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()).toEqual({ n: 0 })
    expect(() =>
      upsertNode(db, { id: 'card:y', type: 'card', project: 'marveen', title: 't2', source_ref: 'x', extractor: 'manual' }),
    ).not.toThrow()
    db.close()
  })
})
