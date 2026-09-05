// Card 1fec67e9 (backend, self-filed as an independent finding while fixing 39cc3460 round 3 -- a
// separate function, a separate mechanism, so a separate card per the surgical-changes principle).
//
// ROOT CAUSE, live-profiled with `node --prof` (a first-draft theory blaming the boundary-tracking
// slice at stripHeredocDataPayloads line ~1144 was WRONG -- V8's slice()/trim() are near O(1) on a
// string whose first and last characters are already non-whitespace, which a backtick run's slice
// always is; profiling was needed to find the REAL hot path, not the plausible-sounding one):
// scanBashWord treats a literal backtick as an OPENING character of a nested word-segment (by design
// -- see the six documented shapes below, all of which legitimately embed a backtick or `$()` inside
// a bash NAME) and does not stop at the next one; for a run of n adjacent backticks it walks all the
// way to the run's end every time it is entered. matchCmdPrefix (its only caller) gets invoked at
// roughly every other position across that same run -- an artifact of stripHeredocDataPayloads's
// boundary push/pop ping-pong on open/close backtick pairs, untouched by this fix -- so the same
// near-full-length scan repeats ~n/2 times: O(n) calls x O(n) cost each = O(n^2).
//
// FIX: SCAN_BASH_WORD_MAX_LEN bounds a single scanBashWord call's work to a constant (1024 chars),
// chosen against the six real shapes this scanner exists for (all under 30 chars) -- no legitimate
// bash function/coproc NAME approaches that length, so the cap changes the answer for zero shapes
// bash itself could execute. This file is the correctness accumulator (must run FIRST, unchanged
// behaviour on every existing shape plus the six documented NAME forms) and the perf accumulator
// (must run SECOND, confirms the O(n^2) is actually gone) -- per this fleet's regression-alongside-
// perf discipline for a file with this much prior-bug history (card 84e31b40's F-1..F-8/S1/S5/N2).
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

const CT = 'cron' + 'tab'
const bash = (command: string): boolean => Boolean(gateDecision('Bash', { command }).deny)

describe('scanBashWord backtick cap: the six documented NAME shapes must still resolve (card 1fec67e9)', () => {
  // These are the exact six shapes named in scanBashWord's own header comment as the reason the
  // function is a scanner and not a character class. Each is well under SCAN_BASH_WORD_MAX_LEN, so
  // the cap must not change any of their outcomes -- if it did, the cap is set wrong, not "close".
  it.each([
    ['f$(y $(z))', 'nested $() inside a name'],
    ['f$(echo $(echo))', 'doubly-nested $() inside a name'],
    ['f$(echo `g`)', 'backtick nested inside a $() inside a name'],
    ['f`echo $(y)`', '$() nested inside a backtick-delimited name'],
    ['f${u:-$(y)}', '$() inside a parameter expansion default, inside a name'],
    ['f$((0))', 'arithmetic expansion inside a name'],
  ])('%s (%s) still denies the dangerous body behind it', (name) => {
    expect(bash(`${name}() { ${CT} -r; }`)).toBe(true)
  })
})

describe('scanBashWord backtick cap: regression on prior rounds (card 1fec67e9)', () => {
  // Round 3's own accumulator (path-prefix-cmd-position-anchors-quadratic.test.ts) already re-runs
  // after every self-pace-gate.mjs change; these are the shapes closest in KIND to this fix --
  // backtick-adjacent -- rechecked directly here so this file stands on its own.
  it('a single, real command substitution backtick pair still denies', () => {
    expect(bash(`echo \`${CT} -r\``)).toBe(true)
  })
  it('a legitimate short backtick-containing argument is not affected', () => {
    expect(bash('echo `date`')).toBe(false)
  })
  it('plain, unrelated commands are unaffected', () => {
    expect(bash('ls -la /tmp')).toBe(false)
  })
})

describe('scanBashWord backtick cap: boundary around SCAN_BASH_WORD_MAX_LEN (card 1fec67e9)', () => {
  // A name legitimately built from many SHORT nested pairs, comfortably under the cap, must still
  // resolve exactly as before -- the cap must not fire on realistic-but-long input, only on the
  // pathological (thousands of chars) attack shape.
  it('a 40-pair backtick-delimited name (80 chars, well under the cap) still denies', () => {
    const name = 'f' + '`x`'.repeat(40)
    expect(bash(`${name}() { ${CT} -r; }`)).toBe(true)
  })
})

