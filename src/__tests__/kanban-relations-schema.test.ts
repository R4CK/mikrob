// Card 9d7a247a (Fazis fe3eff9f): the kanban_relations edge table -- shape, the constraints that
// carry weight, the delete sweep, and the rollback path RUN rather than assumed. Runs against the
// PRODUCTION schema through initDatabase(), the same shape as kanban-dependencies.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, createKanbanCard, deleteKanbanCard, getDb } from '../db.js'

const NOW = 1_788_000_000
const SCRIPT = join(__dirname, '..', '..', 'store', 'kanban-relations-rollback.sh')

/** The insert every caller of this table will make (card 6cd61430 onwards): idempotent by design. */
function relate(
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  relationType: string,
  source = 'backfill-v1',
  createdAt: unknown = NOW
): number {
  return getDb()
    .prepare(
      `INSERT OR IGNORE INTO kanban_relations
         (from_type, from_id, to_type, to_id, relation_type, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(fromType, fromId, toType, toId, relationType, source, createdAt).changes
}

const countRelations = (): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM kanban_relations').get() as { n: number }).n

beforeEach(() => {
  initDatabase(':memory:')
})

describe('schema and indexes', () => {
  it('the table and its reverse index exist after a plain initDatabase', () => {
    const names = (
      getDb()
        .prepare(
          `SELECT name FROM sqlite_master WHERE name LIKE '%kanban_relations%' ORDER BY name`
        )
        .all() as { name: string }[]
    ).map((r) => r.name)
    expect(names).toContain('kanban_relations')
    expect(names).toContain('idx_kanban_relations_to')
  })

  it('the reverse index is the one the "which cards touched file X" query uses', () => {
    // Asserting the PLAN, not the index's existence: an index nothing chooses is not a strategy.
    // The from-side is covered by the PRIMARY KEY, so only this direction needed a decision.
    const plan = (
      getDb()
        .prepare(
          `EXPLAIN QUERY PLAN SELECT from_id FROM kanban_relations
             WHERE to_type = ? AND to_id = ? AND relation_type = ?`
        )
        .all('file', 'src/db.ts', 'touches-file') as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' ')
    expect(plan).toContain('idx_kanban_relations_to')
  })
})

describe('the constraints that carry weight', () => {
  it('the same edge twice is one row -- what makes the backfill re-runnable', () => {
    expect(relate('card', 'c1', 'file', 'src/db.ts', 'touches-file')).toBe(1)
    expect(relate('card', 'c1', 'file', 'src/db.ts', 'touches-file')).toBe(0)
    expect(countRelations()).toBe(1)
  })

  it('...and only for the SAME five-part key -- a different relation_type is a different edge', () => {
    // Negative control for the test above: if the PK were narrower, this second row would vanish
    // and "no duplicates" would be silently eating real edges instead of duplicates.
    relate('card', 'c1', 'file', 'src/db.ts', 'touches-file')
    expect(relate('card', 'c1', 'file', 'src/db.ts', 'decision-for')).toBe(1)
    expect(countRelations()).toBe(2)
  })

  it('relation_type "blocks" is refused LOUDLY, through the OR IGNORE the backfill uses', () => {
    // The load-bearing constraint. A blocks row here would be INVISIBLE to the card-close guard,
    // which reads kanban_dependencies: it would look like a blocker and block nothing.
    //
    // Through `relate` on purpose -- i.e. through INSERT OR IGNORE, the form the backfill uses. A
    // CHECK constraint is SILENTLY SKIPPED by OR IGNORE (measured: exit 0, nothing written), so
    // the first version of this schema would have told a backfill author the edge was recorded.
    // A trigger's RAISE(ABORT) survives OR IGNORE, which is why the denial is a trigger.
    expect(() => relate('card', 'c1', 'card', 'c2', 'blocks')).toThrow(/blocking edges live in/)
    expect(countRelations()).toBe(0)
  })

  it('...and an allowed type cannot be RENAMED to blocks afterwards', () => {
    // Negative control on the pair: an INSERT-only guard is bypassed by insert-then-update.
    relate('card', 'c1', 'card', 'c2', 'decision-for')
    expect(() =>
      getDb().prepare(`UPDATE kanban_relations SET relation_type = 'blocks'`).run()
    ).toThrow(/blocking edges live in/)
    expect(
      getDb().prepare(`SELECT relation_type AS t FROM kanban_relations`).get() as { t: string }
    ).toEqual({ t: 'decision-for' })
  })

  it('every other relation_type passes -- the CHECK denies one value, it is not an allow-list', () => {
    // So the extraction pass (card 6cd61430) can introduce a type without a schema change.
    for (const t of [
      'touches-file',
      'decision-for',
      'gate-sha',
      'pair-fe',
      'a-type-nobody-used-yet',
    ])
      expect(relate('card', 'c1', 'file', `f/${t}`, t)).toBe(1)
    expect(countRelations()).toBe(5)
  })

  it('a TEXT created_at is refused on INSERT, with the correct form in the message', () => {
    // Not theoretical: the fleet's agents write into this database directly with the sqlite3 CLI
    // and python, where no TypeScript-side discipline reaches them (card a06314ea).
    expect(() =>
      relate('card', 'c1', 'file', 'src/db.ts', 'touches-file', 'live', '2026-09-02 14:53:49')
    ).toThrow(/must be a unix epoch INTEGER/)
    expect(countRelations()).toBe(0)
  })

  it('...and on UPDATE too -- the insert guard alone would leave the back door open', () => {
    relate('card', 'c1', 'file', 'src/db.ts', 'touches-file')
    expect(() =>
      getDb().prepare(`UPDATE kanban_relations SET created_at = ?`).run('2026-09-02 14:53:49')
    ).toThrow(/must be a unix epoch INTEGER/)
  })
})

describe('deleteKanbanCard sweeps the card-side edges (no FK forces it)', () => {
  beforeEach(() => {
    createKanbanCard({ id: 'gone', title: 'to be deleted' })
    createKanbanCard({ id: 'stays', title: 'unrelated' })
  })

  it('removes edges where the card is either end', () => {
    relate('card', 'gone', 'file', 'src/db.ts', 'touches-file')
    relate('card', 'other', 'card', 'gone', 'decision-for')
    expect(countRelations()).toBe(2)
    expect(deleteKanbanCard('gone')).toBe(true)
    expect(countRelations()).toBe(0)
  })

  it("leaves another card's edges alone", () => {
    relate('card', 'stays', 'file', 'src/db.ts', 'touches-file')
    deleteKanbanCard('gone')
    expect(countRelations()).toBe(1)
  })

  it('the TYPE qualifier is load-bearing: a file whose path happens to equal the id survives', () => {
    // Without `to_type = 'card'` in the sweep, deleting a card would delete any edge whose other
    // end merely shares its id string -- a file, a sha. The ids are short hex, so this is a real
    // collision shape, not a contrived one.
    relate('card', 'stays', 'file', 'gone', 'touches-file')
    deleteKanbanCard('gone')
    expect(countRelations()).toBe(1)
  })
})

describe('rollback, RUN and not assumed (kodminosegi elv 11)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kanban-relations-'))
    dbPath = join(dir, 'test.db')
    initDatabase(dbPath)
    relate('card', 'c1', 'file', 'src/db.ts', 'touches-file')
    expect(countRelations()).toBe(1)
  })

  afterEach(() => {
    initDatabase(':memory:')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('the script drops table, index and triggers, and initDatabase brings them back EMPTY', () => {
    const out = execFileSync('bash', [SCRIPT, '--db', dbPath, '--yes'], { encoding: 'utf-8' })
    expect(out).toMatch(/dropped/)

    const survivors = execFileSync(
      'sqlite3',
      [dbPath, `SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '%kanban_relations%'`],
      { encoding: 'utf-8' }
    ).trim()
    expect(survivors).toBe('0')

    // The forward half of the pair: initDatabase() runs on every service start, so re-creating is
    // the whole recovery. Empty, not restored -- this backs out a bad backfill, it does not undo
    // a data loss, and saying so is the point of running it rather than assuming it.
    initDatabase(dbPath)
    expect(countRelations()).toBe(0)
    relate('card', 'c1', 'file', 'src/db.ts', 'touches-file')
    expect(countRelations()).toBe(1)
  })

  it('without --yes it is a dry run: the rows are still there afterwards', () => {
    // A rollback tool whose default is destructive is a foot-gun in a fleet where agents run
    // scripts from card text.
    const out = execFileSync('bash', [SCRIPT, '--db', dbPath], { encoding: 'utf-8' })
    expect(out).toMatch(/DRY RUN/)
    expect(countRelations()).toBe(1)
  })
})
