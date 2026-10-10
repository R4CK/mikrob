// The noisy-command-guard / noisy-run selftests, enforced in CI (card fc3a6a39).
//
// WHY THIS FILE EXISTS. scripts/hooks/noisy-command-guard.selftest.py and the new
// scripts/noisy-run.selftest.sh carried real coverage (28 base cases, rewrite-mode JSON shape,
// execution-level quoting round-trip, small-output skip, git log/diff --stat partial-keep) that
// nothing ran automatically -- same shape as graph-tooling-selftests.test.ts's stated reason: a
// selftest that only runs when someone types its name is documentation, not a gate.
//
// Floors are the counts at the time this file landed. Raise them when cases are added; a shrinking
// floor is a silently-lost control, not a passing test.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')

function run(cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 120_000 })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

describe('noisy-command-guard / noisy-run selftests actually run in CI', () => {
  it('noisy-command-guard.selftest.py passes (base cases + rewrite-mode + quoting round-trip)', () => {
    const { code, out } = run('python3', [join(ROOT, 'scripts', 'hooks', 'noisy-command-guard.selftest.py')])
    expect(out).not.toContain('FAIL')
    expect(out).toContain('rewrite-mode: default==block, JSON shape, non-noisy silent-allow, suite-semaphore untouched')
    expect(out).toContain('rewrite-mode quoting round-trip (execution-level, 4 adversarial commands)')
    const m = out.match(/All (\d+) base cases \+ rewrite-mode \+ quoting round-trip checks passed\./)
    expect(m, `no summary line in output:\n${out}`).not.toBeNull()
    expect(Number(m![1]), `base-case count shrank below its floor:\n${out}`).toBeGreaterThanOrEqual(28)
    expect(code).toBe(0)
  }, 120_000)

  it('noisy-run.selftest.sh passes (small-output skip + git log/diff --stat partial-keep)', () => {
    const { code, out } = run('bash', [join(ROOT, 'scripts', 'noisy-run.selftest.sh')])
    expect(out).not.toContain('[FAIL]')
    const m = out.match(/pass=(\d+) fail=(\d+)/)
    expect(m, `no "pass=N fail=N" summary in output:\n${out}`).not.toBeNull()
    expect(m![2]).toBe('0')
    expect(Number(m![1]), `case count shrank below its floor:\n${out}`).toBeGreaterThanOrEqual(6)
    expect(code).toBe(0)
  }, 120_000)
})
