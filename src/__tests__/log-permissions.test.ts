// Card 9cbc471e (Cybersec L1/L2 on 6cee9225): store/*.log files are created group-readable (664,
// one at 644). Nothing in them is secret today; a log is simply the file that grows a secret later,
// so least-privilege here is preventive rather than a response to a leak.
//
// HERMETIC ON PURPOSE. The thing under test is runtime state -- actual files in the install's
// store/ -- and asserting on those would make this test pass or fail by what the machine happened
// to write, and fail outright in a checkout that has no logs. So the CHECKER is driven against a
// temp directory the test builds itself, with both an offender and an honest file present, and the
// live sweep stays an operator action.
//
// WHAT THIS DOES NOT COVER, said out loud: the two cron-redirect logs. `kanban-snapshot-cron.log`
// and `db-backup-cron.log` are created by CRON'S OWN SHELL through the `>>` in the crontab line,
// before the script starts, so the `umask 077` both scripts already carry (cards 90e4cbdf,
// e804262d) cannot reach them -- measured: both scripts set it, both cron logs are still 664, while
// the files those same scripts create themselves are 600. Fixing that means `umask 077;` in the
// crontab line, which is host state and not in this repo.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { REPO_ROOT } from './helpers/repo-location.js'

const SCRIPT = join(REPO_ROOT, 'store/log-permissions.sh')

/** Run the checker/fixer against `dir`; returns its exit code and combined output. */
function run(mode: '--check' | '--fix', dir: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [SCRIPT, mode, dir], { encoding: 'utf-8', stdio: 'pipe' })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function fixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'logperm-'))
  writeFileSync(join(dir, 'tight.log'), 'x')
  writeFileSync(join(dir, 'loose.log'), 'x')
  writeFileSync(join(dir, 'rotated.log-2026-09-01.gz'), 'x')
  writeFileSync(join(dir, 'not-a-log.txt'), 'x')
  chmodSync(join(dir, 'tight.log'), 0o600)
  chmodSync(join(dir, 'loose.log'), 0o664)
  chmodSync(join(dir, 'rotated.log-2026-09-01.gz'), 0o644)
  chmodSync(join(dir, 'not-a-log.txt'), 0o666)
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('store log permissions (card 9cbc471e)', () => {
  it('--check names every file readable beyond the owner, and exits non-zero', () => {
    const { dir, cleanup } = fixture()
    try {
      const { code, out } = run('--check', dir)
      expect(code, 'a loose file must make the check fail').toBe(1)
      expect(out).toContain('loose.log')
      expect(out, 'rotated archives carry the same content and the same risk').toContain(
        'rotated.log-2026-09-01.gz'
      )
      expect(out, 'an already-tight file is not a finding').not.toContain('tight.log')
    } finally {
      cleanup()
    }
  })

  it('--check stays out of files that are not logs', () => {
    // The sweep must not quietly re-permission unrelated files in store/ -- several are meant to be
    // group-readable, and a tool that tightens everything it can see is one nobody dares run.
    const { dir, cleanup } = fixture()
    try {
      const { out } = run('--check', dir)
      expect(out).not.toContain('not-a-log.txt')
      run('--fix', dir)
      expect(statSync(join(dir, 'not-a-log.txt')).mode & 0o777).toBe(0o666)
    } finally {
      cleanup()
    }
  })

  it('--fix tightens the offenders to 600 and then the check passes', () => {
    const { dir, cleanup } = fixture()
    try {
      expect(run('--check', dir).code).toBe(1)
      expect(run('--fix', dir).code).toBe(0)
      expect(statSync(join(dir, 'loose.log')).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, 'rotated.log-2026-09-01.gz')).mode & 0o777).toBe(0o600)
      expect(run('--check', dir).code, 'the fix must actually satisfy the check').toBe(0)
    } finally {
      cleanup()
    }
  })

  it('a clean directory passes -- otherwise the check is just a red light', () => {
    // The control. Without it, a checker that failed on everything would satisfy every case above.
    const dir = mkdtempSync(join(tmpdir(), 'logperm-clean-'))
    try {
      writeFileSync(join(dir, 'only.log'), 'x')
      chmodSync(join(dir, 'only.log'), 0o600)
      const { code, out } = run('--check', dir)
      expect(code).toBe(0)
      expect(out).toContain('owner-only')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a missing directory is an error, not a silent pass', () => {
    // A sweep that reports "all clean" for a path that does not exist is the worst possible answer.
    const { code } = run('--check', join(tmpdir(), 'logperm-does-not-exist-9cbc471e'))
    expect(code).toBe(2)
  })
})
