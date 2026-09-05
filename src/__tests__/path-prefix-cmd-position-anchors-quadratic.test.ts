// Card 39cc3460 round 3 (Cybersec NO-GO on Gate-SHA e724ae21): round 2's fix (see
// path-prefix-escaped-pipe-quadratic.test.ts) narrowed PATH_PREFIX's escape-tolerant alternative to
// exclude only `|`, because that was the one anchor the round's own repro used. But CMD_POSITION's
// character class recognises SEVEN OTHER characters as equally valid command-position anchors --
// `;` `&` `(` `)` `{` `!` a backtick -- and every one of them gave the identical O(n^2): a dense run
// of the escaped pair (`\;\;\;...` etc.) yields ~n anchor positions, and PATH_PREFIX's old
// alternative still consumed the whole run at each one looking for `/`. Cybersec measured all seven
// live through gateDecision() on Gate-SHA e724ae21: n=32000 pairs (64 KB) took up to 13.3s -- past
// the hook's own 10s timeout, which the file's own header documents as fail-open.
//
// FIX: both of PATH_PREFIX's alternatives now derive their exclusion set from CMD_POSITION_CHARS
// (the same list CMD_POSITION itself is built from, self-pace-gate.mjs), so a future CMD_POSITION
// addition is inherited here by construction. This file is round 3's own accumulator, covering ALL
// SEVEN anchor characters the round-2 fix left open, on all four affected constructs, exactly the
// verification Cybersec's NO-GO required ("mind a HET ... anchor-karakter ... KULON esetkent").
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

const CT = 'cron' + 'tab'
const bash = (command: string): boolean => Boolean(gateDecision('Bash', { command }).deny)

// The seven anchors CMD_POSITION recognises besides `|` (already covered in the sibling file).
const ANCHORS = [';', '&', '(', ')', '{', '!', '`']
const pairRun = (a: string, n: number): string => ('\\' + a).repeat(n)

describe('PATH_PREFIX CMD_POSITION-anchor fix: must keep denying (card 39cc3460 round 3)', () => {
  // SHELL_C_RX / HERESTRING_RX / PROC_SUB_SHELL all anchor via WRAPPER_POSITION, which is built
  // from the SAME CMD_POSITION character class PATH_PREFIX now stops at -- so when PATH_PREFIX
  // refuses to consume an escaped anchor, the surrounding (non-global, unanchored) regex simply
  // retries the whole match starting at that anchor's own position instead, at O(1) cost, and picks
  // the shell name up right after it. This is structural, not incidental: verified below for all
  // seven anchors on all three of these constructs.
  describe.each(ANCHORS)('anchor %s: escaped, inside a real path prefix, directly before the shell name', (a) => {
    const path = `/usr/lo\\${a}cal/bin/bash`
    it('SHELL_C_RX', () => {
      expect(bash(`${path} -c "${CT} -r"`)).toBe(true)
    })
    it('HERESTRING_RX', () => {
      expect(bash(`${path} <<< "${CT} -r"`)).toBe(true)
    })
    it('PROC_SUB_SHELL', () => {
      expect(bash(`${path} <(echo "${CT} -r")`)).toBe(true)
    })
  })

  // Regression check: prior rounds' plain and escaped-pipe cases still correct after the shared
  // CMD_POSITION_CHARS refactor of both PATH_PREFIX and CMD_POSITION.
  it('plain absolute path, no escape, still denied', () => {
    expect(bash(`/usr/bin/bash -c "${CT} -r"`)).toBe(true)
  })
  it('escaped pipe inside the path prefix (round 2) still denied, SHELL_C_RX', () => {
    expect(bash(`/usr/lo\\|cal/bin/bash -c "${CT} -r"`)).toBe(true)
  })
  it('escaped pipe inside the path prefix (round 2) still denied, STDIN_SHELL_RX pipe branch', () => {
    expect(bash(`echo "${CT} -" | /usr/lo\\|cal/bin/bash`)).toBe(true)
  })
})

