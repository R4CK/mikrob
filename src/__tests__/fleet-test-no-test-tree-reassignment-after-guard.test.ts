// Card 656158fb (RedHat LOW, e6df15da comment 14483, 9a0f47b1): the existing C1 regression suite
// (fleet-test-relative-tree-is-root.test.ts) runs the extracted ROOT_GUARD_BLOCK verbatim, then
// hand-writes its own `cd "$ROOT" || die 3 ...` line in the test harness instead of running the
// REAL argument-parsing loop that sits between the guard's end marker and the real `cd "$ROOT"`
// call in store/fleet-test.sh. That gap is exactly the dangerous one: $TEST_TREE is resolved to an
// absolute path and checked against $ROOT ONLY inside the guard block -- if anything between the
// guard's end and the real `cd` reassigned TEST_TREE afterwards (mutant I), every later `git -C
// "$TEST_TREE"` call (including the destructive reset/clean/checkout trio) would use the new,
// unchecked value instead. The 19-test suite covering this file's guard block is blind to that
// gap because it never runs the gap's own source at all.
//
// Rather than duplicate the C1 harness as a second end-to-end runner (which would have to either
// invoke the real script up to its flock/vitest machinery -- outside this test's job, and against
// rule 17's "no suite run outside the semaphore script" -- or re-hand-write the same gap it is
// trying to verify), this is the STATIC half of the fix the card itself offers as an alternative:
// prove, by reading the actual gap's source text (not a hand-copied stand-in), that no
// `TEST_TREE=` assignment exists between ROOT_GUARD_BLOCK_END and the real `cd "$ROOT"` call. The
// MUTATION test below proves the detector actually fires on the exact regression class.
//
// Card c5f98f82 (656158fb WhiteHat F1/F2 follow-up) closed two further gaps in this detector:
// F1: the ORIGINAL version only checked the gap BEFORE the real `cd "$ROOT"` call -- a
// TEST_TREE= reassignment inserted AFTER that cd but BEFORE the destructive reset/clean/checkout
// trio (DESTRUCTIVE_RESET_BLOCK_START) does the exact same damage and was invisible to it. Now
// BOTH gaps are checked.
// F2: the detector was blind to 4 forms that write TEST_TREE without matching its old
// `TEST_TREE\s*=` regex: (a) `[ $# -ge 0 ] && TEST_TREE=...` -- the naive first-`#` comment strip
// treated `$#` (bash's positional-arg-count variable) as a comment start and sliced off the real
// assignment that followed it on the same line; (b) `printf -v TEST_TREE ...` and (c)
// `read -r TEST_TREE` write the variable with no `=` at all; (d) `TEST_TREE+=...` has a `+`
// between the name and the `=` that the old regex did not allow for.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(PROJECT_ROOT, 'store', 'fleet-test.sh')
const GUARD_END = '# <<< ROOT_GUARD_BLOCK_END'
const CD_ROOT_CALL = 'cd "$ROOT" || die 3'
const DESTRUCTIVE_START = '# >>> DESTRUCTIVE_RESET_BLOCK_START'

function extractGapBeforeCd(scriptText: string): string {
  const endAt = scriptText.indexOf(GUARD_END)
  if (endAt < 0) throw new Error('could not find ROOT_GUARD_BLOCK_END in fleet-test.sh')
  const gapStart = endAt + GUARD_END.length
  const cdAt = scriptText.indexOf(CD_ROOT_CALL, gapStart)
  if (cdAt < 0) throw new Error('could not find the real `cd "$ROOT"` call after ROOT_GUARD_BLOCK_END')
  return scriptText.slice(gapStart, cdAt)
}

// F1: the SECOND insertion point the card names -- after the real cd, before the destructive
// reset/clean/checkout trio. Same class of damage (TEST_TREE resolved+checked once, then silently
// swapped before the destructive calls use it), different window.
function extractGapAfterCd(scriptText: string): string {
  const cdAt = scriptText.indexOf(CD_ROOT_CALL)
  if (cdAt < 0) throw new Error('could not find the real `cd "$ROOT"` call in fleet-test.sh')
  const gapStart = cdAt + CD_ROOT_CALL.length
  const destructiveAt = scriptText.indexOf(DESTRUCTIVE_START, gapStart)
  if (destructiveAt < 0) throw new Error('could not find DESTRUCTIVE_RESET_BLOCK_START after the real cd "$ROOT" call')
  return scriptText.slice(gapStart, destructiveAt)
}

