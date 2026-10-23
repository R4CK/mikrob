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
})