// FORMERLY a known, documented residual (round 3's own text below is kept for history) -- CLOSED
// by card 1a609c01, the follow-up round-3 explicitly asked for ("kulon kartyat erdemel").
//
// STDIN_SHELL_RX's pipe branch was the ONE construct that did not retry via WRAPPER_POSITION -- its
// own anchor was a literal `\|`, not the broader CMD_POSITION class. Round 2's fix "worked" for pipe
// specifically only because escaping a pipe leaves a SECOND literal `|` character in the string,
// which happens to BE this construct's own anchor -- a coincidence of the character overlapping its
// own operator, not a general retry mechanism. None of the other six anchors leave behind a literal
// `|`, so once PATH_PREFIX refuses to consume them (required for the DoS fix -- see the file header
// comment in self-pace-gate.mjs), there was no second anchor left for this specific branch to retry
// from, and detection genuinely failed for this one combination: an escaped `;`/`&`/`(`/`)`/`{`/`!`/
// backtick, inside a path, directly before a bare (`-c`-less) shell name, piped into from stdin.
// Cybersec measured all seven live (7/7 bypass with a real dangerous piped payload).
//
// Round 3 judged widening this construct's anchor to full WRAPPER_POSITION not worth it THERE,
// citing "new false-positive surface, needs its own threat-model pass" -- exactly what card
// 1a609c01 is. THE ACTUAL FIX taken (self-pace-gate.mjs) does NOT widen the pipe branch's own
// anchor in place (which would have dropped the "must be piped" requirement entirely, exactly
// round 3's concern) -- it adds a SEPARATE, independent second check: a bare `|` exists SOMEWHERE
// (HAS_PIPE_RX) AND (an entirely separate scan, no shared backtracking state) a bare shell name
// exists in ANY WRAPPER_POSITION-recognised command position. Broader than the exact reported
// shape (pipe and shell name need not be adjacent) but safe: the DENY decision still depends on a
// quoted literal separately matching a recognised dangerous pattern, so this only widens WHEN
// literal-extraction is attempted, never widens what counts as dangerous once extracted -- checked
// below with realistic benign pipe+shell-name commands that must stay allowed.
describe('STDIN_SHELL_RX pipe branch: non-pipe escaped anchors now caught (card 1a609c01)', () => {
  it.each(ANCHORS)('escaped %s inside the path prefix is now caught via the independent WRAPPER_POSITION check', (a) => {
    const cmd = `echo "${CT} -" | /usr/lo\\${a}cal/bin/bash`
    expect(bash(cmd)).toBe(true)
  })
})

