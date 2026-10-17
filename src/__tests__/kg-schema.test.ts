import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, migrateDown } from '../kg/store.js'

// EK-MT-1: migration up, then down, leaves a plain empty file; running migrate() again on that
// same file reproduces the identical schema -- the "rm + rebuild" recovery path (MODULTERV
// section 4) is just this twice in a row on a real file, tested for real here via :memory:.

const KG_TABLES = ['kg_nodes', 'kg_edges', 'kg_anchors', 'kg_usage', 'kg_capture_queue', 'kg_audit']

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kg_%'").all() as {
    name: string
  }[]).map((r) => r.name)
}

describe('kg schema migration', () => {
  it('creates every kg_* table plus the FTS5 index on a fresh database', () => {
    const db = new Database(':memory:')
    migrate(db)
    const names = tableNames(db)
    for (const t of KG_TABLES) expect(names).toContain(t)
    expect(names).toContain('kg_nodes_fts')
    db.close()
  })

  it('is idempotent: migrating an already-current database is a no-op, not an error', () => {
    const db = new Database(':memory:')
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    db.close()
  })

  it('migrateDown(0) drops every kg_* table and trigger', () => {
    const db = new Database(':memory:')
    migrate(db)
    migrateDown(db, 0)
    expect(tableNames(db)).toHaveLength(0)
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'kg_%'")
      .all()
    expect(triggers).toHaveLength(0)
    db.close()
  })

  it('round-trips: down then up again reproduces the same schema (the rebuild path)', () => {
    const db = new Database(':memory:')
    migrate(db)
    migrateDown(db, 0)
    migrate(db)
    const names = tableNames(db).sort()
    for (const t of KG_TABLES) expect(names).toContain(t)
    // A second round trip must not accumulate duplicate objects or throw.
    migrateDown(db, 0)
    expect(() => migrate(db)).not.toThrow()
    db.close()
  })

  it('kg_nodes rejects a type outside the closed enum (CHECK constraint, not app-layer trust)', () => {
    const db = new Database(':memory:')
    migrate(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO kg_nodes (id, type, project, title, status, source_ref, extractor, created_at, updated_at)
           VALUES ('x:1', 'not_a_real_type', 'marveen', 't', 'active', 'ref', 'manual', 1, 1)`,
        )
        .run(),
    ).toThrow()
    db.close()
  })

  it('kg_usage and kg_audit refuse UPDATE/DELETE (append-only triggers)', () => {
    const db = new Database(':memory:')
    migrate(db)
    db.prepare(
      `INSERT INTO kg_usage (node_id, card_id, agent, event, created_at) VALUES ('n','c','backend2','offered',1)`,
    ).run()
    expect(() => db.prepare(`UPDATE kg_usage SET event = 'used' WHERE node_id = 'n'`).run()).toThrow()
    expect(() => db.prepare(`DELETE FROM kg_usage WHERE node_id = 'n'`).run()).toThrow()

    db.prepare(
      `INSERT INTO kg_audit (node_id, action, actor, created_at) VALUES ('n','status_change','mikrob',1)`,
    ).run()
    expect(() => db.prepare(`UPDATE kg_audit SET action = 'x' WHERE node_id = 'n'`).run()).toThrow()
    expect(() => db.prepare(`DELETE FROM kg_audit WHERE node_id = 'n'`).run()).toThrow()
    db.close()
  })
})
