// The two landers' --selftest modes, actually run (card dfff9b37).
//
// WHY THIS FILE EXISTS. Both store/cleancore-land.sh and store/marveen-land.sh have carried a
// --selftest mode for a long time, and NOTHING ran it: no vitest suite invoked either one, so the
// cases only executed when a human typed the command. A selftest nobody runs is documentation, not
// a regression guard -- the same shape as an automation whose scheduler entry is unversioned. Card
// dfff9b37 added 24 cases to that mode (via the shared store/landing-downward-check.sh), which
// would have inherited exactly the same fate.
//
// The case COUNT is asserted, not just the PASS line. A suite that only fails when the script exits
// non-zero still passes after somebody deletes half the cases -- and deletion is the failure mode
// that matters here, because these cases exist to stop a landing, and a landing that stops nothing
// looks identical to a landing with nothing to stop.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function selftest(script: string): { status: number; out: string } {
  try {
    // stderr is folded in deliberately: a sourcing failure (a missing shared lib) prints there and
    // would otherwise be invisible, leaving an empty-but-passing assertion.
    const out = execFileSync('bash', [join(REPO, 'store', script), '--selftest'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      cwd: REPO,
    })
    return { status: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

const caseCount = (out: string) => Number(/selftest: (\d+) case\(s\)/.exec(out)?.[1] ?? -1)

describe.each([
  // The floors are the counts measured when this file landed, minus nothing: they are a ratchet, so
  // adding cases is free and removing one fails here. cleancore carries 16 of its own + 26 shared;
  // marveen carries 3 of its own + 26 shared.
  ['cleancore-land.sh', 42],
  ['marveen-land.sh', 29],
])('%s --selftest', (script, floor) => {
  it('passes', () => {
    const r = selftest(script)
    expect(r.out).toContain('PASS')
    expect(r.out).not.toContain('FAIL')
    expect(r.status).toBe(0)
  })

  it(`still runs at least ${floor} cases -- deleting cases is a failure, not a cleanup`, () => {
    expect(caseCount(selftest(script).out)).toBeGreaterThanOrEqual(floor)
  })
})

describe('the shared downward-check cases run from BOTH landers, not just one', () => {
  // The point of putting them in store/landing-downward-check.sh was that the two landers cannot
  // end up testing different things about the same code. If one lander stops sourcing the lib, its
  // count drops back to its own cases and this notices -- the count floors above would not, on
  // their own, prove the SHARED block ran in each.
  it('both counts include the shared block', () => {
    const cc = caseCount(selftest('cleancore-land.sh').out)
    const mv = caseCount(selftest('marveen-land.sh').out)
    expect(cc).toBeGreaterThan(16) // 16 = cleancore-land.sh's own cases
    expect(mv).toBeGreaterThan(3) //  3 = marveen-land.sh's own cases
    expect(cc - 16).toBe(mv - 3) // the same shared block, in both
  })
})
