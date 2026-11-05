// Card 8e99d55d (Fazis ed332869): the card_landings table -- shape, the constraints that carry
// weight, and the rollback path RUN rather than assumed. Runs against the PRODUCTION schema
// through initDatabase(), the same shape as kanban-relations-schema.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, createKanbanCard, getDb } from '../db.js'

const NOW = 1_793_900_000
const SCRIPT = join(__dirname, '..', '..', 'store', 'card-landings-rollback.sh')

function record(
  cardId: string,
  mergeSha: string,
  repo = 'marveen',
  workSha = 'a'.repeat(40),
  landedBy = 'backend3',
  landedAt: unknown = NOW
): number {
  return getDb()
    .prepare(
      `INSERT INTO card_landings (card_id, work_sha, merge_sha, repo, landed_at, landed_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(cardId, workSha, mergeSha, repo, landedAt, landedBy).changes
}

const countLandings = (): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM card_landings').get() as { n: number }).n

beforeEach(() => {
  initDatabase(':memory:')
  createKanbanCard({ id: 'c1', title: 'card one' })
})

describe('schema and indexes', () => {
  it('the table and both indexes exist after a plain initDatabase', () => {
    const names = (
      getDb()
        .prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%card_landings%' ORDER BY name`)
        .all() as { name: string }[]
    ).map((r) => r.name)
    expect(names).toContain('card_landings')
    expect(names).toContain('idx_card_landings_card')
    expect(names).toContain('idx_card_landings_repo_merge_card')
  })

  it('"is card X landed" uses the card index', () => {
    const plan = (
      getDb()
        .prepare(`EXPLAIN QUERY PLAN SELECT merge_sha FROM card_landings WHERE card_id = ?`)
        .all('c1') as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' ')
    expect(plan).toContain('idx_card_landings_card')
  })
})

describe('the constraints that carry weight', () => {
  it('writes the full row shape the land scripts will produce', () => {
    record('c1', 'f'.repeat(40))
    const row = getDb().prepare('SELECT * FROM card_landings WHERE card_id = ?').get('c1') as Record<
      string,
      unknown
    >
    expect(row.card_id).toBe('c1')
    expect(row.work_sha).toBe('a'.repeat(40))
    expect(row.merge_sha).toBe('f'.repeat(40))
    expect(row.repo).toBe('marveen')
    expect(row.landed_at).toBe(NOW)
    expect(row.landed_by).toBe('backend3')
  })

  it('one card landed twice (delta-gate fix after a NO-GO) keeps both rows', () => {
    record('c1', 'f'.repeat(40))
    record('c1', '1'.repeat(40))
    expect(countLandings()).toBe(2)
  })

  it('one merge carrying two bundled cards keeps both rows', () => {
    createKanbanCard({ id: 'c2', title: 'card two' })
    record('c1', 'f'.repeat(40))
    record('c2', 'f'.repeat(40))
    expect(countLandings()).toBe(2)
  })

  it('a re-run of the land script for the same (repo, merge_sha, card_id) refuses -- what makes it idempotent', () => {
    record('c1', 'f'.repeat(40))
    expect(() => record('c1', 'f'.repeat(40))).toThrow(/UNIQUE constraint failed/)
    expect(countLandings()).toBe(1)
  })

  it('the same merge_sha landing the SAME card in a different repo is a different row', () => {
    // Negative control: if the unique index dropped `repo`, this second insert would collide.
    record('c1', 'f'.repeat(40), 'marveen')
    record('c1', 'f'.repeat(40), 'mopsion')
    expect(countLandings()).toBe(2)
  })

  it('a non-integer landed_at is refused, not silently stored as text', () => {
    // Not theoretical: the fleet's agents and scripts can write into this database directly with
    // the sqlite3 CLI, where no TypeScript-side discipline reaches them (card a06314ea class).
    expect(() => record('c1', 'f'.repeat(40), 'marveen', 'a'.repeat(40), 'backend3', '2026-11-05 12:00:00')).toThrow(
      /CHECK constraint failed/
    )
    expect(countLandings()).toBe(0)
  })

  it('card_id must reference an existing kanban card', () => {
    expect(() => record('does-not-exist', 'f'.repeat(40))).toThrow(/FOREIGN KEY constraint failed/)
    expect(countLandings()).toBe(0)
  })
})

describe('rollback, RUN and not assumed (kodminosegi elv 11)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'card-landings-'))
    dbPath = join(dir, 'test.db')
    initDatabase(dbPath)
    createKanbanCard({ id: 'c1', title: 'card one' })
    record('c1', 'f'.repeat(40))
    expect(countLandings()).toBe(1)
  })

  afterEach(() => {
    initDatabase(':memory:')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('the script drops table and indexes, and initDatabase brings them back EMPTY', () => {
    const out = execFileSync('bash', [SCRIPT, '--db', dbPath, '--yes'], { encoding: 'utf-8' })
    expect(out).toMatch(/dropped/)

    const survivors = execFileSync(
      'sqlite3',
      [dbPath, `SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '%card_landings%'`],
      { encoding: 'utf-8' }
    ).trim()
    expect(survivors).toBe('0')

    // The forward half of the pair: initDatabase() runs on every service start, so re-creating is
    // the whole recovery. Empty, not restored -- this backs out a bad landing record, it does not
    // undo a data loss, and saying so is the point of running it rather than assuming it.
    initDatabase(dbPath)
    expect(countLandings()).toBe(0)
    record('c1', 'f'.repeat(40))
    expect(countLandings()).toBe(1)
  })

  it('without --yes it is a dry run: the rows are still there afterwards', () => {
    // A rollback tool whose default is destructive is a foot-gun in a fleet where agents run
    // scripts from card text.
    const out = execFileSync('bash', [SCRIPT, '--db', dbPath], { encoding: 'utf-8' })
    expect(out).toMatch(/DRY RUN/)
    expect(countLandings()).toBe(1)
  })
})
