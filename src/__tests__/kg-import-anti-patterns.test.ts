import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate as migrateKg } from '../kg/store.js'
import { importAntiPatterns } from '../kg/import-anti-patterns.js'

const SAMPLE_DECISIONS_MD = `
## 2026-10-01 Egyéb bejegyzés

**Döntés: BUILD.** Nincs köze a rejected-alternative taxonómiához, csak egy sima döntés.

## 2026-10-02 Egy elvetett javítás

A javítás NLP-klasszifikációt javasolt, de a konkrét kódja nem épült meg a már elfogadott SQLite
sémára.

**Döntés: VISSZAVONVA, a korábbi F1 javításra visszaállva.** Indok: nem a kártya kérte és
kockázatos.

## 2026-10-03 Előző tervezet magyarázata

Ez a bejegyzés a "ELUTASITVA" szót csak IDÉZI, mert a Draft-Review konvenciót magyarázza --
magát a bejegyzést nem utasítottuk el, nincs Döntés mezőben rejection-szó.

Kapcsolódó kártya: card1 (csak próza-említés, nem Döntés-mezőben).

**Döntés: nincs teendő, a leírás magában informatív.**

## 2026-10-04 Kártyára hivatkozó elutasítás

**Döntés: ELUTASITVA, lásd cafebabe.** A javaslat egy másik, már megépült architektúrát duplikált
volna.
`

