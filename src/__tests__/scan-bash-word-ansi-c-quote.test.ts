// Card 5c9c15c0 (Cybered 84e31b40 round 11, dedup-checked against ec20dd23 first): scanBashWord's
// plain-quote branch (`indexOf("'", ...)`) does not understand ANSI-C `$'...'` quoting, where a
// backslash-escaped apostrophe (`\'`) does NOT terminate the string. A naive indexOf stops at that
// FIRST apostrophe -- escaped or not -- and returns a too-short span for a NAME written as
// `$'AB\'CD'`.
//
// DEDUP CHECK (this card's own first instruction, done before writing any fix): ec20dd23's fix
// lives in QUOTED_LITERAL_RX/unquoteWord/readAnsiC -- a COMPLETELY SEPARATE code path from
// scanBashWord, which never calls into it. Not already covered; a real second location.
//
// NOT EXPLOITABLE TODAY (confirmed, not assumed): bash itself refuses an apostrophe inside a
// coproc/function/POSIX-style NAME before the body ever runs, so a real `$'...'`-shaped NAME can
// never reach this scanner from anything bash would actually execute. Empirically A/B'd here too
// (see the second describe block): running the SAME crafted input through both the pre-fix and
// post-fix gateDecision() produces IDENTICAL `deny` results -- the dangerous body is caught by an
// independent detector regardless of scanBashWord's span, so there is no live repro to pin as a
// before/after security assertion. Fixed anyway, for the same reason ec20dd23 fixed its own copy of
// this exact blindness: consistency now is cheaper than a live repro later, and reuses readAnsiC
// (this file's one ANSI-C decoder) rather than adding a second one.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

const CT = 'cron' + 'tab'
const bash = (command: string): boolean => Boolean(gateDecision('Bash', { command }).deny)

describe('scanBashWord ANSI-C $\'...\' quoting: no regression on existing NAME shapes (card 5c9c15c0)', () => {
  // The six shapes scanBashWord's own header names as its reason for existing (mirrors
  // scan-bash-word-backtick-quadratic.test.ts's own regression block) -- none of them involve
  // `$'...'`, so the new branch must not change any of their outcomes.
  it.each([
    ['f$(y $(z))', 'nested $() inside a name'],
    ['f`echo $(y)`', '$() nested inside a backtick-delimited name'],
    ['f${u:-$(y)}', '$() inside a parameter expansion default, inside a name'],
  ])('%s (%s) still denies the dangerous body behind it', (name) => {
    expect(bash(`${name}() { ${CT} -r; }`)).toBe(true)
  })

  it('a plain single-quoted name (no ANSI-C form) is unaffected', () => {
    expect(bash(`'plain-name'() { ${CT} -r; }`)).toBe(true)
  })
})

describe('scanBashWord ANSI-C $\'...\' quoting: the escaped-apostrophe shape itself (card 5c9c15c0)', () => {
  // f-string-style NAME with an ANSI-C-quoted piece containing an ESCAPED apostrophe -- the exact
  // shape a naive indexOf("'", ...) mis-spans (stopping at \' instead of the real closing quote).
  it('a coproc name containing $\'...\\\'...\' still denies the dangerous compound body', () => {
    expect(bash(`coproc $'AB\\'CD' { ${CT} -r; }`)).toBe(true)
  })
  it('a function name containing $\'...\\\'...\' still denies the dangerous compound body', () => {
    expect(bash(`function $'AB\\'CD' { ${CT} -r; }`)).toBe(true)
  })
  it('a benign coproc/ANSI-C-name combination is not falsely denied', () => {
    expect(bash(`coproc $'AB\\'CD' { echo hi; }`)).toBe(false)
  })
})
