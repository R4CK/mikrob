// Card ccc2c742: STDIN_SHELL_RX's xargs branch --
// `\bxargs\b[^|]*?${PATH_PREFIX}(?:bash|sh|zsh|dash|ksh)\b` -- runs in O(n^2) on a long run of
// characters PATH_PREFIX can never close (no `/`), because the unbounded lazy filler `[^|]*?`
// sits directly in front of PATH_PREFIX's own optional, backtracking group: at each of the ~n
// positions the filler tries, PATH_PREFIX does an O(n) failed scan looking for a `/` that never
// comes. Measured (backend, 2026-08-24): n=100000 bytes -> 9051ms, clean quadratic growth (~4x
// time per 2x n). Extrapolated to the real MAX_COMMAND_BYTES=1MB ceiling: ~995s for one
// gateDecision() call -- within the size gate, so not excluded by it.
//
// PLAN-GRILLING VERDICT (posted on ccc2c742 before this file was written): a length-capped filler
// was REJECTED -- it would let an attacker pad past the cap with legitimate-looking xargs flags
// and silently defeat detection (fail-open, worse than the current slow-but-correct match). A
// naive fully-greedy/atomic filler was also REJECTED -- it would consume past a shell name that
// isn't at the very end of the filler run, which is a correctness (false-negative) regression, not
// just a performance one. This file is the CORRECTNESS half of that verdict's required accumulator
// (built before any regex change), covering shapes the fix must keep denying: shell name away from
// the end of the filler, a path-prefixed shell name, multiple candidate shell names, and a long but
// legitimate-looking filler that a length cap would have silently let through. The PERFORMANCE half
// lives in the last describe block.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

const CT = 'cron' + 'tab'
const bash = (command: string): boolean => Boolean(gateDecision('Bash', { command }).deny)
const backslashRun = (n: number): string => '\\'.repeat(n)

describe('STDIN_SHELL_RX xargs branch: must keep denying (card ccc2c742 fix accumulator)', () => {
  const MUST_DENY: Array<[string, string]> = [
    // Already covered by self-pace-english-word-binaries.test.ts / self-pace-wrapper-and-keyword-
    // positions.test.ts, repeated here so this file stands alone as the fix's own regression gate.
    ['bare shell after xargs (reported shape)', `echo "${CT} -" | xargs bash`],
    ['xargs -0 into bash -c (reported)', `echo "${CT} -" | xargs -0 bash -c`],
    ['xargs -I{} into bash -c', `echo "${CT} -" | xargs -I{} bash -c "id"`],
    // Shell name is NOT at the end of the filler run -- guards against a fully-greedy/atomic
    // filler that would consume past it and leave nothing for PATH_PREFIX+shell-name to match.
    ['shell name mid-command, trailing flags after it', `echo "${CT} -" | xargs -0 bash -c "id" --verbose`],
    [
      'shell name mid-command, trailing plain args after it',
      `echo "${CT} -" | xargs bash -c "id" extra tokens here`,
    ],
    // Path-prefixed shell name -- exercises PATH_PREFIX actually closing on a real `/`, not just
    // failing to find one.
    ['path-prefixed shell name', `echo "${CT} -" | xargs /usr/bin/bash -c "id"`],
    ['path-prefixed shell name with escaped space', `echo "${CT} -" | xargs /usr/local\\ bin/bash -c "id"`],
    // Multiple candidate shell-name occurrences -- the fix must not stop scanning after the first
    // non-matching one.
    ['shell name appears twice, first is a decoy substring', `echo "${CT} -" | xargs echo bashful bash -c "id"`],
    // A long but ordinary-looking filler (repeated valid-shaped flag/value pairs) that must still
    // reach the shell name -- this is the case a length-capped filler (rejected direction) would
    // have silently let through once the cap was exceeded.
    [
      'long legitimate-looking filler before the shell name',
      `echo "${CT} -" | xargs ${'-a file.txt '.repeat(40)}bash -c "id"`,
    ],
  ]

  it.each(MUST_DENY)('%s', (_name, cmd) => {
    expect(bash(cmd)).toBe(true)
  })
})

describe('STDIN_SHELL_RX xargs branch: quadratic-blowup repro must stay fast (card ccc2c742)', () => {
  // The exact adversarial shape from the finding: `xargs` + a long backslash run (no `/`, so
  // PATH_PREFIX's optional group can never close) + a shell name. Whatever the outcome (denied or
  // not), it must not take anywhere near the measured pre-fix cost (9051ms at n=100000).
  it('stays under 200ms at n=100000 backslashes (pre-fix measured: 9051ms)', () => {
    const text = `xargs -0 ${backslashRun(100000)}bash`
    const t0 = Date.now()
    gateDecision('Bash', { command: text })
    const ms = Date.now() - t0
    expect(ms).toBeLessThan(200)
  })

  it('stays under 500ms at n=500000 backslashes (below the 1MB size gate)', () => {
    const text = `xargs -0 ${backslashRun(500000)}bash`
    const t0 = Date.now()
    gateDecision('Bash', { command: text })
    const ms = Date.now() - t0
    expect(ms).toBeLessThan(500)
  })
})