function makeMainDbFixture(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT);
    CREATE TABLE kanban_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, author TEXT NOT NULL,
      content TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `)
  db.prepare(`INSERT INTO kanban_cards VALUES ('card1', 'Card one', 'MikroB')`).run()
  db.prepare(`INSERT INTO kanban_cards VALUES ('card2', 'Card two', 'mopsion')`).run()
  // 8-hex-char id, so the DECISIONS.md text-reference regex (import-decisions-log's
  // CARD_ID_RX) can actually find it -- 'card1'/'card2' above are fine as direct FK values
  // (kanban_comments.card_id), but DECISIONS.md references are matched by hex-shape, not FK.
  db.prepare(`INSERT INTO kanban_cards VALUES ('cafebabe', 'Card three', 'mopsion')`).run()
  // EK-MT-10d-1: a comment whose Draft-Review line (not the first line) says ELUTASITVA.
  db.prepare(
    `INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES
       ('card1', 'backend2', 'Megnéztem a helyi draftot.\nDraft-Review: ELUTASITVA\n\nIndok: rossz sémát javasolt.', 1000)`,
  ).run()
  // Draft-Review, but ELFOGADVA -- must NOT become an anti_pattern.
  db.prepare(
    `INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES
       ('card2', 'backend2', 'Draft-Review: ELFOGADVA\n\nA draft hasznosítva.', 1001)`,
  ).run()
  // Mentions "Draft-Review" but not as a line-start rejection marker -- must NOT match.
  db.prepare(
    `INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES
       ('card1', 'backend2', 'A Draft-Review konvenció szerint ELUTASITVA lett volna, de ezt csak elmeletben irom le.', 1002)`,
  ).run()
  // No card -- comment references a deleted card.
  db.prepare(
    `INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES
       ('deleted1', 'backend2', 'Draft-Review: ELUTASITVA\n\nkártya törölve közben.', 1003)`,
  ).run()
  return db
}

describe('importAntiPatterns (MT-10d, card 33e5e4ff)', () => {
  it('imports only Draft-Review: ELUTASITVA comments and rejected Döntés-field entries', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    const report = importAntiPatterns(mainDb, kgDb, SAMPLE_DECISIONS_MD, 'mikrob')

    // 4 comments scanned (LIKE pre-filter matches 4 of them -- all mention "Draft-Review").
    expect(report.commentsScanned).toBe(4)
    // Only comment 1 (card1, mid-content line) and comment 4 (deleted1) actually match the
    // line-start ELUTASITVA regex -- comment 2 is ELFOGADVA, comment 3 never starts a line with it.
    expect(report.commentAntiPatternsUpserted).toBe(2)
    // 4 DECISIONS.md entries parsed; only entries 2 and 4 have a rejecting Döntés-field line.
    expect(report.decisionsScanned).toBe(4)
    expect(report.decisionAntiPatternsUpserted).toBe(2)
    // rejected_for edges: comment1->card1, comment4->(skipped, no card), decision-entry2->(no
    // card referenced), decision-entry4->cafebabe. So 2 real edges land.
    expect(report.rejectedForEdges).toBe(2)
    expect(report.cardRefsSkippedMissing).toBe(1) // comment 4's deleted1 card_id
  })

  it('EK-MT-10d-1: a Draft-Review: ELUTASITVA comment becomes an anti_pattern rejected_for its card', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    importAntiPatterns(mainDb, kgDb, SAMPLE_DECISIONS_MD, 'mikrob')

    const edge = kgDb
      .prepare(
        `SELECT e.dst FROM kg_edges e JOIN kg_nodes n ON n.id = e.src
         WHERE e.rel = 'rejected_for' AND n.source_ref = 'kanban_comments:1'`,
      )
      .get()
    expect(edge).toEqual({ dst: 'card:card1' })

    const node = kgDb.prepare('SELECT type, project FROM kg_nodes WHERE id = ?').get('anti_pattern:comment:1')
    expect(node).toEqual({ type: 'anti_pattern', project: 'mikrob' })
  })

  it('EK-MT-10d-2: a rejected Döntés-field entry becomes an anti_pattern rejected_for its referenced card, but a non-rejected entry and a prose-only mention of the word do not', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    importAntiPatterns(mainDb, kgDb, SAMPLE_DECISIONS_MD, 'mikrob')

    // Entry 4 (cafebabe referenced in its Döntés line) -> rejected_for cafebabe.
    const edgeToCard3 = kgDb
      .prepare(`SELECT src FROM kg_edges WHERE rel = 'rejected_for' AND dst = 'card:cafebabe'`)
      .get() as { src: string } | undefined
    expect(edgeToCard3?.src).toMatch(/^anti_pattern:decision:L\d+$/)

    // Entry 1 (BUILD, no rejection word) must not exist as an anti_pattern.
    const allAntiPatterns = kgDb
      .prepare(`SELECT id FROM kg_nodes WHERE type = 'anti_pattern' AND id LIKE 'anti_pattern:decision:%'`)
      .all()
    expect(allAntiPatterns).toHaveLength(2) // entries 2 and 4 only

    // Entry 3's prose-only "ELUTASITVA" mention (not in its Döntés line) must not match.
    const entry3Node = kgDb
      .prepare(`SELECT id FROM kg_nodes WHERE title LIKE '%Előző tervezet magyarázata%'`)
      .get()
    expect(entry3Node).toBeUndefined()
  })

  it('is idempotent: running it twice over the same source yields identical row counts', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    importAntiPatterns(mainDb, kgDb, SAMPLE_DECISIONS_MD, 'mikrob')
    const nodesAfterFirst = kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()
    const edgesAfterFirst = kgDb.prepare('SELECT COUNT(*) AS n FROM kg_edges').get()

    importAntiPatterns(mainDb, kgDb, SAMPLE_DECISIONS_MD, 'mikrob')
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()).toEqual(nodesAfterFirst)
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_edges').get()).toEqual(edgesAfterFirst)
  })

  // F-d (card 4ecd75d0, WhiteHat 22988/23292): the OLD behavior (a secret shape anywhere rolled
  // back the WHOLE run) is exactly the bug this card closes -- same per-row isolation
  // import-decisions-log.ts already has for the identical shape (card 49b96b30, F3).
  it('F-d: a secret shape in ONE comment is skipped and counted, every other row still imports', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    // A secret-shaped token in the FIRST matching comment's content makes upsertNode's
    // assertNoSecretShape throw (store.ts), same guard every kg_nodes write already passes
    // through.
    mainDb
      .prepare(`UPDATE kanban_comments SET content = content || ' ghp_${'a'.repeat(36)}' WHERE id = 1`)
      .run()

    const report = importAntiPatterns(mainDb, kgDb, SAMPLE_DECISIONS_MD, 'mikrob')

    expect(report.rowsRejectedSecret).toBe(1)
    expect(report.secretRejectedSources).toEqual(['kanban_comments:1'])
    // Comment 1 is skipped, but comment 4 (deleted1) and both DECISIONS.md rejections still land.
    expect(report.commentAntiPatternsUpserted).toBe(1)
    expect(report.decisionAntiPatternsUpserted).toBe(2)
    expect(kgDb.prepare('SELECT 1 FROM kg_nodes WHERE id = ?').get('anti_pattern:comment:1')).toBeUndefined()
    expect(kgDb.prepare('SELECT 1 FROM kg_nodes WHERE id = ?').get('anti_pattern:comment:4')).toBeTruthy()
  })

  // F-b (card 4ecd75d0, source card description): a gate agent or a generated/automated comment
  // author is not an eligible anti-pattern source, even with a line-start ELUTASITVA marker.
  it('F-b: a Draft-Review: ELUTASITVA comment from a gate agent or a generated author is skipped', () => {
    const mainDb = makeMainDbFixture()
    mainDb
      .prepare(
        `INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES
           ('card1', 'cybersec', 'Draft-Review: ELUTASITVA\n\nGate agent, not a builder.', 2000),
           ('card1', 'local-llm', 'Draft-Review: ELUTASITVA\n\nGenerated comment author.', 2001)`,
      )
      .run()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    const report = importAntiPatterns(mainDb, kgDb, SAMPLE_DECISIONS_MD, 'mikrob')

    expect(report.commentsSkippedAuthor).toBe(2)
    expect(kgDb.prepare('SELECT 1 FROM kg_nodes WHERE id = ?').get('anti_pattern:comment:5')).toBeUndefined()
    expect(kgDb.prepare('SELECT 1 FROM kg_nodes WHERE id = ?').get('anti_pattern:comment:6')).toBeUndefined()
    // The original, eligible-author comment still imports normally.
    expect(report.commentAntiPatternsUpserted).toBe(2)
  })
})
