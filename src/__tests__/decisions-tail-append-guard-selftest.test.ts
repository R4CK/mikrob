// store/decisions-tail-append-guard.sh ships a selftest with real git repos and real conflicting
// shapes, and it only guards anything if it actually runs -- same reason as
// decisions-append-union-selftest.test.ts, whose header explains the pattern. Both landing scripts
// source this file (mopsion-land.sh and marveen-land.sh) and call it BEFORE attempting the merge, so
// a regression here silently reopens the exact gap card 375a81c1 measured: a mid-file DECISIONS.md
// splice that merges as a real git conflict even though neither side deleted anything.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'store', 'decisions-tail-append-guard.sh')

describe('decisions-tail-append-guard.sh selftest', () => {
  it('the script exists', () => {
    expect(existsSync(SCRIPT)).toBe(true)
  })

  it('its selftest passes -- real repos, tail appends vs mid-file splices', () => {
    const out = execFileSync('bash', [SCRIPT, '--selftest'], { encoding: 'utf-8', timeout: 60_000 })
    expect(out).toContain('selftest: PASS')
    expect(out).not.toContain('FAIL')
  }, 60_000)

  it('both landing scripts source the guard and call it before attempting their merge', () => {
    for (const lander of ['mopsion-land.sh', 'marveen-land.sh']) {
      const src = execFileSync('cat', [join(REPO_ROOT, 'store', lander)], { encoding: 'utf-8' })
      expect(src).toContain('decisions-tail-append-guard.sh')
      expect(src).toContain('decisions_tail_append_ok')
      // The call must appear BEFORE the merge attempt, not after -- that ordering is the whole point
      // (a clear, early refusal instead of a raw conflict downstream).
      const callIdx = src.indexOf('decisions_tail_append_ok "')
      const mergeIdx = src.indexOf('merge --no-ff')
      expect(callIdx).toBeGreaterThan(-1)
      expect(mergeIdx).toBeGreaterThan(-1)
      expect(callIdx).toBeLessThan(mergeIdx)
    }
  })
})