describe('STDIN_SHELL_RX pipe branch: the broader trigger must not create new false DENYs (card 1a609c01)', () => {
  // Realistic commands containing BOTH a pipe AND a bare shell-name-like word, with nothing
  // dangerous in any quoted literal -- the independent check's own safety argument, verified.
  it.each([
    'cat file.txt | grep bash',
    'ps aux | grep bash',
    'history | grep "ssh\\|bash"',
    'echo "this is about bash scripting" | wc -l',
    'ls -la | grep -i sh',
    'git log --oneline | grep ksh',
    'find . -name "*.sh" | xargs cat',
    'echo "deploy script uses zsh for aliasing" | tee /tmp/out.txt',
  ])('%s stays allowed', (cmd) => {
    expect(bash(cmd)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// PERFORMANCE: measured as a CPU-time GROWTH RATIO, not an absolute wall-clock budget (card
// e393c67d, replacing the eight Date.now() budgets this block used to carry).
//
// WHY. A wall clock measures the MACHINE. This fleet runs 15 agents at loadavg 8-35, so these
// budgets went red on diffs that touch nothing this file loads -- the fourth documented case of the
// class (cards 3208a968, d19bba07, plus three landings lost on fbca2448). Raising the numbers buys
// weeks; changing the instrument is what actually fixes it. What card 39cc3460 claims is a
// COMPLEXITY property -- that these constructs stopped being O(n^2) -- and complexity is a ratio,
// which cancels the machine out. A WALL-clock ratio is still not enough: min-of-rounds is biased
// against the longer sample (catching one uncontended 120ms window is less likely than catching one
// uncontended 30ms window), so the ratio inflates on its own under load. CPU time excludes the
// descheduled interval, which is exactly the part the two samples do not share.
//
// DETECTION MEASURED, NOT ASSUMED. PATH_PREFIX was reverted to its pre-fix shape
// (`\\.` for the escaped-character alternative, and the negated class without CMD_POSITION_CHARS)
// and the same ratio re-measured at N=4000, loadavg ~20:
//
//     anchor   fixed    pre-fix          anchor   fixed    pre-fix
//       |      2.04x    14.89x             )      4.07x    15.73x
//       &      4.47x    18.53x             <      5.26x     4.69x
//       ;      2.76x    14.25x             >      4.36x     3.26x
//       (      4.65x    17.64x
//
// Five of the seven anchors separate cleanly across MAX_RATIO=8. `<` and `>` do not move, and that
// is correct rather than a gap: they are not in CMD_POSITION_CHARS, so they are held by the negated
// class's own `<>` exclusion, which the mutation above deliberately leaves in place. Their
// assertions here are backstops against a general blowup, not proof of this particular fix.
//
// WHY N=8000 AND NOT MORE. A ratio costs more than a single timed call -- ROUNDS samples at N plus
// ROUNDS at 4N, per assertion. At N=16000 this file went from 1357ms to 4682ms, and it runs inside
// a 612-file suite whose CPU contention is the very thing that makes these tests flake: paying 3.4x
// here would feed the problem this card exists to fix. Re-measured at N=8000 with the same mutation
// (loadavg ~23):
//
//     anchor    fixed   pre-fix          anchor    fixed   pre-fix
//       |       4.99x   15.73x             )       3.99x   16.89x
//       &       5.21x   14.84x             <       3.96x    4.46x
//       ;       4.28x   15.64x             >       5.06x    4.73x
//       (       3.91x   16.16x
//
// Same separation, same five anchors, at half the cost. The smallest sample is 2.6ms CPU, which is
// thousands of microseconds of process.cpuUsage() resolution -- not near the noise floor.
//
// THE REMAINING COST IS DELIBERATE, not overlooked: this file lands at ~3.0s against the old 1.36s,
// still 2.2x. A ratio inherently costs more than one timed call (ROUNDS samples at N plus ROUNDS at
// 4N, per assertion), and ROUNDS stays at 3 because dropping to 2 pushed the worst observed ratio
// from 5.4x to 6.4x -- thinner margin under MAX_RATIO=8 than the noise rejection is worth. The
// trade is priced against what it prevents: one false red costs a whole fleet-test run (130-170s)
// and, on card fbca2448, cost three landings in a row. 1.7s per suite run against that is cheap.
const N = 8000
const M = 4 * N
const ROUNDS = 3
// Quadratic = 16x, linear = 4x. 8 is the log-space midpoint, so it takes a 2x error in either
// direction to flip, and load scales BOTH measurements together.
const MAX_RATIO = 8
// A deliberately absurd absolute ceiling. The ratio catches a RETURN to O(n^2); it does not catch
// something that stays linear but becomes 100x slower per character. Measured 5-34ms per call under
// load, refused at 10s -- a margin nothing on this machine has approached, and the opposite of the
// 525-vs-500 margin that started this.
const ABSURD_MS = 10_000

const cpuMsOnce = (command: string): number => {
  const before = process.cpuUsage()
  gateDecision('Bash', { command })
  const d = process.cpuUsage(before)
  return (d.user + d.system) / 1000
}

/**
 * Interleaved, minimum-of-rounds. Interleaved because a load spike between two sequential
 * measurements would land on only one of them and skew the ratio; minimum because the least
 * contended sample is the one closest to the code's own cost.
 */
const growthRatio = (build: (n: number) => string): { ratio: number; small: number; large: number } => {
  let small = Infinity
  let large = Infinity
  for (let r = 0; r < ROUNDS; r++) {
    small = Math.min(small, cpuMsOnce(build(N)))
    large = Math.min(large, cpuMsOnce(build(M)))
  }
  return { ratio: large / small, small, large }
}

const expectLinear = (name: string, build: (n: number) => string): void => {
  const { ratio, small, large } = growthRatio(build)
  // The numbers go in the message, so a failure says whether it is a complexity regression or just
  // a slow machine -- the question the old absolute budget could never answer.
  expect(
    ratio,
    `${name}: n=${N} took ${small.toFixed(1)}ms CPU, n=${M} took ${large.toFixed(1)}ms CPU -> ` +
      `${ratio.toFixed(2)}x. Linear is ~4x, quadratic ~16x; over ${MAX_RATIO}x means the O(n^2) ` +
      `backtracking is back.`,
  ).toBeLessThan(MAX_RATIO)
  expect(large, `${name}: ${large.toFixed(1)}ms CPU for one call is absurd regardless of shape`).toBeLessThan(ABSURD_MS)
}

describe('PATH_PREFIX CMD_POSITION-anchor fix: growth stays LINEAR (card 39cc3460 round 3)', () => {
  // Pre-fix measured (Cybersec, Gate-SHA e724ae21, through the real gateDecision()): n=32000 pairs
  // (64 KB) took up to 13.3s on these characters -- already past the hook's own 10s timeout.
  it.each(ANCHORS)('escaped %s pair-run grows linearly', (a) => {
    expectLinear(`escaped ${a} pair-run`, (n) => `${pairRun(a, n)}bash -c "id"`)
  })

  // The ratio is measured at N/4N (16k/64k). This keeps the ORIGINAL n=100000 input size in the
  // suite: the ratio proves the SHAPE of the growth, but only an actual run at the ceiling proves
  // the ceiling is reachable at all. Dropping it because the ratio "covers" it would shrink the
  // exercised input range -- a previously-green assertion disappearing is its own failure, however
  // good the replacement looks. Absolute, not a ratio, and deliberately absurd: isolated it
  // measures 37-215ms per anchor.
  it('all seven anchors stay far under the absurd ceiling at n=100000, the practical ceiling for this class', () => {
    for (const a of ANCHORS) {
      const ms = cpuMsOnce(`${pairRun(a, 100000)}bash -c "id"`)
      expect(ms, `escaped ${a} at n=100000 took ${ms.toFixed(1)}ms CPU`).toBeLessThan(ABSURD_MS)
    }
  })
})

describe('card 1a609c01 fix: HAS_PIPE_RX + WRAPPER_POSITION_BARE_SHELL_RX independent check stays linear', () => {
  // The whole point of keeping these two checks independent (rather than one combined regex with a
  // filler between the pipe and the retry anchor) is to avoid reintroducing the exact O(n^2) shape
  // rounds 1-3 spent three rounds closing. Same adversarial anchor-pair-run shapes, now through a
  // pipe-prefixed bare shell invocation (the construct this fix actually touches).
  it.each(ANCHORS)('escaped %s pair-run before a piped bare shell grows linearly', (a) => {
    expectLinear(`escaped ${a} before piped bare shell`, (n) => `echo "x" | ${pairRun(a, n)}bash`)
  })

  it('a long run of plain pipes with no shell name anywhere grows linearly (HAS_PIPE_RX alone must not blow up)', () => {
    expectLinear('plain pipe run', (n) => '|'.repeat(n) + 'echo done')
  })
})