// F2(a): strip only a `#` that is NOT part of bash's `$#` (positional-arg count) -- the old
// first-`#`-on-the-line strip treated `$#` itself as a comment start and ate everything after it,
// including a real `TEST_TREE=` assignment on the same line (e.g. `[ $# -ge 0 ] && TEST_TREE=...`).
function stripComments(gapText: string): string {
  return gapText
    .split('\n')
    .map((line) => line.replace(/(?<!\$)#.*/, ''))
    .join('\n')
}

// F2(b)(c)(d): a bare `TEST_TREE=` assignment, a `TEST_TREE+=` append, a `printf -v TEST_TREE`
// write, or a `read ... TEST_TREE` write -- none of the latter three have a plain `=` right after
// the name, which the original regex required.
const ASSIGN_RX = /(?<![$\w])TEST_TREE\s*\+?=/
const PRINTF_V_RX = /\bprintf\b[^\n]*-v\s+TEST_TREE\b/
const READ_RX = /\bread\b[^\n]*(?<![$\w])TEST_TREE\b/

function hasTestTreeReassignment(gapText: string): boolean {
  const codeOnly = stripComments(gapText)
  return ASSIGN_RX.test(codeOnly) || PRINTF_V_RX.test(codeOnly) || READ_RX.test(codeOnly)
}

describe('fleet-test.sh: no TEST_TREE= reassignment between the $ROOT guard and the real cd (card 656158fb)', () => {
  it('REAL CODE: the gap between ROOT_GUARD_BLOCK_END and the real cd "$ROOT" call has no TEST_TREE= assignment', () => {
    const scriptText = readFileSync(SCRIPT, 'utf-8')
    const gap = extractGapBeforeCd(scriptText)
    expect(hasTestTreeReassignment(gap)).toBe(false)
  })

  it('MUTATION: a TEST_TREE= reassignment inserted into the before-cd gap is detected (proves the check catches mutant I)', () => {
    const scriptText = readFileSync(SCRIPT, 'utf-8')
    const gap = extractGapBeforeCd(scriptText)
    const mutatedGap = gap.replace('REF=""', 'REF=""\nTEST_TREE="$1"')
    expect(mutatedGap, 'the mutation did not apply').not.toBe(gap)
    expect(hasTestTreeReassignment(mutatedGap)).toBe(true)
  })

  it('a TEST_TREE= assignment hidden behind a comment on the same line is still caught', () => {
    const hidden = 'echo ok # looks inert\nTEST_TREE="$evil"  # sneaky\n'
    expect(hasTestTreeReassignment(hidden)).toBe(true)
  })

  it('a bare read of $TEST_TREE (no assignment) is NOT a false positive', () => {
    const readOnly = 'echo "$TEST_TREE"\n[ -n "$TEST_TREE" ] && true\n'
    expect(hasTestTreeReassignment(readOnly)).toBe(false)
  })

  it('a comment merely naming TEST_TREE= in prose is NOT a false positive once comments are stripped', () => {
    const commentOnly = '# see TEST_TREE= in the block above for context\necho "$TEST_TREE"\n'
    expect(hasTestTreeReassignment(commentOnly)).toBe(false)
  })

  it('a differently-named variable ending in TEST_TREE is NOT a false positive (word-boundary check)', () => {
    const otherVar = 'MY_TEST_TREE="$1"\n'
    expect(hasTestTreeReassignment(otherVar)).toBe(false)
  })
})

describe('F1 (card c5f98f82): the AFTER-cd, before-destructive-trio gap is also checked', () => {
  it('REAL CODE: the gap between the real cd "$ROOT" call and DESTRUCTIVE_RESET_BLOCK_START has no TEST_TREE= assignment', () => {
    const scriptText = readFileSync(SCRIPT, 'utf-8')
    const gap = extractGapAfterCd(scriptText)
    expect(hasTestTreeReassignment(gap)).toBe(false)
  })

  it('MUTATION: a TEST_TREE="$ROOT" reassignment inserted into the after-cd gap is detected', () => {
    const scriptText = readFileSync(SCRIPT, 'utf-8')
    const gap = extractGapAfterCd(scriptText)
    const mutatedGap = `${gap}\nTEST_TREE="$ROOT"\n`
    expect(hasTestTreeReassignment(mutatedGap)).toBe(true)
  })
})

describe('F2 (card c5f98f82): the detector is not blind to these 4 write forms', () => {
  it('a) `$#` on the same line as a real assignment is not mistaken for a comment start', () => {
    const line = '[ $# -ge 0 ] && TEST_TREE="$1"\n'
    expect(hasTestTreeReassignment(line)).toBe(true)
  })
  it('b) printf -v TEST_TREE', () => {
    expect(hasTestTreeReassignment('printf -v TEST_TREE "%s" "$1"\n')).toBe(true)
  })
  it('c) read -r TEST_TREE', () => {
    expect(hasTestTreeReassignment('read -r TEST_TREE <<< "$1"\n')).toBe(true)
  })
  it('d) TEST_TREE+=', () => {
    expect(hasTestTreeReassignment('TEST_TREE+="/sub"\n')).toBe(true)
  })
  it('none of the 4 forms are false positives when they operate on a DIFFERENT variable', () => {
    expect(hasTestTreeReassignment('[ $# -ge 0 ] && OTHER_VAR="$1"\n')).toBe(false)
    expect(hasTestTreeReassignment('printf -v OTHER_VAR "%s" "$1"\n')).toBe(false)
    expect(hasTestTreeReassignment('read -r OTHER_VAR <<< "$1"\n')).toBe(false)
    expect(hasTestTreeReassignment('OTHER_VAR+="/sub"\n')).toBe(false)
  })
})
