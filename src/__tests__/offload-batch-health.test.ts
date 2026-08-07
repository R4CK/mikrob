// Guard: the overnight batch must be able to report that it FAILED (card 5f00664c).
//
// The scheduled task launches it with `nohup ... &`, which returns exit 0 in ~11ms whatever happens
// next. So `timeoutMs: 15000` can never fire and `failThreshold: 3` can never alert: "fired + exit 0"
// looks identical whether the batch drafted twenty cards or died instantly (Cybersec finding on card
// 975e5a97). Backgrounding is correct -- a twenty-card 7B run must not hold the scheduler tick -- so
// the signal has to come from the LOG, read back by a fast foreground check whose exit code is real.
//
// The canary from 975e5a97 covers the neighbouring case (never fired / missed window). This covers the
// one it cannot see: fired, then died immediately.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'offload-batch-run.sh')
const SRC = readFileSync(SCRIPT, 'utf-8')

/** Copy of the script with its LOG path redirected, so nothing touches the real one. */
function withLog(dir: string, logPath: string): string {
  const copy = join(dir, 'batch.sh')
  writeFileSync(copy, SRC.replace(/^LOG=.*$/m, `LOG="${logPath}"`))
  return copy
}

function run(script: string, args: string[]): { status: number; out: string } {
  try {
    return { status: 0, out: execFileSync('bash', [script, ...args], { encoding: 'utf-8', stdio: 'pipe' }) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

const stamp = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`

const hoursAgo = (h: number) => stamp(new Date(Date.now() - h * 3600_000))

describe('offload batch health signal (card 5f00664c)', () => {
  it('reports FRESH, exit 0, after a recent successful run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'offload-health-'))
    try {
      const log = join(dir, 'batch.log')
      writeFileSync(log, `[${hoursAgo(1)}] batch END status=ok drafted=7\n`)
      const r = run(withLog(dir, log), ['--status'])
      expect(r.out).toContain('FRESH')
      expect(r.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The case the canary structurally cannot see: the task fired, so the scheduler is happy.
  it('reports the failure when the last run ended badly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'offload-health-'))
    try {
      const log = join(dir, 'batch.log')
      writeFileSync(log, `[${hoursAgo(1)}] batch END status=no-token drafted=0\n`)
      const r = run(withLog(dir, log), ['--status'])
      expect(r.out).toContain('LAST-RUN-FAILED')
      expect(r.out).toContain('no-token') // the whole status, not truncated at the hyphen
      expect(r.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports STALE when the last successful run is older than the window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'offload-health-'))
    try {
      const log = join(dir, 'batch.log')
      writeFileSync(log, `[${hoursAgo(72)}] batch END status=ok drafted=3\n`)
      const r = run(withLog(dir, log), ['--status'])
      expect(r.out).toContain('STALE')
      expect(r.status).toBe(1)
      // ...and a wider window accepts the same log, so STALE is about the bound, not the parse
      expect(run(withLog(dir, log), ['--status', '--max-age-hours', '100']).status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('distinguishes "never ran" from "ran but never finished"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'offload-health-'))
    try {
      const missing = join(dir, 'absent.log')
      expect(run(withLog(dir, missing), ['--status']).out).toContain('NEVER-RAN')
      const partial = join(dir, 'partial.log')
      // a start line but no END line: the process died mid-run
      writeFileSync(partial, `[${hoursAgo(1)}] batch start: 5 candidate cards, cap 20\n`)
      const r = run(withLog(dir, partial), ['--status'])
      expect(r.out).toContain('NEVER-COMPLETED')
      expect(r.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A non-numeric bound would make `(( age_h > MAX_AGE_H ))` treat it as 0 and report STALE every
  // time; a check that always fires gets ignored as fast as one that never does.
  it.each(['abc', '', '12h'])('exits 2 on an invalid --max-age-hours %j', (bad) => {
    const dir = mkdtempSync(join(tmpdir(), 'offload-health-'))
    try {
      const log = join(dir, 'batch.log')
      writeFileSync(log, `[${hoursAgo(1)}] batch END status=ok drafted=1\n`)
      const r = run(withLog(dir, log), ['--status', '--max-age-hours', bad])
      expect(r.status).toBe(2)
      expect(r.out).not.toContain('FRESH')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The END line has to survive abnormal exits, otherwise a crashed run is indistinguishable from a
  // run that never started -- and the whole point is telling those apart.
  it('writes the END line from an EXIT trap, not just on the success path', () => {
    expect(SRC).toMatch(/trap emit_end_line EXIT/)
    const dir = mkdtempSync(join(tmpdir(), 'offload-health-'))
    try {
      const log = join(dir, 'batch.log')
      // force the early no-token abort, which returns before any normal completion
      const copy = join(dir, 'batch.sh')
      writeFileSync(copy, SRC.replace(/^LOG=.*$/m, `LOG="${log}"`).replace(/^TOK=.*$/m, 'TOK=""'))
      run(copy, [])
      expect(readFileSync(log, 'utf-8')).toMatch(/batch END status=no-token/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
