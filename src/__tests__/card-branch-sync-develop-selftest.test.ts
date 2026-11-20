// store/card-branch-sync-develop.sh (card 84f90b4e) is the single command an agent runs instead
// of a plain `git merge origin/develop` to sync a card/agent branch. It wraps
// decisions-sync-resolve.sh so the already-tested append-append resolver actually fires when an
// agent syncs by hand, instead of the manual resolution logged four times on card a2028f35 and
// once each on c4590365/6d8ef952/30aa8b29 on 2026-11-20. This file is what makes the script's own
// --selftest actually run under the gate, same reasoning as decisions-sync-resolve-selftest.test.ts.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'store', 'card-branch-sync-develop.sh')

describe('card-branch-sync-develop.sh selftest', () => {
  it('the script exists', () => {
    expect(existsSync(SCRIPT)).toBe(true)
  })

  it('its selftest passes -- the a2028f35 shape resolves with no manual step, a real edit still refuses', () => {
    const out = execFileSync('bash', [SCRIPT, '--selftest'], { encoding: 'utf-8', timeout: 120_000 })
    expect(out).toContain('selftest: PASS')
    expect(out).not.toContain('FAIL')
  }, 120_000)

  it('calls decisions-sync-resolve.sh with the caller-supplied integration ref, not a hardcoded one', () => {
    // The bug this pins: decisions-sync-resolve.sh checks MERGE_HEAD against
    // DECISIONS_SYNC_INTEGRATION_REFS (default "origin/develop origin/main"), so calling it
    // without forwarding this script's own <integration-ref> argument silently refuses every
    // merge whose integration branch is not literally one of those two defaults -- exactly what
    // broke this file's own first draft (case 1 of the selftest went red until this line was added).
    const code = readFileSync(SCRIPT, 'utf-8')
      .split('\n')
      .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
      .join('\n')
    expect(code).toMatch(/DECISIONS_SYNC_INTEGRATION_REFS="\$REF"/)
  })

  it('reverts the merge if the append-only backstop catches a violation, never leaves it half-applied', () => {
    const code = readFileSync(SCRIPT, 'utf-8')
    expect(code).toContain('decisions_append_only_check_merge')
    expect(code).toMatch(/git -C "\$WT" reset --hard "\$before_sha"/)
  })
})
