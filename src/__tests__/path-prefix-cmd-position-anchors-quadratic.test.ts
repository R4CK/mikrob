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

describe('PATH_PREFIX CMD_POSITION-anchor fix: quadratic-blowup repro must stay fast (card 39cc3460 round 3)', () => {
  // Pre-fix measured (Cybersec, Gate-SHA e724ae21, through the real gateDecision()): n=32000 pairs
  // (64 KB) took up to 13.3s on these characters -- already past the hook's own 10s timeout.
  it.each(ANCHORS)('escaped %s pair-run stays under 500ms at n=16000 pairs', (a) => {
    const text = `${pairRun(a, 16000)}bash -c "id"`
    const t0 = Date.now()
    gateDecision('Bash', { command: text })
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('stays fast at n=100000 pairs across all seven anchors, near the practical ceiling this class of input reaches', () => {
    for (const a of ANCHORS) {
      const text = `${pairRun(a, 100000)}bash -c "id"`
      const t0 = Date.now()
      gateDecision('Bash', { command: text })
      // Generous margin for full-suite CPU contention (isolated measured: 37-215ms per anchor at
      // this size) -- still two orders of magnitude below the pre-fix quadratic blowup.
      expect(Date.now() - t0).toBeLessThan(1000)
    }
  })
})

describe('card 1a609c01 fix: HAS_PIPE_RX + WRAPPER_POSITION_BARE_SHELL_RX independent check stays fast', () => {
  // The whole point of keeping these two checks independent (rather than one combined regex with a
  // filler between the pipe and the retry anchor) is to avoid reintroducing the exact O(n^2) shape
  // rounds 1-3 spent three rounds closing. Same adversarial anchor-pair-run shapes, now through a
  // pipe-prefixed bare shell invocation (the construct this fix actually touches).
  it.each(ANCHORS)('escaped %s pair-run before a piped bare shell stays under 500ms at n=16000 pairs', (a) => {
    const text = `echo "x" | ${pairRun(a, 16000)}bash`
    const t0 = Date.now()
    gateDecision('Bash', { command: text })
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('a long run of plain pipes with no shell name anywhere stays fast (HAS_PIPE_RX alone must not blow up)', () => {
    const text = '|'.repeat(100000) + 'echo done'
    const t0 = Date.now()
    gateDecision('Bash', { command: text })
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
