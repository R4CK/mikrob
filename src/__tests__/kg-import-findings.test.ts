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

  it('F2: security rules have priority over generic rules (auth-bypass beats env-allowlist)', () => {
    // Without fix (generics first): 'allowlist' matches missing-env-allowlist before auth-bypass
    // With fix (security first): auth-bypass matches first
    expect(classifyFindingText('CYBERSEC', 'auth bypass via env allowlist config')).toBe('auth-bypass')
    expect(classifyFindingText('QA', 'SQL injection; lint ratchet baseline still holds')).toBe('injection')
  })

  it('F3: classification text is truncated to 8000 chars before pattern matching', () => {
    // The classified text is `gate + ' ' + findings_ref`; 'CYBERSEC ' is 9 chars.
    // Pad with 'a' chars + leading space so that 'auth bypass' (11 chars) ends EXACTLY on
    // character 8000 (index 7999) -- no truncation, pattern must match:
    //   full = 'CYBERSEC ' (9) + 'a'.repeat(7979) (7979) + ' auth bypass' (12) = 8000 chars
    // Shift one character right so 'auth bypass' ends at 8001 (outside the cap):
    //   full = 8001 chars; slice(0,8000) cuts off the final 's' -> 'bypas', no match.
    // The cap-removed mutant (CLASSIFICATION_TEXT_CAP >> 8000) passes both inputs untruncated,
    // so the second assertion turns red -- it finds 'auth bypass' instead of 'unclassified'.
    const atCap = 'a'.repeat(7979) + ' auth bypass'   // full 8000 chars, no truncation
    expect(classifyFindingText('CYBERSEC', atCap)).toBe('auth-bypass')

    const pastCap = 'a'.repeat(7980) + ' auth bypass'  // full 8001 chars; 's' of 'bypass' cut off
    expect(classifyFindingText('CYBERSEC', pastCap)).toBe('unclassified')
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
    expect(report.verdictsSkippedSecret).toBe(0)
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

  it('F1: ZWS injected into findings_ref cannot hide a security finding from classification', () => {
    // U+200B (ZERO WIDTH SPACE) inserted between "auth" and " bypass" prevents the auth-bypass
    // pattern's literal-space requirement from matching: "auth​ bypass" ≠ "auth bypass".
    // Without sanitization the finding silently falls through to 'unclassified' -- a genuine
    // auth-bypass stays undetected by the taxonomy. With sanitization the ZWS is stripped first,
    // restoring "auth bypass" so the security rule fires correctly.
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    mainDb
      .prepare(`UPDATE kanban_verdicts SET findings_ref = ? WHERE card_id = 'card1' AND gate = 'CYBERSEC'`)
      .run('auth​ bypass critical')

    importFindings(mainDb, kgDb)

    const classEdge = kgDb
      .prepare(`SELECT dst FROM kg_edges WHERE src = 'finding:1' AND rel = 'of_class'`)
      .get() as { dst: string } | undefined
    // After sanitization: "auth bypass critical" -> auth-bypass rule matches first
    expect(classEdge?.dst).toBe('error_class:auth-bypass')
  })

  it('F4: re-running after findings_ref changes removes the stale of_class edge', () => {
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    importFindings(mainDb, kgDb) // first run: finding:1 -> of_class:missing-env-allowlist

    // Change findings_ref so the finding would reclassify to auth-bypass
    mainDb.prepare(`UPDATE kanban_verdicts SET findings_ref = 'auth bypass' WHERE id = 1`).run()
    importFindings(mainDb, kgDb) // second run: should remove old edge and insert new one

    const classEdges = kgDb
      .prepare(`SELECT dst FROM kg_edges WHERE src = 'finding:1' AND rel = 'of_class'`)
      .all() as { dst: string }[]
    expect(classEdges).toHaveLength(1) // exactly one of_class edge (no stale duplicate)
    expect(classEdges[0]?.dst).toBe('error_class:auth-bypass')
  })

  it('T2: ZWS-split secret token is caught by the pre-screen because it runs on SANITIZED text', () => {
    // U+200B (ZERO WIDTH SPACE) splits the ghp_ token so the raw pattern
    // /\bgh[pousr]_[A-Za-z0-9]{30,}/ cannot match (only 15 consecutive alphanum chars after the
    // prefix, below the 30-char minimum). After sanitization the ZWS is stripped: the token
    // becomes ghp_ + 36 a-chars, which the pattern catches.
    // Raw-screen mutant (findSecretShape(v.findings_ref) instead of
    // findSecretShape(sanitizeKgText(v.findings_ref))): the split token passes the pre-screen,
    // reaches upsertNode, which sanitizes internally and then calls assertNoSecretShape on the
    // reassembled full token -> KgSecretError -> the whole import throws (measured by RedHat:
    // 0 findings written). The test must go RED on that mutant.
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    // ghp_ + 15 a's + U+200B + 21 a's; sanitized: ghp_ + 36 a's (≥30, matches the pattern)
    const zwsToken = 'ghp_' + 'a'.repeat(15) + '​' + 'a'.repeat(21)
    mainDb
      .prepare(`UPDATE kanban_verdicts SET findings_ref = ? WHERE card_id = 'card1' AND gate = 'CYBERSEC'`)
      .run(zwsToken)

    let report!: ReturnType<typeof importFindings>
    expect(() => { report = importFindings(mainDb, kgDb) }).not.toThrow()
    expect(report.verdictsSkippedSecret).toBe(1)
    // card2/CYBERED env-allowlist + card1/QA FAIL (null findings_ref) are still written
    expect(report.findingsUpserted).toBe(2)
  })

  it('F5: a secret-shaped findings_ref is skipped and counted; the rest of the run continues', () => {
    // Previously: upsertNode's assertNoSecretShape threw KgSecretError and aborted the whole run.
    // Now: the row is pre-screened, skipped with verdictsSkippedSecret++, and the remaining rows
    // are still written.
    const mainDb = makeMainDbFixture()
    const kgDb = new Database(':memory:')
    migrateKg(kgDb)
    mainDb
      .prepare(`UPDATE kanban_verdicts SET findings_ref = 'ghp_${'a'.repeat(36)}' WHERE card_id = 'card1' AND gate = 'CYBERSEC'`)
      .run()

    let report!: ReturnType<typeof importFindings>
    expect(() => { report = importFindings(mainDb, kgDb) }).not.toThrow()
    expect(report.verdictsSkippedSecret).toBe(1)
    // card2/CYBERED env-allowlist + card1/QA FAIL (no findings_ref) are still written
    expect(report.findingsUpserted).toBe(2)
    // deleted1/QA FAIL still counted as skipped-missing
    expect(report.verdictsSkippedMissing).toBe(1)
  })
})
