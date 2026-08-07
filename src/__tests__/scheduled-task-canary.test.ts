// Guard: a scheduled task that never fires must not stay invisible (card 975e5a97).
//
// offload-overnight-batch was due at 03:00 every night and never ran once in five days. Nothing
// noticed, because a task that does not fire produces no log, no error and no alert -- the absence of
// output is indistinguishable from a quiet success. The DB knew: all 7 of its recorded runs were
// `missed`, because a `heartbeat` task gets a 30-minute catch-up budget and the host is asleep at 03:00.
// Run against the live board this canary found FOUR such tasks, not one.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'scheduled-task-canary.sh')

function run(args: string[]): { status: number; out: string } {
  try {
    return { status: 0, out: execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf-8', stdio: 'pipe' }) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

/** Temp tasks dir + DB. `runs` is a per-task list of statuses, oldest first. */
function makeBoard(tasks: Array<{ name: string; enabled?: boolean; runs: string[] }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'task-canary-'))
  const rows: string[] = []
  tasks.forEach((t) => {
    mkdirSync(join(dir, 'tasks', t.name), { recursive: true })
    writeFileSync(join(dir, 'tasks', t.name, 'task-config.json'), JSON.stringify({ enabled: t.enabled ?? true }))
    t.runs.forEach((status, i) => rows.push(`('${t.name}','a',${i + 1},'${status}')`))
  })
  const sql = [
    'CREATE TABLE task_runs (id INTEGER PRIMARY KEY, name TEXT, agent TEXT, ts INTEGER, status TEXT);',
    rows.length ? `INSERT INTO task_runs (name,agent,ts,status) VALUES ${rows.join(',')};` : '',
  ].join('\n')
  execFileSync('sqlite3', [join(dir, 'db.sqlite')], { input: sql, stdio: 'pipe' })
  return dir
}

const check = (dir: string, extra: string[] = []) =>
  run(['--tasks-dir', join(dir, 'tasks'), '--db', join(dir, 'db.sqlite'), ...extra])

describe('scheduled-task-canary.sh (card 975e5a97)', () => {
  it('passes its own selftest', () => {
    const r = run(['--selftest'])
    expect(r.out).toContain('selftest OK')
    expect(r.status).toBe(0)
  })

  it('flags a task that has run records but never fired', () => {
    const dir = makeBoard([{ name: 'nightly', runs: ['missed', 'missed', 'missed'] }])
    try {
      const r = check(dir)
      expect(r.out.split('\n')[0]).toMatch(/^STALE-TASKS 1$/)
      expect(r.out).toContain('never-fired  nightly')
      expect(r.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags a task that used to fire and has since gone quiet', () => {
    const dir = makeBoard([{ name: 'lapsed', runs: ['fired', 'missed', 'missed', 'missed'] }])
    try {
      const r = check(dir)
      expect(r.out).toContain('all-missed   lapsed')
      expect(r.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stays quiet for healthy, disabled, and not-yet-due tasks', () => {
    const dir = makeBoard([
      { name: 'healthy', runs: ['fired', 'fired', 'fired'] },
      { name: 'disabled', enabled: false, runs: ['missed', 'missed', 'missed'] },
      { name: 'brandnew', runs: [] }, // created, never came due -- flagging it would train people to ignore this
    ])
    try {
      const r = check(dir)
      expect(r.out.split('\n')[0]).toMatch(/^OK /)
      expect(r.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not flag a recent miss that is still inside the window', () => {
    const dir = makeBoard([{ name: 'blip', runs: ['fired', 'fired', 'missed'] }])
    try {
      expect(check(dir).status).toBe(0)
      // ...but a window of 1 makes that same single miss a finding
      expect(check(dir, ['--window', '1']).out).toContain('all-missed   blip')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A non-numeric window would make `[ "$n" -ge "$WINDOW" ]` error and evaluate false, so every task
  // would look healthy -- the same silent all-clear this script exists to report.
  it.each(['abc', '0', '-1'])('exits 2 on an invalid window %j instead of passing everything', (w) => {
    const dir = makeBoard([{ name: 'nightly', runs: ['missed', 'missed', 'missed'] }])
    try {
      const r = check(dir, ['--window', w])
      expect(r.status).toBe(2)
      expect(r.out).toContain(`ERROR:invalid-window:${w}`)
      expect(r.out).not.toContain('OK (')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('errors rather than reporting a clean board when it cannot read its inputs', () => {
    const dir = makeBoard([{ name: 'x', runs: ['fired'] }])
    try {
      expect(run(['--tasks-dir', join(dir, 'nope'), '--db', join(dir, 'db.sqlite')]).status).toBe(2)
      expect(run(['--tasks-dir', join(dir, 'tasks'), '--db', join(dir, 'nope.sqlite')]).status).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
