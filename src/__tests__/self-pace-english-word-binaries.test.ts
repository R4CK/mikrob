// Card 442f3289: the fourth false positive of one class, and the first fix on the axis that
// produced it.
//
// at(1) and batch(1) are ordinary English words. In the heredoc-body scan (card 46c4ad4a) the gate
// matches UNANCHORED -- deliberately, because a heredoc body line has no reliable command-position
// structure to anchor to -- so the only thing separating an English sentence from a denial was the
// lookahead at what FOLLOWS the word. What follows "at" in prose about schedules and measurements
// is exactly what at(1) accepts as a timespec: a clock time, a date, "noon", "today", a weekday, a
// 3-4 digit number.
//
// Three earlier fixes (0229c844, eae5d6fd, 46c4ad4a) each removed one alternative from that
// lookahead, plus one that removed the end-of-segment branch. The class kept coming back, because
// "what may follow the word" is where prose and at(1) genuinely OVERLAP -- narrowing it cannot
// converge. The fix requires command POSITION instead, which prose does not have.
//
// WHY THE SECOND HALF OF THIS FILE IS THE LOAD-BEARING ONE. The change makes the branch deny LESS,
// so the risk is a hole, not a false positive. Every position a shell actually runs a word from is
// enumerated in the fix, and each one is measured below; if one is ever dropped from the
// enumeration, a real at(1) submit walks through. Assembled from parts rather than written
// literally, like the sibling nested-command suite: this file is itself scanned by the gate it
// tests.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

const NL = String.fromCharCode(10)
const AT = 'a' + 't'
const BATCH = 'bat' + 'ch'
const bash = (command: string): boolean => Boolean(gateDecision('Bash', { command }).deny)
/** The shape every case here lives in: a heredoc body, which is the only place this branch runs. */
const doc = (...lines: string[]): string => [`cat > note.txt <<'XEOF'`, ...lines, 'XEOF'].join(NL)

describe('PROSE: an English sentence containing a timespec is not a schedule (card 442f3289)', () => {
  // Each row was measured DENIED before the fix. The first is the reproducible pattern MikroB
  // recorded from a live REVIEW (a sentence about a pane and a clock time); the rest are the same
  // collision reached through the other timespec alternatives.
  const SENTENCES: Array<[string, string]> = [
    ['a clock time mid-sentence (the recorded repro)', `The nudger found the pane ${AT} 16:13 and did nothing.`],
    ['a clock time in a report line', `The sweep fired ${AT} 09:30 and again later.`],
    ['a duration in milliseconds', `The call was retried ${AT} 1200 ms and then gave up.`],
    ['an am/pm time', `The last landing happened ${AT} 5pm yesterday.`],
    ['a date', `Measured ${AT} 08/14 on the shared clone.`],
    ['the word noon', `The digest runs ${AT} noon for every tenant.`],
    ['the word today', `We are ${AT} today rate of three cards.`],
    ['a weekday name', `The counter resets ${AT} mon boundary.`],
    ['a month abbreviation', `The archive starts ${AT} dec and runs on.`],
    ['a bare number at(1) would accept', `The queue sat ${AT} 1200 entries.`],
    ['the other English word', `We process ${BATCH} 1200 rows per tick.`],
  ]
  it.each(SENTENCES)('%s', (_name, sentence) => {
    expect(bash(doc(sentence))).toBe(false)
  })

  it('a multi-line body: the sentence is still prose when it has a line to itself', () => {
    // splitSegments treats a newline as a boundary, which is how a prose LINE started looking like
    // a command in the first place. Position within the line is what decides it now.
    expect(bash(doc('Notes:', `The pane was idle ${AT} 16:13.`, 'Nothing was scheduled.'))).toBe(false)
  })
})

describe('REAL: every position a shell runs a word from still denies (card 442f3289)', () => {
  // The enumeration in LINE_CMD_POSITION has to be COMPLETE, not merely tolerant -- this branch
  // now denies less, so a missing position is a bypass rather than a nuisance. One test per
  // position: a combined case would let the others come back silently.
  const INVOCATIONS: Array<[string, string]> = [
    ['line start, bare timespec', `${AT} 16:13`],
    ['line start, relative timespec', `${AT} now + 5 minutes`],
    ['a flag instead of a timespec', `${AT} -f job.sh`],
    ['an input redirect', `${AT} 10:00 < job.sh`],
    ['after a semicolon', `echo hi; ${AT} now + 1 minute`],
    ['after a pipe, behind a read form', `${AT}q; echo go | ${AT} now + 5 minutes`],
    ['after a double quote (bash -c)', `bash -c "${AT} now + 5 minutes"`],
    ['after a single quote (bash -c)', `bash -c '${AT} now + 5 minutes'`],
    ['inside a command substitution', `X=$(${AT} now + 5 minutes)`],
    ['inside a subshell', `(${AT} now + 5 minutes)`],
    ['after the then keyword', `if true; then ${AT} now + 5 minutes; fi`],
    ['after the do keyword', `for i in 1; do ${AT} now + 5 minutes; done`],
    ['behind a sudo wrapper', `sudo ${AT} now + 5 minutes`],
    ['behind an environment assignment', `PATH=/bin ${AT} now + 5 minutes`],
    ['by absolute path', `/usr/bin/${AT} now + 5 minutes`],
    ['a bare batch, which reads stdin and needs no timespec', `echo x | ${BATCH}`],
    ['batch at line start', BATCH],
  ]
  it.each(INVOCATIONS)('%s', (_name, cmd) => {
    expect(bash(doc(cmd))).toBe(true)
  })

  it('the binaries that are NOT English words keep their unanchored match', () => {
    // They lose nothing from this change, and must not: prose cannot collide with them, so there
    // was never a reason to require position. If someone ever "tidies" the fix by applying it to
    // all four, this is what notices.
    const CT = 'cron' + 'tab'
    expect(bash(doc(`the pipeline ends with ${CT} - which installs it`))).toBe(true)
  })
})

describe('what this fix does NOT claim (card 442f3289)', () => {
  it('a prose line that BEGINS with the word plus a timespec is still denied, and that is honest', () => {
    // Structurally identical to a real invocation: at line start, followed by a timespec. Nothing
    // in the text distinguishes them, so the gate keeps denying rather than guessing. Pinned so
    // the next reader does not believe the class is fully closed -- the remaining shape is rare
    // (prose rarely opens a line with "at 09:30") and the workaround is the documented one.
    expect(bash(doc(`${AT} 09:30 the sweep runs, which is wrong`))).toBe(true)
  })

  it('ANTI-VACUITY: the anchored path outside any heredoc is untouched', () => {
    // Every assertion above lives inside a heredoc body. Without this, a change that broke the
    // ordinary command path entirely would leave this whole file green.
    expect(bash(`${AT} now + 5 minutes`)).toBe(true)
  })
})
