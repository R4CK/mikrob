import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate as migrateKg } from '../kg/store.js'
import { importDecisionsLog } from '../kg/import-decisions-log.js'

function makeMainDbFixture(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT);`)
  db.prepare(`INSERT INTO kanban_cards VALUES ('81593084', 'MT P2 phase', 'MikroB')`).run()
  db.prepare(`INSERT INTO kanban_cards VALUES ('ee9ee17b', 'MT F1', 'MikroB')`).run()
  // 'deadbeef00' is NOT 8 hex chars, so it must never even be considered a candidate.
  return db
}

const FIXTURE_MD = `# Döntésnapló

Append-only.

## 2026-08-20 06:00 -- Upstream merge

**Döntés:** Valami történt.
**Miért:** Mert úgy volt jó.
**Ki döntött:** Peti.
**Hivatkozás:** kártya 81593084, commit 8123b1d6.

## 2026-09-01 09:00 -- Másik döntés

**Döntés:** Más valami.
**Miért:** Más ok.
**Hivatkozás:** kártya ee9ee17b, kártya 81593084.

## 2026-09-05 10:00 -- Nincs kártya-hivatkozás

**Döntés:** Önálló döntés, semmire nem hivatkozik.
`

describe('importDecisionsLog (MT-10b, DECISIONS.md -> decision nodes + governs edges)', () => {
  it('creates one decision node per ## entry, with governs edges to cards that actually exist', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    const report = importDecisionsLog(FIXTURE_MD, mainDb, kgDb, 'mikrob')

    expect(report.entriesParsed).toBe(3)
    expect(report.decisionsUpserted).toBe(3)

    const decisions = kgDb
      .prepare(`SELECT id, type, project, title FROM kg_nodes WHERE type = 'decision' ORDER BY id`)
      .all()
    expect(decisions).toHaveLength(3)
    expect(decisions.every((d: any) => d.type === 'decision' && d.project === 'mikrob')).toBe(true)

    const edges = kgDb
      .prepare(`SELECT src, dst, rel FROM kg_edges WHERE rel = 'governs' ORDER BY src, dst`)
      .all()
    // Entry 1 -> card:81593084 ; Entry 2 -> card:ee9ee17b, card:81593084 ; Entry 3 -> none
    expect(edges).toHaveLength(3)
    expect(edges.every((e: any) => e.rel === 'governs')).toBe(true)
    expect(edges.map((e: any) => e.dst).sort()).toEqual(
      ['card:81593084', 'card:81593084', 'card:ee9ee17b'].sort(),
    )
  })

  it('a hex-shaped token that is NOT a real card (e.g. a commit sha) produces no edge, and is counted', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    const report = importDecisionsLog(FIXTURE_MD, mainDb, kgDb, 'mikrob')

    const commitAsCard = kgDb.prepare(`SELECT 1 FROM kg_nodes WHERE id = 'card:8123b1d6'`).get()
    expect(commitAsCard).toBeUndefined()
    expect(report.cardRefsSkippedMissing).toBe(1) // only '8123b1d6' (a commit sha, not a card)
  })

  it('is idempotent: running it twice over the same text yields identical row counts', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    importDecisionsLog(FIXTURE_MD, mainDb, kgDb, 'mikrob')
    const nodesAfterFirst = kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()
    const edgesAfterFirst = kgDb.prepare('SELECT COUNT(*) AS n FROM kg_edges').get()

    importDecisionsLog(FIXTURE_MD, mainDb, kgDb, 'mikrob')
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()).toEqual(nodesAfterFirst)
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_edges').get()).toEqual(edgesAfterFirst)
  })

  it('an entry with a title/body over the schema CHECK is truncated, not rejected', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    const longTitleMd = `## ${'x'.repeat(250)}\n\n**Döntés:** rövid.\n`

    expect(() => importDecisionsLog(longTitleMd, mainDb, kgDb, 'mikrob')).not.toThrow()
    const row = kgDb.prepare(`SELECT title FROM kg_nodes WHERE type = 'decision'`).get() as { title: string }
    expect(row.title).toHaveLength(200)
  })

  it('an empty file parses to zero entries without throwing', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)

    const report = importDecisionsLog('# Döntésnapló\n\nNincs még bejegyzés.\n', mainDb, kgDb, 'mikrob')
    expect(report.entriesParsed).toBe(0)
    expect(kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get()).toEqual({ n: 0 })
  })

  // F1 (card 49b96b30, WhiteHat 22369, bb0cadd9 GO condition): `decision:L<line>` collided across
  // files and shifted under archiving. Two regressions:
  it('F1a: two DECISIONS.md files with an entry on the SAME line number get two SEPARATE nodes, not one overwritten', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    const mdA = '## 2026-08-20 -- A fájl bejegyzése\n\n**Döntés:** Ez az A fájl tartalma.\n'
    const mdB = '## 2026-08-20 -- B fájl bejegyzése\n\n**Döntés:** Ez a B fájl tartalma.\n'

    importDecisionsLog(mdA, mainDb, kgDb, 'marveen', 'DECISIONS.md')
    importDecisionsLog(mdB, mainDb, kgDb, 'mopsion', 'mopsion-DECISIONS.md')

    const decisions = kgDb.prepare(`SELECT project, title FROM kg_nodes WHERE type = 'decision'`).all() as
      Array<{ project: string; title: string }>
    expect(decisions).toHaveLength(2)
    expect(decisions.find((d) => d.project === 'marveen')?.title).toBe('2026-08-20 -- A fájl bejegyzése')
    expect(decisions.find((d) => d.project === 'mopsion')?.title).toBe('2026-08-20 -- B fájl bejegyzése')
  })

  it('F1b: archiving (removing the earliest entries, shifting line numbers) does NOT reassign an existing node to different content', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    const beforeArchive = [
      '## 2026-07-01 -- E1 (will be archived)',
      '',
      '**Döntés:** E1 tartalma.',
      '**Hivatkozás:** kártya 81593084.',
      '',
      '## 2026-08-01 -- E2 (survives)',
      '',
      '**Döntés:** E2 tartalma.',
      '**Hivatkozás:** kártya ee9ee17b.',
      '',
    ].join('\n')
    // After archiving, E1 is gone and E2 is now the FIRST entry -- same line number E1 used to have.
    const afterArchive = [
      '## 2026-08-01 -- E2 (survives)',
      '',
      '**Döntés:** E2 tartalma.',
      '**Hivatkozás:** kártya ee9ee17b.',
      '',
    ].join('\n')

    importDecisionsLog(beforeArchive, mainDb, kgDb, 'mikrob')
    const e1Id = kgDb.prepare(`SELECT id FROM kg_nodes WHERE title LIKE '%E1%'`).get() as { id: string }
    importDecisionsLog(afterArchive, mainDb, kgDb, 'mikrob')

    // E1's node (and its governs edge to 81593084) is untouched by the second, archived-file run.
    const e1After = kgDb.prepare('SELECT title FROM kg_nodes WHERE id = ?').get(e1Id.id) as { title: string }
    expect(e1After.title).toBe('2026-07-01 -- E1 (will be archived)')
    const e1Edge = kgDb.prepare(`SELECT dst FROM kg_edges WHERE src = ? AND rel = 'governs'`).get(e1Id.id) as
      { dst: string }
    expect(e1Edge.dst).toBe('card:81593084')
    // E2 kept its OWN node/edge, unaffected by E1's line number no longer existing.
    const e2Edge = kgDb.prepare(
      `SELECT e.dst FROM kg_edges e JOIN kg_nodes n ON n.id = e.src WHERE n.title LIKE '%E2%' AND e.rel = 'governs'`,
    ).get() as { dst: string }
    expect(e2Edge.dst).toBe('card:ee9ee17b')
  })

  // F2 (card 49b96b30, WhiteHat 22369): the card node's partition must come from the REFERENCED
  // card's own project (mapProjectToPartition(card.project)), not the calling project.
  it('F2: a referenced card node is partitioned by the CARD\'s own project, not the calling DECISIONS.md project', () => {
    const mainDb = makeMainDbFixture()
    mainDb.prepare(`INSERT INTO kanban_cards VALUES ('abcd1234', 'Mopsion kártya', 'mopsion')`).run()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    const md = '## 2026-10-01 -- Marveen döntés, mopsion kártyára hivatkozva\n\n**Döntés:** x.\n**Hivatkozás:** kártya abcd1234.\n'

    importDecisionsLog(md, mainDb, kgDb, 'marveen')

    const cardNode = kgDb.prepare(`SELECT project FROM kg_nodes WHERE id = 'card:abcd1234'`).get() as
      { project: string }
    expect(cardNode.project).toBe('mopsion')
  })

  // F3 (card 49b96b30, WhiteHat 22369): one secret-shaped entry used to roll back the ENTIRE
  // import (the throw escaped the shared transaction) -- every other entry must still import.
  it('F3: a secret shape in ONE entry is skipped and counted, the other entries still import', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    const md = [
      '## 2026-09-01 -- Első, tiszta bejegyzés',
      '',
      '**Döntés:** rendben van.',
      '',
      '## 2026-09-02 -- Titkot tartalmazó bejegyzés',
      '',
      '**Döntés:** AKIAIOSFODNN7EXAMPLE belekerült ide hibásan.',
      '',
      '## 2026-09-03 -- Harmadik, tiszta bejegyzés',
      '',
      '**Döntés:** ez is rendben van.',
    ].join('\n')

    const report = importDecisionsLog(md, mainDb, kgDb, 'mikrob')

    expect(report.entriesParsed).toBe(3)
    expect(report.entriesRejectedSecret).toBe(1)
    expect(report.secretRejectedLines).toEqual([5])
    expect(report.decisionsUpserted).toBe(2)
    const decisions = kgDb.prepare(`SELECT title FROM kg_nodes WHERE type = 'decision'`).all() as
      Array<{ title: string }>
    expect(decisions).toHaveLength(2)
    expect(decisions.some((d) => d.title.includes('Első'))).toBe(true)
    expect(decisions.some((d) => d.title.includes('Harmadik'))).toBe(true)
    expect(decisions.some((d) => d.title.includes('Titkot'))).toBe(false)
  })
})
