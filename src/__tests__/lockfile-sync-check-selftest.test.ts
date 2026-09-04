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
