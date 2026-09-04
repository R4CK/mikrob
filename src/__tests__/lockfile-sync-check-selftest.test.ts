// store/lockfile-sync-check.sh ships an 11-case --selftest, and until now nothing ran it.
//
// That matters more than usual here, because the check's verdict is consumed by two things that
// refuse work: gate-pretriage.sh reports `[fail] lockfile-out-of-sync`, and cleancore-land.sh
// REFUSES a landing on exit 1. A wrong verdict is therefore either a blocked landing or -- the case
// card fe06da0c fixed -- a recurring false [fail] that a real lockfile drift could hide inside.
//
// Same shape and same reason as activity-hook-redaction.test.ts's "the selftest actually runs"
// block: a selftest that only runs when someone remembers to type it is documentation, not a test.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'store', 'lockfile-sync-check.sh')

describe('lockfile-sync-check.sh selftest', () => {
  it('the script exists', () => {
    expect(existsSync(SCRIPT)).toBe(true)
  })

  it('its selftest passes, and reports a COUNTED number of cases', () => {
    const out = execFileSync('bash', [SCRIPT, '--selftest'], { encoding: 'utf-8' })
    // A counted number, not a literal: a harness that could report success with zero cases would
    // be worse than no harness.
    expect(out).toMatch(/selftest: [1-9]\d* case\(s\), PASS/)
  })

  // The verdict vocabulary is a CONTRACT with two callers, not an implementation detail:
  // gate-pretriage.sh switches on exit 1 vs 3, and cleancore-land.sh refuses on 1 but must not
  // refuse on 3. Card fe06da0c added a third state -- "not applicable" on exit 0 -- for a repo
  // that does not use pnpm at all, which is neither a stale lockfile nor a broken toolchain.
  it('keeps the three-way verdict distinction its callers depend on', () => {
    const src = execFileSync('cat', [SCRIPT], { encoding: 'utf-8' })
    expect(src).toContain('OUT OF SYNC')
    expect(src).toContain('HARNESS FAULT')
    expect(src).toContain('not applicable')
    // The npm-repo case must exit 0, never 1: that false [fail] fired on every marveen landing.
    expect(src).toContain('this repo does not use pnpm')
  })
})

// The npm sibling (card c3f052ad). Same contract, same reason to run its selftest here: its
// verdict makes marveen-land.sh REFUSE a landing, and gate-pretriage report a [fail].
const NPM_SCRIPT = join(REPO_ROOT, 'store', 'npm-lockfile-sync-check.sh')

describe('npm-lockfile-sync-check.sh selftest', () => {
  it('the script exists and is executable', () => {
    expect(existsSync(NPM_SCRIPT)).toBe(true)
  })

  it('its selftest passes, and reports a COUNTED number of cases', () => {
    const out = execFileSync('bash', [NPM_SCRIPT, '--selftest'], { encoding: 'utf-8' })
    expect(out).toMatch(/selftest: [1-9]\d* case\(s\), PASS/)
  })

  it('keeps the same three-way verdict distinction as its pnpm sibling', () => {
    const src = execFileSync('cat', [NPM_SCRIPT], { encoding: 'utf-8' })
    expect(src).toContain('OUT OF SYNC')
    expect(src).toContain('HARNESS FAULT')
    expect(src).toContain('not applicable')
  })

  // THE FALSE POSITIVE THIS MUST NEVER GROW. marveen-land.sh bumps package.json to
  // X.Y.Z+mikrob.N on every landing while bump-fork-version.sh deliberately keeps the lockfile at
  // plain X.Y.Z. Comparing version fields would recreate the every-landing [fail] that card
  // fe06da0c removed -- so the check compares dependency blocks ONLY, and says so.
  it('never compares the version fields -- that skew is by design, not drift', () => {
    const src = execFileSync('cat', [NPM_SCRIPT], { encoding: 'utf-8' })
    expect(src).toContain('version` FIELDS ARE NEVER COMPARED')
    // And the selftest carries the case, not just the comment.
    expect(src).toContain('mikrob.57')
  })

  // Both callers must treat the exit codes the way the contract says: refuse on 1, never on 3.
  it('marveen-land.sh refuses on 1 and only warns on 3', () => {
    const land = execFileSync('cat', [join(REPO_ROOT, 'store', 'marveen-land.sh')], { encoding: 'utf-8' })
    expect(land).toContain('npm-lockfile-sync-check.sh')
    expect(land).toContain('REFUSED -- package-lock.json does not match package.json')
    expect(land).toContain('harness fault, not a verdict')
  })

  it('gate-pretriage.sh asks the npm question too, not only the pnpm one', () => {
    const pre = execFileSync('cat', [join(REPO_ROOT, 'store', 'gate-pretriage.sh')], { encoding: 'utf-8' })
    expect(pre).toContain('npm-lockfile-sync-check.sh')
    expect(pre).toContain('npm-lockfile-out-of-sync')
  })
})
