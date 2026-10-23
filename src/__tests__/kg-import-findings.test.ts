import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate as migrateKg } from '../kg/store.js'
import { importFindings, classifyFindingText } from '../kg/import-findings.js'

// Minimal fixture of the real tables the importer reads -- just the columns this module
// touches, per the surgical-change principle (same posture as kg-import-from-relations.test.ts).
function makeMainDbFixture(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT);
    CREATE TABLE kanban_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT, gate TEXT, verdict TEXT, sha TEXT,
      findings_ref TEXT, created_at INTEGER
    );
  `)
  db.prepare(`INSERT INTO kanban_cards VALUES ('card1', 'Card one', 'MikroB')`).run()
  db.prepare(`INSERT INTO kanban_cards VALUES ('card2', 'Card two', 'mopsion')`).run()
  // EK-MT-10a-1: two findings with manually-provided matching text -> same error_class.
  db.prepare(
    `INSERT INTO kanban_verdicts (card_id, gate, verdict, sha, findings_ref) VALUES
       ('card1', 'CYBERSEC', 'NO-GO', 'deadbeef', 'hianyzo env-valtozo a compose-allowlistben')`,
  ).run()
  db.prepare(
    `INSERT INTO kanban_verdicts (card_id, gate, verdict, sha, findings_ref) VALUES
       ('card2', 'CYBERED', 'NO-GO', NULL, 'masik kartyan is hianyzo env allowlist bejegyzes')`,
  ).run()
  // A PASS/GO row must never be imported.
  db.prepare(
    `INSERT INTO kanban_verdicts (card_id, gate, verdict, sha, findings_ref) VALUES
       ('card1', 'QA', 'PASS', 'cafef00d', NULL)`,
  ).run()
  // No findings_ref at all -> unclassified.
  db.prepare(
    `INSERT INTO kanban_verdicts (card_id, gate, verdict, sha, findings_ref) VALUES
       ('card1', 'QA', 'FAIL', NULL, NULL)`,
  ).run()
  // Card no longer exists -> skipped, counted.
  db.prepare(
    `INSERT INTO kanban_verdicts (card_id, gate, verdict, sha, findings_ref) VALUES
       ('deleted1', 'QA', 'FAIL', NULL, 'lint szabaly regresszio')`,
  ).run()
  return db
}

describe('classifyFindingText (MT-10a deterministic keyword taxonomy)', () => {
  it('matches the env-allowlist rule regardless of casing/wording variant', () => {
    expect(classifyFindingText('CYBERSEC', 'hianyzo env-valtozo a compose-allowlistben')).toBe(
      'missing-env-allowlist',
    )
    expect(classifyFindingText('CYBERED', 'masik kartyan is hianyzo env allowlist bejegyzes')).toBe(
      'missing-env-allowlist',
    )
  })

  it('falls back to unclassified when findings_ref is null or matches no rule', () => {
    expect(classifyFindingText('QA', null)).toBe('unclassified')
    expect(classifyFindingText('QA', 'teljesen ismeretlen szoveg')).toBe('unclassified')
  })
})

describe('importFindings (MT-10a, card 63206155)', () => {
  it('imports only NO-GO/FAIL rows, skipping PASS/GO and a card that no longer exists', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    const report = importFindings(mainDb, kgDb)

    expect(report.verdictsSeen).toBe(4) // 2 env-allowlist + 1 unclassified + 1 deleted-card lint
    expect(report.verdictsSkippedMissing).toBe(1)
    expect(report.findingsUpserted).toBe(3)
    expect(report.foundOnEdges).toBe(3)
    expect(report.classEdges).toBe(3)
    expect(report.classifiedCount).toBe(2) // the two env-allowlist rows
    expect(report.unclassifiedCount).toBe(1)
  })

  it('EK-MT-10a-1: two findings with the same real root cause land on the SAME error_class node', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    importFindings(mainDb, kgDb)

    const classesOfEnvFindings = kgDb
      .prepare(
        `SELECT DISTINCT e.dst FROM kg_edges e
         JOIN kg_nodes n ON n.id = e.src
         WHERE e.rel = 'of_class' AND n.type = 'finding'
           AND n.body LIKE '%allowlist%'`,
      )
      .all()
    expect(classesOfEnvFindings).toEqual([{ dst: 'error_class:missing-env-allowlist' }])

    const node = kgDb
      .prepare('SELECT id, type, project, title FROM kg_nodes WHERE id = ?')
      .get('error_class:missing-env-allowlist')
    expect(node).toEqual({
      id: 'error_class:missing-env-allowlist',
      type: 'error_class',
      project: '_global',
      title: 'Hiányzó/nem engedélyezett env-változó',
    })
  })

  it('a card->finding edge uses the found_on rel, a finding->error_class edge uses of_class', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    importFindings(mainDb, kgDb)

    const foundOn = kgDb
      .prepare(`SELECT src, dst FROM kg_edges WHERE rel = 'found_on' ORDER BY src, dst`)
      .all()
    expect(foundOn).toEqual([
      { src: 'card:card1', dst: expect.stringMatching(/^finding:\d+$/) },
      { src: 'card:card1', dst: expect.stringMatching(/^finding:\d+$/) },
      { src: 'card:card2', dst: expect.stringMatching(/^finding:\d+$/) },
    ])
  })

  it('is idempotent: running it twice over the same source yields identical row counts', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    importFindings(mainDb, kgDb)
    const nodesAfterFirst = kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()
    const edgesAfterFirst = kgDb.prepare('SELECT COUNT(*) AS n FROM kg_edges').get()

    importFindings(mainDb, kgDb)
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()).toEqual(nodesAfterFirst)
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_edges').get()).toEqual(edgesAfterFirst)
  })

  it('a failure partway through the run leaves NOTHING written (atomic, not partial)', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    // Force a throw on the FIRST verdict row (card1/CYBERSEC), after it would already have
    // written a finding node and a found_on edge in a real run -- a findings_ref matching a
    // secret shape makes upsertNode's assertNoSecretShape throw (store.ts), same guard every
    // kg_nodes write already passes through.
    mainDb
      .prepare(`UPDATE kanban_verdicts SET findings_ref = 'ghp_${'a'.repeat(36)}' WHERE card_id = 'card1' AND gate = 'CYBERSEC'`)
      .run()

    expect(() => importFindings(mainDb, kgDb)).toThrow()
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()).toEqual({ n: 0 })
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_edges').get()).toEqual({ n: 0 })
  })
})
