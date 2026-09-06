// Card 09a3d52a: redispatch-guard.sh's own selftest had never run in the suite.
//
// The repo already discovers and runs every `store/*.selftest.{sh,py}` file
// (store-selftests-all-run.test.ts, cards 711a7e57 / 2003e04b). That discovery keys on the
// FILENAME suffix, so a script that carries its selftest as a MODE instead of a separate file is
// structurally invisible to it. redispatch-guard.sh is one of those: eight written cases, covering
// the cap-before-backoff ordering (card 86dfba39) and the load-paused staleness window that a
// Cybersec NO-GO plus a QA FAIL produced (Gate-SHA fce0df4e), and not one of them had ever
// executed in a landing. Measured on this tree: of the 15 store scripts carrying a `selftest`
// mode, TEN are invoked by no test at all.
//
// This file wires THIS script, in the idiom the repo already uses for the same shape
// (scheduled-task-canary.test.ts, decisions-append-union-selftest.test.ts). The remaining nine are
// a separate card on purpose: whether they pass is unmeasured, and this repo has a documented case
// of a selftest swapping a live config file out from under the running fleet, so they have to be
// measured somewhere disposable rather than discovered into a landing gate.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(REPO_ROOT, 'store', 'redispatch-guard.sh')

function selftest(): { status: number; out: string } {
  try {
    return { status: 0, out: execFileSync('bash', [SCRIPT, 'selftest'], { encoding: 'utf-8', stdio: 'pipe' }) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

describe('redispatch-guard.sh selftest actually runs (card 09a3d52a)', () => {
  it('passes, and the VERDICT is what says so -- not a printed line', () => {
    const r = selftest()
    // Both, deliberately. A selftest that prints FAIL lines while still exiting 0 is a real
    // failure mode this fleet has hit (a case incrementing a variable nothing reads), so the exit
    // code alone is not enough evidence -- and neither is the text alone.
    expect(r.out).toContain('SELFTEST: PASS')
    expect(r.out).not.toContain('SELFTEST: FAIL')
    expect(r.status).toBe(0)
  })

  it('the concurrency case is present, so a future edit cannot quietly drop it', () => {
    // The ledger lock is the point of card 09a3d52a: without it two concurrent guard runs drop
    // each other's entries, which resets a card's re-dispatch count and defeats MAX_REDISPATCH.
    // Matched on the COMMENT-STRIPPED source, because a case named only in a comment satisfies a
    // naive presence check (cards 06d36307, 2f0c7d24).
    const src = readFileSync(SCRIPT, 'utf-8')
      .split('\n')
      .map((l) => l.replace(/#.*$/, ''))
      .join('\n')
    expect(src).toContain('_take_guard_lock')
    expect(src).toMatch(/concurrent-burst/)
  })
})
