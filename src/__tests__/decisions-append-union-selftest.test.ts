// store/decisions-append-union.sh ships a selftest with real git repos and real merge conflicts,
// and until now nothing ran it. Both landing scripts SOURCE that file -- marveen-land.sh:85 and
// cleancore-land.sh:58 -- so a regression in it is a regression in every agent's landing path.
//
// Same shape and same reason as lockfile-sync-check-selftest.test.ts: a selftest that only runs
// when someone remembers to type it is documentation, not a test.
//
// The immediate reason it matters (card d56786a7): the function froze landings for MINUTES on an
// O(n^2) bash prefix strip, and every correctness case in that selftest passed happily throughout,
// because they all run on a few hundred bytes. The suite could not see it. The realistic-size case
// added with the fix is the one that can -- and it only guards anything if it actually runs.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'store', 'decisions-append-union.sh')

describe('decisions-append-union.sh selftest', () => {
  it('the script exists', () => {
    expect(existsSync(SCRIPT)).toBe(true)
  })

  it('its selftest passes -- real repos, real conflicts, realistic size', () => {
    // Generous timeout: the whole point of the realistic-size case is that the BROKEN form takes
    // minutes (measured 313s), so this must be allowed to run long enough to actually fail rather
    // than be killed and look like an infrastructure problem.
    const out = execFileSync('bash', [SCRIPT, '--selftest'], { encoding: 'utf-8', timeout: 600_000 })
    expect(out).toContain('selftest: PASS')
    expect(out).not.toContain('FAIL')
  }, 600_000)

  // The complexity fix itself, pinned as a shape. The timing case above is the real guard, but it
  // costs seconds; this costs nothing and names the exact construct that must not come back.
  it('slices the added half by OFFSET, never by pattern-strip', () => {
    const src = execFileSync('cat', [SCRIPT], { encoding: 'utf-8' })
    expect(src).toContain('ours_added="${ours:${#base}}"')
    expect(src).toContain('theirs_added="${theirs:${#base}}"')
    // CODE lines only. The fix's own comment explains WHY the pattern-strip form is wrong and
    // therefore quotes it, so scanning the whole file would fail on the prose that documents the
    // fix -- a trap this repo's docs guards have sprung on me before. Scoping the scan to code is
    // what the assertion actually means; weakening the pattern would not be.
    const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    // The pattern-strip form is O(n^2) in bash: 405s on the real 447 KB DECISIONS.md, against
    // 0.010s for the offset form. The `case` above it has already proved the literal prefix, so
    // there is nothing left for a pattern to match.
    expect(code).not.toContain('${ours#')
    expect(code).not.toContain('${theirs#')
  })
})
