// store/pre-dispatch-check.sh's write_hard_stop() -- card b73722e1, WhiteHat2 NO-GO F1+F2.
//
// Before this fix, `updatedAt` was the ONLY timestamp in weekly-hard-stop.json, and it was
// rewritten on EVERY run, including while newDevStopActive stayed continuously true. The newDevStop
// linked-card exception anchored its anti-bypass check on that field, so the anchor drifted forward
// every few minutes with no action from anyone -- the bypass window reopened after each write.
// This file proves write_hard_stop() now stamps `newDevStopActivatedAt` and `inProgressAtActivation`
// ONCE, at the real false->true transition, and holds both STEADY across every subsequent write
// while the stop stays active -- only `updatedAt` is allowed to keep moving.
//
// The script is copied into a temp dir with fixture state files (same harness as
// pre-dispatch-warnings.test.ts), so this runs against the REAL script without touching the live
// store. A minimal claudeclaw.db (just the one table write_hard_stop's snapshot query needs) is
// built with better-sqlite3, matching the real schema's columns.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const STORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store')
const REAL = join(STORE_DIR, 'pre-dispatch-check.sh')

let dir: string
let script: string
let tmuxTmpDir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pre-dispatch-activation-'))
  script = join(dir, 'pre-dispatch-check.sh')
  copyFileSync(REAL, script)
  chmodSync(script, 0o755)
  copyFileSync(join(STORE_DIR, 'session-limit-pattern.sh'), join(dir, 'session-limit-pattern.sh'))
  copyFileSync(join(STORE_DIR, 'session-limit-pattern.json'), join(dir, 'session-limit-pattern.json'))
  tmuxTmpDir = mkdtempSync(join(tmpdir(), 'pre-dispatch-activation-tmux-'))

  dbPath = join(dir, 'claudeclaw.db')
  const db = new Database(dbPath)
  db.exec('CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, status TEXT, archived_at INTEGER)')
  db.close()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(tmuxTmpDir, { recursive: true, force: true })
})

function seedCards(rows: Array<{ id: string; status: string; archived_at?: number | null }>) {
  const db = new Database(dbPath)
  const stmt = db.prepare('INSERT INTO kanban_cards (id, status, archived_at) VALUES (?, ?, ?)')
  for (const r of rows) stmt.run(r.id, r.status, r.archived_at ?? null)
  db.close()
}

function writePercent(pct: number) {
  writeFileSync(join(dir, 'weekly-usage.json'), JSON.stringify({ percent: pct, reset: '' }))
}

function readFlag(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'weekly-hard-stop.json'), 'utf-8'))
}

/** Run the copied script once. spawnSync, not execFileSync: a HOLD exits 0 and execFileSync only
 *  surfaces stderr on a nonzero exit, which would hide the normal path entirely. */
function run(): { stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: tmuxTmpDir }
  delete env.TMUX
  const r = spawnSync('bash', [script], { encoding: 'utf-8', env })
  return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

describe('write_hard_stop(): newDevStopActivatedAt + inProgressAtActivation (card b73722e1)', () => {
  it('a false->true transition stamps a FRESH activation timestamp and snapshots the currently in_progress cards', () => {
    seedCards([
      { id: 'anchor1', status: 'in_progress' },
      { id: 'anchor2', status: 'in_progress' },
      { id: 'not-in-progress', status: 'planned' },
    ])
    writePercent(95) // above the default newDevStop (90), below testStop (97)
    run()
    const flag = readFlag()
    expect(flag.newDevStopActive).toBe(true)
    expect(typeof flag.newDevStopActivatedAt).toBe('number')
    expect(flag.inProgressAtActivation).toEqual(['anchor1', 'anchor2'])
  })

  it('an ARCHIVED in_progress card is excluded from the snapshot (closes WhiteHat2 L1)', () => {
    seedCards([
      { id: 'live', status: 'in_progress' },
      { id: 'archived', status: 'in_progress', archived_at: 123 },
    ])
    writePercent(95)
    run()
    expect(readFlag().inProgressAtActivation).toEqual(['live'])
  })

  it('a SECOND run while the stop stays continuously active carries the activation fields forward UNCHANGED -- only updatedAt moves', () => {
    seedCards([{ id: 'anchor', status: 'in_progress' }])
    writePercent(95)
    run()
    const first = readFlag()

    // A new card goes in_progress BETWEEN the two runs -- if the snapshot were retaken, it would
    // show up; the whole point of the fix is that it must NOT.
    seedCards([{ id: 'late-arrival', status: 'in_progress' }])
    run()
    const second = readFlag()

    // newDevStopActivatedAt and inProgressAtActivation are the two fields this card's fix cares
    // about -- they must stay IDENTICAL across the two runs. `updatedAt` is int(time.time())
    // second-resolution and the two runs can legitimately land in the same wall-clock second, so
    // asserting it "moved" would be a flaky assertion about timing, not about this fix.
    expect(second.newDevStopActivatedAt).toBe(first.newDevStopActivatedAt)
    expect(second.inProgressAtActivation).toEqual(first.inProgressAtActivation)
  })

  it('the stop lifting (back below threshold) clears the activation fields, ready for a FRESH one next time', () => {
    seedCards([{ id: 'anchor', status: 'in_progress' }])
    writePercent(95)
    run()
    expect(readFlag().newDevStopActivatedAt).not.toBeNull()

    writePercent(10) // well below newDevStop
    run()
    const cleared = readFlag()
    expect(cleared.newDevStopActive).toBe(false)
    expect(cleared.newDevStopActivatedAt).toBeNull()
    expect(cleared.inProgressAtActivation).toEqual([])
  })

  it('reactivating after a full lift-and-reset takes a FRESH snapshot, not the stale one', () => {
    seedCards([{ id: 'first-anchor', status: 'in_progress' }])
    writePercent(95)
    run()

    writePercent(10)
    run()

    // Different in_progress set for the second activation episode.
    const db = new Database(dbPath)
    db.prepare("UPDATE kanban_cards SET status = 'done' WHERE id = 'first-anchor'").run()
    db.prepare("INSERT INTO kanban_cards (id, status) VALUES ('second-anchor', 'in_progress')").run()
    db.close()
    writePercent(95)
    run()
    const secondActivation = readFlag()

    // The snapshot content changing (not a stale carry-over of 'first-anchor') is the real proof
    // of a fresh activation.
    expect(secondActivation.inProgressAtActivation).toEqual(['second-anchor'])
  })

  it('an unreadable/missing claudeclaw.db fails safe -- empty snapshot, not a crashed script', () => {
    rmSync(dbPath) // no DB at all for this run
    writePercent(95)
    const { stdout } = run()
    expect(stdout).toContain('DISPATCH:HOLD')
    const flag = readFlag()
    expect(flag.newDevStopActive).toBe(true) // the gate decision itself is unaffected
    expect(flag.inProgressAtActivation).toEqual([])
    expect(existsSync(join(dir, 'weekly-hard-stop.json'))).toBe(true)
  })
})
