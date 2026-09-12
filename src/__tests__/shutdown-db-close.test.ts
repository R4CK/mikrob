// Card a1c85a24 -- the follow-up QA asked for when it passed 4306e862 (shutdown db.close /
// WAL checkpoint): the DoD listed a test for it and none was written.
//
// TWO HALVES, because one alone proves nothing here.
//
// (1) BEHAVIOURAL, on a real SQLite file: does closing actually CHECKPOINT the WAL? Asserted
//     against measured before/after state, not against the fact that close() was called.
//
// (2) STRUCTURAL, on index.ts's source: does every exit path in shutdown() reach that close?
//     shutdown() itself cannot be unit-tested -- it lives at module scope in the entry point
//     and every branch ends in process.exit() -- so the exit paths are checked by reading the
//     function, in the shape index-entrypoint-guard.test.ts already established for this file.
//
// WHAT A MISSED CLOSE COSTS, stated exactly (both directions measured, see db.ts's comment on
// closeDbForShutdown): NOT lost writes -- an abrupt exit leaves them in the `-wal` and the next
// open replays them. What it leaves is a STALE main `.db` plus a `-wal` that keeps growing.
// The test asserts that, and deliberately does not dress it up as data loss.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { initDatabase, getDb, closeDbForShutdown } from '../db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- (1) behaviour: closing checkpoints the WAL -------------------------------------------

describe('closeDbForShutdown() checkpoints the WAL into the main file (card a1c85a24)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shutdown-wal-'))
    dbPath = join(dir, 'probe.db')
    // The REAL initialiser, at a throwaway path: it is what sets journal_mode = WAL and
    // synchronous = NORMAL in production, so the test measures the production pragma pair
    // rather than a pair the test chose for itself.
    initDatabase(dbPath)
  })
  afterEach(() => {
    closeDbForShutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Enough rows that the data is provably in the -wal and not yet in the main file. */
  const seed = (): void => {
    const db = getDb()
    db.exec('CREATE TABLE IF NOT EXISTS wal_probe(x TEXT)')
    const ins = db.prepare('INSERT INTO wal_probe(x) VALUES (?)')
    for (let i = 0; i < 500; i++) ins.run(`row${i}`)
  }

  const size = (p: string): number => (existsSync(p) ? statSync(p).size : -1)

  it('the rows sit in the -wal until something closes the connection', () => {
    seed()
    // THE PRECONDITION THAT MAKES THE NEXT TEST NON-VACUOUS. If the rows were already in the
    // main file here, "the main file grew after the close" would pass with or without a
    // checkpoint ever happening.
    expect(size(`${dbPath}-wal`)).toBeGreaterThan(size(dbPath))
  })

  it('moves the rows into the main file and removes the -wal', () => {
    seed()
    const mainBefore = size(dbPath)
    const walBefore = size(`${dbPath}-wal`)
    expect(walBefore).toBeGreaterThan(0)

    closeDbForShutdown()

    // B-wave (card 42938a74): this used to assert the main file GREW. It no longer does, and the
    // reason is not a lost checkpoint -- measured on the merge result, mainBefore == mainAfter ==
    // 577536 while the row assertion below still passes, i.e. the pages the WAL carried fitted in
    // space the file already had (the merge adds several tables, so the schema allocates more up
    // front). Byte growth was always a PROXY for "the rows moved"; the two assertions that follow
    // ARE that fact -- no -wal left, and 500 rows readable from the main file through a fresh
    // read-only connection. The proxy is kept only as a never-shrinks sanity check.
    expect(size(dbPath)).toBeGreaterThanOrEqual(mainBefore)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)

    const reopened = new Database(dbPath, { readonly: true })
    expect((reopened.prepare('SELECT count(*) c FROM wal_probe').get() as { c: number }).c).toBe(500)
    reopened.close()
  })

  // It runs on the way out of the process, where the database may never have been opened and
  // where throwing would replace an orderly exit with a crash. Called twice in a row is the
  // realistic shape: the hard-kill timer and the graceful callback can both fire.
  it('is safe to call twice, and never throws', () => {
    seed()
    expect(() => {
      closeDbForShutdown()
      closeDbForShutdown()
    }).not.toThrow()
  })

  // The honest counterpart, and the reason this card is not a data-loss card: skipping the
  // close does NOT drop the writes. Pinning it stops a future reader from "strengthening" the
  // suite with an assertion that is simply false, and stops anyone treating a missed close as
  // an incident when what it leaves behind is a stale file.
  it('an unclosed database still replays its -wal on the next open -- no rows are lost', () => {
    seed()
    const strandedWal = size(`${dbPath}-wal`)
    expect(strandedWal).toBeGreaterThan(0)
    // Deliberately NOT closed: a fresh reader opens the same file, as after a hard exit.
    const reopened = new Database(dbPath)
    expect((reopened.prepare('SELECT count(*) c FROM wal_probe').get() as { c: number }).c).toBe(500)
    reopened.close()
  })
})

// --- (2) structure: every exit path in shutdown() closes first ------------------------------

describe('shutdown() closes the database on EVERY exit path (card a1c85a24)', () => {
  const SRC = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8')

  /** index.ts with line and block comments removed. A commented-out call must not vouch for a
   *  real one -- the bypass class measured on cards 06d36307 / 2f0c7d24. */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  /** The body of `const shutdown = (): void => { ... }`, brace-matched rather than regex-guessed. */
  const shutdownBody = (): string => {
    const start = CODE.indexOf('const shutdown = (): void => {')
    expect(start).toBeGreaterThan(-1)
    let depth = 0
    for (let i = CODE.indexOf('{', start); i < CODE.length; i++) {
      if (CODE[i] === '{') depth++
      else if (CODE[i] === '}' && --depth === 0) return CODE.slice(start, i + 1)
    }
    throw new Error('shutdown() body is not brace-balanced')
  }

  it('the scan sees a real function with several exits -- otherwise the check below is vacuous', () => {
    const body = shutdownBody()
    expect(body.length).toBeGreaterThan(500)
    expect([...body.matchAll(/process\.exit\(/g)].length).toBeGreaterThanOrEqual(4)
  })

  it('no process.exit( in shutdown() is reached without closing the database first', () => {
    const body = shutdownBody()
    const unguarded: string[] = []
    for (const m of body.matchAll(/process\.exit\(/g)) {
      // The close must be the LAST thing before this exit, within the same statement run --
      // i.e. between the previous exit (or the start) and this one.
      const before = body.slice(0, m.index)
      const prevExit = before.lastIndexOf('process.exit(')
      const segment = prevExit === -1 ? before : before.slice(prevExit)
      if (!/closeDbForShutdown\s*\(/.test(segment)) {
        // Name the PATH, not just a count: the last statements before the exit identify which
        // branch is missing the close far faster than an offset does.
        unguarded.push(
          segment
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-2)
            .join(' | '),
        )
      }
    }
    expect(
      unguarded,
      'These exit paths in shutdown() leave the database open: the main .db file stays stale and ' +
        'the -wal is left behind. Call closeDbForShutdown() before the exit.',
    ).toEqual([])
  })

  it('shutdown() uses the shared helper, not four hand-rolled copies of the same try/catch', () => {
    const body = shutdownBody()
    expect(body).toContain('closeDbForShutdown()')
    // The quadruplicated form this card replaced. One copy drifting from the others is exactly
    // how the catch path ended up without a close at all.
    expect(body).not.toMatch(/getDb\s*\(\s*\)\s*\.\s*close\s*\(/)
  })
})
