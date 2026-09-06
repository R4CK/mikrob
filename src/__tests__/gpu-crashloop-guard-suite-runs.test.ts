// Card d5c05548: the guard's own contract suite RUNS in a gate, instead of existing.
//
// WHY THIS IS PART OF THE MASK FIX AND NOT A SIDE QUEST. The defect on this card is that
// gpu-crashloop-guard.sh reported a mask it had never achieved, for weeks, on a live host. The
// reason nobody noticed is not that the tests were weak -- it is that scripts/__tests__/*.test.sh
// is run by NOTHING. Measured on this checkout: no reference to that directory in fleet-test.sh,
// in package.json, or in any vitest file; the only two mentions of gpu-crashloop-guard.test.sh in
// the whole repo are the guard's own header comment and the test file itself.
//
// So the suite was a written control that never executed -- the same
// wired-detection-with-no-consumer shape that store-selftests-all-run.test.ts (cards 711a7e57,
// 2003e04b) exists to close for store/*.selftest.*, and the same one upstream measured on their
// side in #1200 ("25 of our 29 script suites had never run, and two of them were red").
//
// DELIBERATELY NARROW: this wires THIS suite, the one this card is about. Wiring all of
// scripts/__tests__ at once is its own card, because upstream's number says some of them will be
// red and a fleet-wide landing block is exactly what this fork spent today clearing.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SUITE = join(REPO_ROOT, 'scripts', '__tests__', 'gpu-crashloop-guard.test.sh')

describe('the gpu-crashloop-guard contract suite actually runs (card d5c05548)', () => {
  it('the suite file exists where this wrapper expects it', () => {
    // Without this, a rename turns the wrapper into a silent no-op -- the failure it exists for.
    expect(existsSync(SUITE)).toBe(true)
  })

  it('every case passes, and there is a NON-ZERO number of them', () => {
    let out: string
    try {
      out = execFileSync('bash', [SUITE], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: 180_000,
      })
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string }
      throw new Error(`gpu-crashloop-guard.test.sh FAILED:\n${e.stdout ?? ''}${e.stderr ?? ''}`)
    }
    // The count matters as much as the verdict: a suite whose loop never entered, or whose cases
    // all got skipped, prints a perfectly happy summary over nothing. Same reason the sibling
    // wrapper for store/*.selftest.* insists on [1-9]\d* rather than just "PASS".
    const m = /Results: ([1-9]\d*)\/([1-9]\d*) passed/.exec(out)
    expect(m, `no non-zero results line in:\n${out}`).not.toBeNull()
    expect(m![1]).toBe(m![2])
    expect(out).toContain('All tests passed.')
  })
})
