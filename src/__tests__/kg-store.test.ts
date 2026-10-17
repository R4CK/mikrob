import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  migrate, openKgDb, rebuild, upsertNode, upsertEdge, setNodeStatus, getNode, KgSecretError,
  KgValidationError,
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

  // F1 (card eeb57483, WhiteHat GO condition on ee9ee17b): a re-import must not silently
  // reactivate an archived node, and must audit the blocked attempt.
  it('upsertNode on a re-import preserves an archived node and audits the blocked reactivation', () => {
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, { id: 'card:arch1', type: 'card', project: 'marveen', title: 'v1', source_ref: 'x', extractor: 'manual' })
    setNodeStatus(db, 'card:arch1', 'archived', 'mikrob')

    upsertNode(db, {
      id: 'card:arch1', type: 'card', project: 'marveen', title: 'v2 (re-imported)',
      status: 'active', source_ref: 'x', extractor: 'import:kanban_relations',
    })

    expect(getNode(db, 'card:arch1')?.status).toBe('archived')
    const audit = db
      .prepare("SELECT * FROM kg_audit WHERE node_id = ? AND action = 'import_reactivation_blocked'")
      .all('card:arch1') as { before: string; after: string; actor: string }[]
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ before: 'archived', after: 'active', actor: 'import:kanban_relations' })
    db.close()
  })

  // F1-a (card eeb57483 RedHat, card 0deb6893): the archived-protection above covered ONLY
  // 'archived' -- 'superseded' is set through the exact same sanctioned, audited path
  // (setNodeStatus) and is just as deliberate, but a re-import silently flipped it back to
  // 'active' with no audit row at all. This was RED against the pre-fix code.
  it('upsertNode on a re-import preserves a superseded node and audits the blocked reactivation', () => {
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, { id: 'card:sup1', type: 'card', project: 'marveen', title: 'v1', source_ref: 'x', extractor: 'manual' })
    setNodeStatus(db, 'card:sup1', 'superseded', 'mikrob')

    upsertNode(db, {
      id: 'card:sup1', type: 'card', project: 'marveen', title: 'v2 (re-imported)',
      status: 'active', source_ref: 'x', extractor: 'import:kanban_relations',
    })

    expect(getNode(db, 'card:sup1')?.status).toBe('superseded')
    const audit = db
      .prepare("SELECT * FROM kg_audit WHERE node_id = ? AND action = 'import_reactivation_blocked'")
      .all('card:sup1') as { before: string; after: string; actor: string }[]
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ before: 'superseded', after: 'active', actor: 'import:kanban_relations' })
    db.close()
  })

  it('upsertNode on a re-import does NOT audit when the node was never archived', () => {
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, { id: 'card:ok1', type: 'card', project: 'marveen', title: 'v1', source_ref: 'x', extractor: 'manual' })
    upsertNode(db, { id: 'card:ok1', type: 'card', project: 'marveen', title: 'v2', source_ref: 'x', extractor: 'manual' })
    expect(getNode(db, 'card:ok1')?.status).toBe('active')
    expect(db.prepare('SELECT COUNT(*) AS n FROM kg_audit').get()).toEqual({ n: 0 })
    db.close()
  })

  // F2 (card eeb57483): the schema's title CHECK is <= 200 chars; measured on the live table,
  // 16/811 card titles exceed it (max 270). Truncate rather than let the CHECK abort the write.
  it('upsertNode truncates an over-length title instead of hitting the schema CHECK', () => {
    const db = new Database(':memory:')
    migrate(db)
    const longTitle = 'x'.repeat(270)
    expect(() =>
      upsertNode(db, { id: 'card:long1', type: 'card', project: 'marveen', title: longTitle, source_ref: 'x', extractor: 'manual' }),
    ).not.toThrow()
    const row = getNode(db, 'card:long1') as { title: string }
    expect(row.title).toHaveLength(200)
    db.close()
  })

  // R3 (card eeb57483 RedHat C2, card 0deb6893): C2 mutated all three ceilings at once (body
  // 8000->9000, snippet 12000->13000, source_ref 500->5000000) and the suite still passed 60/60
  // -- nothing actually pinned the exact numbers, so a ceiling could silently drift and nobody
  // would notice. These were RED against that mutant (asserting the OLD/correct numbers).
  it('upsertNode truncates an over-length body to exactly 8000 chars (pins the ceiling)', () => {
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'card:body1', type: 'card', project: 'marveen', title: 't',
      body: 'x'.repeat(9000), source_ref: 'x', extractor: 'manual',
    })
    const row = getNode(db, 'card:body1') as { body: string }
    expect(row.body).toHaveLength(8000)
    db.close()
  })

  it('upsertNode truncates an over-length snippet to exactly 12000 chars (pins the ceiling)', () => {
    const db = new Database(':memory:')
    migrate(db)
    upsertNode(db, {
      id: 'card:snip1', type: 'card', project: 'marveen', title: 't',
      snippet: 'x'.repeat(13000), source_ref: 'x', extractor: 'manual',
    })
    const row = getNode(db, 'card:snip1') as { snippet: string }
    expect(row.snippet).toHaveLength(12000)
    db.close()
  })

  it('rejects a source_ref over the 500-char ceiling (pins the ceiling)', () => {
    const db = new Database(':memory:')
    migrate(db)
    expect(() =>
      upsertNode(db, {
        id: 'card:srlong1', type: 'card', project: 'marveen', title: 't',
        source_ref: 'x'.repeat(501), extractor: 'manual',
      }),
    ).toThrow(KgValidationError)
    expect(() =>
      upsertNode(db, {
        id: 'card:srok1', type: 'card', project: 'marveen', title: 't',
        source_ref: 'x'.repeat(500), extractor: 'manual',
      }),
    ).not.toThrow()
    db.close()
  })

  // F4 (card eeb57483): id/source_ref/gate_sha are validated at the one place every write
  // already passes through, so a future untrusted caller (the capture worker) cannot slip an
  // unsafe shape in.
  describe('F4: id/source_ref/gate_sha input validation', () => {
    const base = { type: 'card' as const, project: 'marveen', title: 't', extractor: 'manual' }

    it('rejects an id containing a character outside the safe set', () => {
      const db = new Database(':memory:')
      migrate(db)
      expect(() => upsertNode(db, { ...base, id: 'card:a b', source_ref: 'x' })).toThrow(KgValidationError)
      db.close()
    })

    it('rejects an empty source_ref', () => {
      const db = new Database(':memory:')
      migrate(db)
      expect(() => upsertNode(db, { ...base, id: 'card:a', source_ref: '' })).toThrow(KgValidationError)
      db.close()
    })

    it('rejects a gate_sha that is not hex-shaped', () => {
      const db = new Database(':memory:')
      migrate(db)
      expect(() =>
        upsertNode(db, { ...base, id: 'card:a', source_ref: 'x', gate_sha: 'not-a-sha!' }),
      ).toThrow(KgValidationError)
      db.close()
    })

    it('accepts a comma-separated multi-sha gate_sha (the 4b REVIEW convention)', () => {
      const db = new Database(':memory:')
      migrate(db)
      expect(() =>
        upsertNode(db, { ...base, id: 'card:a', source_ref: 'x', gate_sha: '3edbdc38,a158fe03' }),
      ).not.toThrow()
      db.close()
    })

    it('rejects an id over the length cap', () => {
      const db = new Database(':memory:')
      migrate(db)
      expect(() =>
        upsertNode(db, { ...base, id: 'card:' + 'a'.repeat(300), source_ref: 'x' }),
      ).toThrow(KgValidationError)
      db.close()
    })
  })
})
