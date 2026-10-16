import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate as migrateKg } from '../kg/store.js'
import { importFromRelations } from '../kg/import-from-relations.js'

// A minimal fixture of the real tables the importer reads (kanban_cards, kanban_relations,
// kanban_verdicts) -- not the full src/db.ts schema, just the columns this module touches, per
// the surgical-change principle: a fixture that drifts from the real schema is the import's
// problem to notice via a failing query, not a reason to drag in the whole app schema here.
function makeMainDbFixture(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT);
    CREATE TABLE kanban_relations (
      from_type TEXT, from_id TEXT, to_type TEXT, to_id TEXT, relation_type TEXT, source TEXT, created_at INTEGER
    );
    CREATE TABLE kanban_verdicts (card_id TEXT, gate TEXT, verdict TEXT, sha TEXT, created_at INTEGER);
  `)
  db.prepare(`INSERT INTO kanban_cards VALUES ('parent1', 'Parent card', 'MikroB')`).run()
  db.prepare(`INSERT INTO kanban_cards VALUES ('child1', 'Child card', 'MikroB')`).run()
  db.prepare(`INSERT INTO kanban_cards VALUES ('fe1', 'Frontend pair', 'mopsion')`).run()
  // 'deleted1' deliberately has NO kanban_cards row -- simulates a card removed after the
  // relation/verdict row was written.
  db.prepare(
    `INSERT INTO kanban_relations VALUES ('card','child1','card','parent1','child-of','auto',1)`,
  ).run()
  db.prepare(
    `INSERT INTO kanban_relations VALUES ('card','child1','card','fe1','pair-fe','auto',1)`,
  ).run()
  db.prepare(
    `INSERT INTO kanban_relations VALUES ('card','child1','sha','deadbeefcafe','gate-sha','auto',1)`,
  ).run()
  db.prepare(
    `INSERT INTO kanban_relations VALUES ('card','deleted1','card','parent1','child-of','auto',1)`,
  ).run()
  db.prepare(`INSERT INTO kanban_verdicts VALUES ('child1','qa','PASS','deadbeefcafe',1)`).run()
  db.prepare(`INSERT INTO kanban_verdicts VALUES ('child1','qa','PASS',NULL,2)`).run() // no sha, must be skipped
  return db
}

describe('importFromRelations (MT-01 alap, deterministic card/sha/child-of/pair import)', () => {
  it('mirrors card/card and card/sha edges, skipping a relation whose card no longer exists', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    const report = importFromRelations(mainDb, kgDb)

    expect(report.cardsSkippedMissing).toBe(1) // 'deleted1'
    const nodes = kgDb.prepare('SELECT id, type, project FROM kg_nodes ORDER BY id').all()
    expect(nodes).toEqual([
      { id: 'card:child1', type: 'card', project: 'mikrob' },
      { id: 'card:fe1', type: 'card', project: 'mopsion' },
      { id: 'card:parent1', type: 'card', project: 'mikrob' },
      { id: 'commit:deadbeefcafe', type: 'commit', project: 'mikrob' },
    ])

    const edges = kgDb
      .prepare('SELECT src, dst, rel, source FROM kg_edges ORDER BY src, dst, rel')
      .all()
    expect(edges).toEqual([
      { src: 'card:child1', dst: 'card:fe1', rel: 'pair_fe', source: 'import:kanban_relations' },
      { src: 'card:child1', dst: 'card:parent1', rel: 'child_of', source: 'import:kanban_relations' },
      {
        src: 'card:child1',
        dst: 'commit:deadbeefcafe',
        rel: 'found_on',
        source: 'import:kanban_verdicts',
      },
      {
        src: 'card:child1',
        dst: 'commit:deadbeefcafe',
        rel: 'implemented_in',
        source: 'import:kanban_relations',
      },
    ])
  })

  it('is idempotent: running it twice over the same source yields identical row counts', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    importFromRelations(mainDb, kgDb)
    const nodesAfterFirst = kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()
    const edgesAfterFirst = kgDb.prepare('SELECT COUNT(*) AS n FROM kg_edges').get()

    importFromRelations(mainDb, kgDb)
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()).toEqual(nodesAfterFirst)
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_edges').get()).toEqual(edgesAfterFirst)
  })

  it('a verdict row with a NULL sha contributes no edge', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    const report = importFromRelations(mainDb, kgDb)
    expect(report.edgesFromVerdicts).toBe(1) // only the one with a non-null sha
  })
})
