// Card ee830675: the watchdog launch-env isolation contract suite RUNS in a gate, instead of
// existing. Measured: scripts/__tests__/watchdog-config-isolation.test.sh was not referenced by
// fleet-test.sh or any src/__tests__ file, so its 26/75 red (see the dist/-build fix in that
// script) went unnoticed. Same wrapper shape as gpu-crashloop-guard-suite-runs.test.ts (card
// d5c05548) -- deliberately narrow, this wires only this one suite.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SUITE = join(REPO_ROOT, 'scripts', '__tests__', 'watchdog-config-isolation.test.sh')

describe('the watchdog-config-isolation contract suite actually runs (card ee830675)', () => {
  it('the suite file exists where this wrapper expects it', () => {
    // Without this, a rename turns the wrapper into a silent no-op -- the failure it exists for.
    expect(existsSync(SUITE)).toBe(true)
  })

  it('every case passes, and there is a NON-ZERO number of them', { timeout: 120_000 }, () => {
    let out: string
    try {
      out = execFileSync('bash', [SUITE], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: 110_000,
      })
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string }
      throw new Error(`watchdog-config-isolation.test.sh FAILED:\n${e.stdout ?? ''}${e.stderr ?? ''}`)
    }
    // The count matters as much as the verdict: a suite whose loop never entered prints a
    // perfectly happy "0 passed, 0 failed". Require a non-zero pass count, not just FAIL===0.
    const m = /watchdog-config-isolation: ([1-9]\d*) passed, (\d+) failed/.exec(out)
    expect(m, `no non-zero results line in:\n${out}`).not.toBeNull()
    expect(m![2]).toBe('0')
  })
})
