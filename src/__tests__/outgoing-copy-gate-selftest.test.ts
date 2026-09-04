// scripts/hooks/outgoing-copy-gate.selftest.py ships 28 real subprocess cases against the outgoing
// send gate -- and until now NOTHING ran it (card 630d9864, B-wave). Same shape and same reason as
// activity-hook-redaction.test.ts and decisions-append-union-selftest.test.ts: a selftest that only
// runs when someone remembers to type its name is not a control, it is a document about one.
//
// This matters more here than for most hooks. The gate is fail-closed on the email/Bash send paths
// and fail-OPEN on the Telegram one, and those two directions are easy to swap by accident while
// editing. The B-wave adopted upstream's fail-closed __main__ net into this file precisely because
// a malformed payload used to exit 1, which PreToolUse reads as NON-blocking -- an unchecked send.
// The selftest pins both directions; this file makes it actually run.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'

const SELFTEST = join(STORE_DIR, '..', 'scripts', 'hooks', 'outgoing-copy-gate.selftest.py')

function runSelftest(): { code: number; out: string } {
  try {
    const out = execFileSync('python3', [SELFTEST], { encoding: 'utf-8', stdio: 'pipe' })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

describe('the outgoing-copy-gate selftest actually runs (card 630d9864)', () => {
  const result = runSelftest()

  it('the selftest exists and every case passes', () => {
    expect(existsSync(SELFTEST)).toBe(true)
    expect(result.out, result.out.slice(-2000)).toContain('All cases passed.')
    expect(result.code).toBe(0)
  })

  it('it ran a non-trivial number of cases -- never vacuously green', () => {
    // A harness whose case list silently shrank would still print "All cases passed." The floor is
    // the count at adoption time minus a little slack for a deliberate consolidation.
    const passed = (result.out.match(/^OK {2}/gm) ?? []).length
    expect(passed).toBeGreaterThanOrEqual(25)
  })

  it('both failure DIRECTIONS are pinned, not just the blocking one', () => {
    // The gate is fail-closed on email/Bash and fail-open on Telegram. A suite that only asserted
    // blocking would stay green if someone made the Telegram path fail-closed too -- which would
    // silence the owner's only supervision channel on any internal error.
    const source = readFileSync(SELFTEST, 'utf-8')
    expect(source).toContain('FAIL-CLOSED NET')
    expect(source).toContain('FAIL-OPEN PRESERVED')
  })
})
