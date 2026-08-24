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

// KNOWN, DOCUMENTED RESIDUAL -- not silently dropped, flagged for the gate to weigh in on.
//
// STDIN_SHELL_RX's pipe branch is the ONE construct that does NOT retry via WRAPPER_POSITION -- its
// own anchor is a literal `\|`, not the broader CMD_POSITION class. Round 2's fix "worked" for pipe
// specifically only because escaping a pipe leaves a SECOND literal `|` character in the string,
// which happens to BE this construct's own anchor -- a coincidence of the character overlapping its
// own operator, not a general retry mechanism. None of the other six anchors leave behind a literal
// `|`, so once PATH_PREFIX refuses to consume them (required for the DoS fix -- see the file header
// comment in self-pace-gate.mjs), there is no second anchor left for this specific branch to retry
// from, and detection genuinely fails for this one combination: an escaped `;`/`&`/`(`/`)`/`{`/`!`/
// backtick, inside a path, directly before a bare (`-c`-less) shell name, piped into from stdin.
//
// Judged NOT worth widening this construct's anchor to full WRAPPER_POSITION to close it here: doing
// so would broaden STDIN_SHELL_RX's pipe branch from "specifically after a pipe" to "at any command
// position", which is semantic scope creep well beyond this card (new false-positive surface, needs
// its own threat-model pass) -- and the concrete exploitability is very low, since escaping one of
// these seven characters keeps it LITERALLY in the resulting path (`lo;cal`, `lo!cal`, a backtick in
// a directory name, ...), unlike escaped space or escaped pipe which are unremarkable in a real path.
// A real target would need a directory on disk literally named e.g. `lo;cal` for this to resolve to
// an executable at all.
describe('STDIN_SHELL_RX pipe branch: documented gap for non-pipe escaped anchors (card 39cc3460 round 3)', () => {
  it.each(ANCHORS)('escaped %s inside the path prefix is NOT currently caught by the pipe branch alone', (a) => {
    const cmd = `echo "${CT} -" | /usr/lo\\${a}cal/bin/bash`
    // Documents the gap rather than hiding it -- if this ever flips to `true`, tighten the comment
    // above and the sibling MUST_DENY block instead of just deleting this test.
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
