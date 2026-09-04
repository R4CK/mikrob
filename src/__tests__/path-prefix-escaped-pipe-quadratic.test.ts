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
  // MEASURED AS A RATIO, NOT AS A WALL-CLOCK BUDGET (card 3208a968).
  //
  // These five checks used to assert an absolute millisecond budget, and that budget failed under
  // machine load while the code was perfectly fine. The history is in this file: the threshold had
  // already been raised once, 200ms -> 500ms, for exactly that reason. On 2026-09-04 it failed
  // again at 525ms and REFUSED a landing whose diff was a Python hook and some string constants --
  // nothing this file even loads. Isolated, the same suite passed 11/11 immediately after.
  //
  // Raising the number a third time would buy another few weeks. The real problem is the metric: a
  // wall clock measures the MACHINE, and this fleet runs 15 agents whose loadavg swings between 8
  // and 35. What the card 39cc3460 fix actually claims is a COMPLEXITY property -- that these four
  // constructs stopped being O(n^2) -- and complexity is a ratio, which cancels the machine out.
  //
  // So: measure the same construct at n and 4n. Linear costs ~4x, quadratic ~16x. The threshold
  // sits at 8, the midpoint in log space, so it takes a 2x error in either direction to flip --
  // and load scales BOTH measurements together, which is precisely why the ratio survives it.
  //
  // Measured on this machine at loadavg 19.6, the shape the old budget could not tolerate:
  //     n=  5000   9.55ms      n= 20000  35.62ms
  //     n= 10000  19.31ms      n= 40000  70.71ms
  //     n= 80000 148.57ms   -> 4x input, 4.17x time. Quadratic would be 16x.
  const N = 10000
  const M = 4 * N
  const ROUNDS = 3
  // Quadratic = 16x, linear = 4x. 8 is the log-space midpoint of the two.
  const MAX_RATIO = 8
  // A second, deliberately absurd absolute backstop. The ratio catches a return to O(n^2); it does
  // NOT catch something that stays linear but becomes 100x slower per character. This does, and it
  // cannot flake: measured ~19ms, refused at 10s, a 500x margin. That is the same reasoning that
  // makes the DECISIONS.md size case safe, and the opposite of the 525-vs-500 margin that failed.
  const ABSURD_MS = 10_000

  const timeOnce = (command: string): number => {
    const t0 = process.hrtime.bigint()
    gateDecision('Bash', { command })
    return Number(process.hrtime.bigint() - t0) / 1e6
  }

  /**
   * Interleaved, minimum-of-rounds. Interleaved because a load spike between two sequential
   * measurements would otherwise land on only one of them and skew the ratio; minimum because the
   * least-contended sample is the one closest to the code's own cost, where a mean drags in
   * whatever else the machine was doing.
   */
  const growthRatio = (build: (n: number) => string): { ratio: number; small: number; large: number } => {
    let small = Infinity
    let large = Infinity
    for (let r = 0; r < ROUNDS; r++) {
      small = Math.min(small, timeOnce(build(N)))
      large = Math.min(large, timeOnce(build(M)))
    }
    return { ratio: large / small, small, large }
  }

  const CONSTRUCTS: Array<[string, (n: number) => string]> = [
    ['STDIN_SHELL_RX pipe branch', (n) => `x | ${pipePairRun(n)}bash`],
    ['SHELL_C_RX', (n) => `${pipePairRun(n)}bash -c "id"`],
    ['HERESTRING_RX', (n) => `${pipePairRun(n)}bash <<< "id"`],
    ['PROC_SUB_SHELL', (n) => `${pipePairRun(n)}bash <(echo id)`],
  ]

  it.each(CONSTRUCTS)('%s grows LINEARLY with input, not quadratically', (_name, build) => {
    const { ratio, small, large } = growthRatio(build)
    // The numbers go in the message, so a failure says whether it is a complexity regression or
    // just a slow machine -- the question the old absolute budget could never answer.
    expect(
      ratio,
      `n=${N} took ${small.toFixed(1)}ms, n=${M} took ${large.toFixed(1)}ms -> ${ratio.toFixed(2)}x. ` +
        `Linear is ~4x, quadratic ~16x; over ${MAX_RATIO}x means the O(n^2) backtracking is back.`,
    ).toBeLessThan(MAX_RATIO)
    expect(
      small,
      `n=${N} took ${small.toFixed(1)}ms, which is absurd for this input even on a loaded machine ` +
        `(measured ~19ms). The growth may still be linear, so the ratio above cannot see this.`,
    ).toBeLessThan(ABSURD_MS)
  })

  it('stays fast at n=100000 pairs, near the practical ceiling this class of input reaches', () => {
    // Kept as a size check rather than a speed check: the point is that the practical ceiling is
    // reachable at all. Budget is the absurd one, for the same reason as above -- measured ~185ms.
    const t0 = Date.now()
    gateDecision('Bash', { command: `${pipePairRun(100000)}bash -c "id"` })
    expect(Date.now() - t0).toBeLessThan(ABSURD_MS)
  })
})