describe('stripHeredocDataPayloads via scanBashWord: growth stays LINEAR (card 1fec67e9, instrument replaced on card e393c67d)', () => {
  // WHY THIS BLOCK CHANGED SHAPE TWICE OVER, and the second reason is the important one.
  //
  // 1. THE INSTRUMENT. These assertions were absolute wall-clock budgets (500ms / 1500ms). A wall
  //    clock measures the MACHINE, and this fleet runs 15 agents at loadavg 8-35, so the budget
  //    went red on diffs that do not touch anything this file loads. That is the fourth documented
  //    case of the class (cards 3208a968, d19bba07, and the three landings lost on fbca2448).
  //    Wall-clock ratios are not enough either: min-of-rounds is biased against the LONGER sample,
  //    because catching one uncontended large window is less likely than catching one small one, so
  //    the ratio inflates on its own under load. CPU time excludes the descheduled interval, which
  //    is exactly the part the two samples do not share.
  //
  // 2. THE INPUT (the part that mattered more). The shape this block measured -- a bare run of
  //    backticks followed by `bash -c` -- never reaches the code the card 1fec67e9 cap guards.
  //    Instrumented: scanBashWord is entered ONCE, for 8 inner steps, at n=8000, n=32000 AND
  //    n=128000 alike. Something upstream consumes the run first. So the block passed for a reason
  //    unrelated to the fix it is named after, and a mutation proved it: with
  //    SCAN_BASH_WORD_MAX_LEN raised to Number.MAX_SAFE_INTEGER (i.e. the cap removed, the pre-fix
  //    state) this shape measured 1.00x-1.18x of the fixed cost across n=8000..128000. It could
  //    not have detected the regression at any threshold, in any instrument.
  //
  //    A run of backticks followed by a FUNCTION DEFINITION does reach it -- 2004 calls and 896676
  //    inner steps at n=4000 -- because the definition puts a NAME position after the run, which is
  //    what scanBashWord exists to resolve. Same mutation, measured on that shape:
  //
  //        cap present (fixed)   N=1000  3.32x     N=2000  4.75x
  //        cap removed (pre-fix) N=1000 13.81x     N=2000 17.20x
  //
  //    Linear is ~4x, quadratic ~16x, and MAX_RATIO sits at 8 -- the log-space midpoint, so it
  //    takes a 2x error in either direction to flip. Detection is measured here, not assumed.
  const N = 2000
  const M = 4 * N
  const ROUNDS = 3
  const MAX_RATIO = 8
  // Absolute backstop, deliberately absurd. The ratio catches a RETURN to O(n^2); it does not
  // catch something that stays linear and becomes 100x slower per character. Measured ~5-30ms
  // under load, refused at 10s: a margin no contention on this machine has ever come near, and the
  // opposite of the 525-vs-500 failure that started this.
  const ABSURD_MS = 10_000

  // CPU time, not wall clock -- see (1) above. The work is CPU-bound scanning, so this is the same
  // quantity the complexity claim is about, minus the scheduler.
  const cpuMsOnce = (command: string): number => {
    const before = process.cpuUsage()
    gateDecision('Bash', { command })
    const d = process.cpuUsage(before)
    return (d.user + d.system) / 1000
  }

  // Interleaved because a load spike between two sequential measurements would land on only one of
  // them and skew the ratio; minimum-of-rounds because the least-contended sample is the one
  // closest to the code's own cost, where a mean drags in whatever else the machine was doing.
  const growthRatio = (build: (n: number) => string): { ratio: number; small: number; large: number } => {
    let small = Infinity
    let large = Infinity
    for (let r = 0; r < ROUNDS; r++) {
      small = Math.min(small, cpuMsOnce(build(N)))
      large = Math.min(large, cpuMsOnce(build(M)))
    }
    return { ratio: large / small, small, large }
  }

  // The shape that actually enters scanBashWord repeatedly. This is the assertion that pins the cap.
  const guardedShape = (n: number): string => '`'.repeat(n) + `() { ${CT} -r; }`

  it('a backtick run before a NAME position grows linearly, not quadratically', () => {
    const { ratio, small, large } = growthRatio(guardedShape)
    // The numbers go in the message, so a failure says whether it is a complexity regression or
    // just a slow machine -- the question the old absolute budget could never answer.
    expect(
      ratio,
      `n=${N} took ${small.toFixed(1)}ms CPU, n=${M} took ${large.toFixed(1)}ms CPU -> ${ratio.toFixed(2)}x. ` +
        `Linear is ~4x, quadratic ~16x; over ${MAX_RATIO}x means the per-call scan is unbounded again.`,
    ).toBeLessThan(MAX_RATIO)
  })

  it('and stays far under an absurd absolute ceiling (catches linear-but-100x-slower)', () => {
    expect(cpuMsOnce(guardedShape(M))).toBeLessThan(ABSURD_MS)
  })

  // The ORIGINAL shapes are kept -- they are still legitimate input that must not blow up, and
  // dropping them would shrink coverage (a previously-green assertion disappearing is its own
  // failure, regardless of how the replacement looks). They are backstops only: as measured above,
  // they cannot detect a regression in the cap, so they get the absurd ceiling rather than a ratio
  // that would imply a guarantee they do not provide.
  it.each([16000, 32000, 64000, 128000])(
    'n=%i adjacent backticks before `bash -c` stays far under the absurd ceiling',
    (n) => {
      const text = '`'.repeat(n) + `bash -c "${CT} -r"`
      expect(cpuMsOnce(text)).toBeLessThan(ABSURD_MS)
    },
  )
})
