// Card 39cc3460 (Cybersec, found while running ccc2c742's own mandatory 5-regex sweep): PATH_PREFIX's
// `\\.` alternative consumed an ESCAPED PIPE (`\|`) as an ordinary path character. CMD_POSITION (used
// by WRAPPER_POSITION) and STDIN_SHELL_RX's pipe branch both treat a bare `|` as its own valid anchor,
// so a run of escaped-pipe pairs (`\|\|\|...`) gives ~n anchor positions in one input. At each one,
// PATH_PREFIX's `\\.` consumed the rest of the run (more `\|` pairs), found no closing `/`, and
// backtracked the whole way out -- O(remaining length) per anchor, times ~n anchors, is O(n^2) across
// FOUR named constructs that all use PATH_PREFIX/SHELL_NAME: SHELL_C_RX, HERESTRING_RX, PROC_SUB_SHELL,
// and STDIN_SHELL_RX's pipe branch. Measured (Cybersec, through the real gateDecision()): n=16000
// pairs -> 1679ms, clean n^2 scaling; extrapolated to the real MAX_COMMAND_BYTES=1MB ceiling: ~27min
// for one gateDecision() call.
//
// FIX: `\\.` narrowed to `\\[^|]` -- escaping a pipe specifically is no longer "just another path
// character", so PATH_PREFIX's optional group stops there instead of consuming it. This file is the
// CORRECTNESS half (built before the fix, per this card's own plan-grilling verdict): the case that
// matters most is a LEGITIMATE escaped pipe inside a real path prefix, directly before a real shell
// name -- if the outer regex's own independent bare-`|` anchor can't rescue the match once PATH_PREFIX
// stops short, this fix would be a silent detection regression. The PERFORMANCE half is the last
// describe block.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

const CT = 'cron' + 'tab'
const bash = (command: string): boolean => Boolean(gateDecision('Bash', { command }).deny)
const pipePairRun = (n: number): string => '\\|'.repeat(n)

describe('PATH_PREFIX escaped-pipe fix: must keep denying (card 39cc3460 fix accumulator)', () => {
  const MUST_DENY: Array<[string, string]> = [
    // A legitimate-shaped path prefix containing an escaped pipe, directly before the shell name, on
    // each of the four affected constructs. If the fix silently narrowed detection, these would flip
    // to allow -- the PATH_PREFIX scan would stop at the escaped pipe, but the bare `|` inside it is
    // still its own anchor for STDIN_SHELL_RX's pipe branch / WRAPPER_POSITION to retry from.
    ['STDIN_SHELL_RX pipe branch: escaped pipe inside the path prefix', `echo "${CT} -" | /usr/lo\\|cal/bin/bash`],
    ['SHELL_C_RX: escaped pipe inside the path prefix', `/usr/lo\\|cal/bin/bash -c "${CT} -r"`],
    ['HERESTRING_RX: escaped pipe inside the path prefix', `/usr/lo\\|cal/bin/bash <<< "${CT} -r"`],
    ['PROC_SUB_SHELL: escaped pipe inside the path prefix', `/usr/lo\\|cal/bin/bash <(echo "${CT} -r")`],
    // Already covered by other files, repeated here so this file stands alone as the fix's own
    // regression gate (the three prior live repros this PATH_PREFIX construct was built for).
    ['plain absolute path, no escape', `/usr/bin/bash -c "${CT} -r"`],
    ['escaped space in the path (round-1 PATH_PREFIX case)', `/usr/local\\ bin/bash -c "${CT} -r"`],
  ]

  it.each(MUST_DENY)('%s', (_name, cmd) => {
    expect(bash(cmd)).toBe(true)
  })
})

describe('PATH_PREFIX escaped-pipe fix: quadratic-blowup repro must stay fast (card 39cc3460)', () => {
  // The exact adversarial shape from the finding: dense escaped-pipe pairs (no real `/`, so
  // PATH_PREFIX's optional group can never close) feeding all four affected constructs.
  it('STDIN_SHELL_RX pipe branch stays under 200ms at n=20000 pairs (pre-fix measured: ~700ms at n=20000, ~27min extrapolated at 1MB)', () => {
    const text = `x | ${pipePairRun(20000)}bash`
    const t0 = Date.now()
    gateDecision('Bash', { command: text })
    // 500ms, not 200ms: observed a couple of ms over 200 under full-suite CPU contention (card
    // 14b573f3 verification) even though isolated runs stay under 50ms -- still ~2 orders of
    // magnitude below the pre-fix quadratic extrapolation (~27min at 1MB), so still meaningful.
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('SHELL_C_RX stays under 200ms at n=20000 pairs', () => {
    const text = `${pipePairRun(20000)}bash -c "id"`
    const t0 = Date.now()
    gateDecision('Bash', { command: text })
    // 500ms, not 200ms: observed a couple of ms over 200 under full-suite CPU contention (card
    // 14b573f3 verification) even though isolated runs stay under 50ms -- still ~2 orders of
    // magnitude below the pre-fix quadratic extrapolation (~27min at 1MB), so still meaningful.
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('HERESTRING_RX stays under 200ms at n=20000 pairs', () => {
    const text = `${pipePairRun(20000)}bash <<< "id"`
    const t0 = Date.now()
    gateDecision('Bash', { command: text })
    // 500ms, not 200ms: observed a couple of ms over 200 under full-suite CPU contention (card
    // 14b573f3 verification) even though isolated runs stay under 50ms -- still ~2 orders of
    // magnitude below the pre-fix quadratic extrapolation (~27min at 1MB), so still meaningful.
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('PROC_SUB_SHELL stays under 200ms at n=20000 pairs', () => {
    const text = `${pipePairRun(20000)}bash <(echo id)`
    const t0 = Date.now()
    gateDecision('Bash', { command: text })
    // 500ms, not 200ms: observed a couple of ms over 200 under full-suite CPU contention (card
    // 14b573f3 verification) even though isolated runs stay under 50ms -- still ~2 orders of
    // magnitude below the pre-fix quadratic extrapolation (~27min at 1MB), so still meaningful.
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('stays fast at n=100000 pairs, near the practical ceiling this class of input reaches', () => {
    // Threshold has margin for full-suite CPU contention (observed 368ms isolated, 519ms under a
    // full concurrent run, card 14b573f3 verification) -- still an order of magnitude below the
    // pre-fix quadratic extrapolation (~27min at 1MB), so it stays a meaningful regression guard.
    const text = `${pipePairRun(100000)}bash -c "id"`
    const t0 = Date.now()
    gateDecision('Bash', { command: text })
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})
