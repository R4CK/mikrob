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

describe('stripHeredocDataPayloads via scanBashWord: quadratic-blowup repro must stay fast (card 1fec67e9)', () => {
  // Pre-fix measured (this session, --prof-confirmed root cause): n=32000 backticks took ~1.4s
  // through the real gateDecision(), scaling ~4x per doubling -- n=64000 was already ~6s, within
  // reach of the hook's own 10s fail-open timeout at n=128000-256000, well under MAX_COMMAND_BYTES.
  it.each([16000, 32000, 64000])('n=%i adjacent backticks stays under 500ms', (n) => {
    const text = '`'.repeat(n) + `bash -c "${CT} -r"`
    const t0 = Date.now()
    gateDecision('Bash', { command: text })
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('stays fast at n=128000, near the practical ceiling this class of input reaches', () => {
    const text = '`'.repeat(128000) + `bash -c "${CT} -r"`
    const t0 = Date.now()
    gateDecision('Bash', { command: text })
    // Generous margin for full-suite CPU contention -- isolated measured ~410ms; pre-fix this shape
    // did not complete in any reasonable time (quadratic extrapolation put it past 10s already at
    // n=~128000-256000).
    expect(Date.now() - t0).toBeLessThan(1500)
  })
})
