import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate as migrateKg, upsertNode } from '../kg/store.js'
import { importColdMemories } from '../kg/import-cold-memories.js'

function makeMainDbFixture(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, category TEXT NOT NULL,
      content TEXT NOT NULL, keywords TEXT, created_at INTEGER NOT NULL
    );
  `)
  // EK-MT-10c-1: a cold memory referencing a card that already exists as a card node.
  db.prepare(
    `INSERT INTO memories (agent_id, category, content, keywords, created_at) VALUES
       ('qa', 'cold', 'A cafe1234 kartyan a regresszio az async refaktorbol jott.\nTanulsag: mindig mutacios tesztet futtass.', 'regression, async', 1000)`,
  ).run()
  // Cold memory referencing a card that does NOT exist as a node -- no edge should be created.
  db.prepare(
    `INSERT INTO memories (agent_id, category, content, keywords, created_at) VALUES
       ('backend', 'cold', 'A deadbeef kartya sosem lett felvetve a grafba.', null, 1001)`,
  ).run()
  // Cold memory referencing a commit sha that already exists as a commit node.
  db.prepare(
    `INSERT INTO memories (agent_id, category, content, keywords, created_at) VALUES
       ('backend2', 'cold', 'A javitas a 5c1c635bd8f248bce9f73f0b380add006a361895 commitban landolt.', null, 1002)`,
  ).run()
  // Not cold -- must be excluded entirely.
  db.prepare(
    `INSERT INTO memories (agent_id, category, content, keywords, created_at) VALUES
       ('qa', 'hot', 'Ez egy aktiv feladat, nem tanulsag.', null, 1003)`,
  ).run()
  return db
}

describe('importColdMemories (MT-10c, card 76c2efb1)', () => {
  it('imports only cold-category memories as lesson nodes, linking to existing card/commit nodes only', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    upsertNode(kgDb, {
      id: 'card:cafe1234',
      type: 'card',
      project: 'mikrob',
      title: 'Card one',
      source_ref: 'kanban_cards:cafe1234',
      extractor: 'test',
    })
    upsertNode(kgDb, {
      id: 'commit:5c1c635bd8f248bce9f73f0b380add006a361895',
      type: 'commit',
      project: 'mikrob',
      title: 'merge: agent/backend2/work into develop',
      source_ref: 'git:5c1c635bd8f248bce9f73f0b380add006a361895',
      extractor: 'test',
    })

    const report = importColdMemories(mainDb, kgDb)

    expect(report.memoriesScanned).toBe(3) // only the 3 cold rows, the hot row is excluded
    expect(report.lessonsUpserted).toBe(3)
    // Only 2 edges: cafe1234 (exists) and the commit sha (exists) -- deadbeef has no card node.
    expect(report.aboutEdges).toBe(2)
  })

  it('EK-MT-10c-1: a card-referencing cold memory gets an about edge to the existing card node', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    upsertNode(kgDb, {
      id: 'card:cafe1234',
      type: 'card',
      project: 'mikrob',
      title: 'Card one',
      source_ref: 'kanban_cards:cafe1234',
      extractor: 'test',
    })

    importColdMemories(mainDb, kgDb)

    const node = kgDb.prepare('SELECT type FROM kg_nodes WHERE id = ?').get('lesson:memory:1')
    expect(node).toEqual({ type: 'lesson' })

    const edge = kgDb
      .prepare(`SELECT dst FROM kg_edges WHERE rel = 'about' AND src = 'lesson:memory:1'`)
      .get()
    expect(edge).toEqual({ dst: 'card:cafe1234' })
  })

  it('does not create an about edge when the referenced card/commit node does not exist', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    importColdMemories(mainDb, kgDb)

    // No card/commit nodes exist in this run -- lesson nodes still get created, but no edges.
    const lessonCount = kgDb
      .prepare(`SELECT COUNT(*) AS n FROM kg_nodes WHERE type = 'lesson'`)
      .get() as { n: number }
    expect(lessonCount.n).toBe(3)
    const edgeCount = kgDb.prepare(`SELECT COUNT(*) AS n FROM kg_edges WHERE rel = 'about'`).get()
    expect(edgeCount).toEqual({ n: 0 })
  })

  it('is idempotent: running it twice over the same source yields identical row counts', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    upsertNode(kgDb, {
      id: 'card:cafe1234',
      type: 'card',
      project: 'mikrob',
      title: 'Card one',
      source_ref: 'kanban_cards:cafe1234',
      extractor: 'test',
    })

    importColdMemories(mainDb, kgDb)
    const nodesAfterFirst = kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()
    const edgesAfterFirst = kgDb.prepare('SELECT COUNT(*) AS n FROM kg_edges').get()

    importColdMemories(mainDb, kgDb)
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()).toEqual(nodesAfterFirst)
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_edges').get()).toEqual(edgesAfterFirst)
  })

  it('a failure partway through the run leaves NOTHING written (atomic, not partial)', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    // A secret-shaped token in the FIRST row's content makes upsertNode's assertNoSecretShape
    // throw (store.ts), same technique as the other MT-10 importers' atomicity tests.
    mainDb
      .prepare(`UPDATE memories SET content = content || ' ghp_${'a'.repeat(36)}' WHERE id = 1`)
      .run()

    expect(() => importColdMemories(mainDb, kgDb)).toThrow()
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()).toEqual({ n: 0 })
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_edges').get()).toEqual({ n: 0 })
  })
})
