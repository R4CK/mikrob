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

  // --- card d8c3d10e: the dep-diff draft, and the one property that matters about it ----------

  it('still runs at least 15 cases -- deleting cases is a failure, not a cleanup', () => {
    // The wrapper above accepts any positive count, so the fail-soft cases could be removed without
    // anything going red. Same discipline the landers' selftests already use.
    const out = execFileSync('bash', [NPM_SCRIPT, '--selftest'], { encoding: 'utf-8' })
    const m = out.match(/selftest: (\d+) case\(s\), PASS/)
    expect(m, out).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThanOrEqual(15)
  })

  it('the dep-diff draft CANNOT change the verdict', () => {
    // The load-bearing property. This script is a landing gate, so an advisory summary that could
    // fail it would be worse than no summary -- the same reason the check refuses to let a harness
    // fault become a verdict. Pinned at source level because the ordering is the guarantee: the
    // comparison decides, the draft is appended afterwards, and the exit uses the comparison's code.
    const src = execFileSync('cat', [NPM_SCRIPT], { encoding: 'utf-8' })
    const decide = src.indexOf('SYNC_RC=$?')
    const draft = src.indexOf('dep_diff_draft "$SYNC_OUT"')
    const exit = src.indexOf('exit "$SYNC_RC"')
    expect(decide, 'the comparison result is not captured').toBeGreaterThan(-1)
    expect(draft, 'the draft is not wired at all').toBeGreaterThan(draft === -1 ? 0 : -1)
    expect(draft).toBeGreaterThan(decide)
    expect(exit).toBeGreaterThan(draft)
    // And it only ever runs on the FAILING path, so a healthy landing pays nothing.
    expect(src).toContain('[ "$SYNC_RC" -eq 1 ] && dep_diff_draft')
  })

  it('the draft is opt-outable, and its helper returns 0 on every path', () => {
    const src = execFileSync('cat', [NPM_SCRIPT], { encoding: 'utf-8' })
    expect(src).toContain('NPM_LOCKFILE_SYNC_NO_LLM')
    const fn = src.slice(src.indexOf('dep_diff_draft() {'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    // Every early exit is a `return 0`; a bare `return 1` anywhere would make a router problem
    // capable of failing a landing.
    expect(body).not.toMatch(/return [1-9]/)
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
