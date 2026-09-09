// store/decisions-sync-resolve.sh is the missing caller of try_append_union in the SYNC direction
// (card edf9c837). Its selftest builds real repos and real merge conflicts; this file is what makes
// that selftest actually run, for the same reason decisions-append-union-selftest.test.ts exists --
// a selftest that only runs when someone remembers to type it is documentation, not a test.
//
// Why this script exists at all: both landers merge the contributing branch INTO the integration
// branch, so `ours` is already the integration side and the union's default order is right for them.
// An agent syncing does the OPPOSITE merge and resolves DECISIONS.md by hand, and when the branch's
// own entry ends up first, that entry is -- relative to every later merge-base -- a mid-file
// insertion, which is precisely the shape try_append_union then refuses for everyone else.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'store', 'decisions-sync-resolve.sh')

describe('decisions-sync-resolve.sh selftest', () => {
  it('the script exists', () => {
    expect(existsSync(SCRIPT)).toBe(true)
  })

  it('its selftest passes -- real repos, real sync merges', () => {
    const out = execFileSync('bash', [SCRIPT, '--selftest'], { encoding: 'utf-8', timeout: 120_000 })
    expect(out).toContain('selftest: PASS')
    expect(out).not.toContain('FAIL')
  }, 120_000)

  it('asks the union for theirs-first, which is the whole reason it exists', () => {
    // Comment-stripped: a line that merely NAMES the order satisfies a naive grep as well as the
    // call does (cards 06d36307, 2f0c7d24), and this file's own header names it twice.
    const code = readFileSync(SCRIPT, 'utf-8')
      .split('\n')
      .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
      .join('\n')
    expect(code).toMatch(/try_append_union\s+"\$WT"\s+"DECISIONS\.md"\s+""\s+"theirs-first"/)
  })

  it('verifies the merge DIRECTION instead of trusting the operator', () => {
    // theirs-first is only correct for a sync merge. Run after the opposite merge it would create
    // the very shape the card is about, so the check that MERGE_HEAD is an integration tip is not
    // a nicety -- it is what makes the fixed order safe to apply without asking.
    const code = readFileSync(SCRIPT, 'utf-8')
      .split('\n')
      .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
      .join('\n')
    expect(code).toContain('MERGE_HEAD')
    expect(code).toMatch(/INTEGRATION_REFS/)
  })
})
