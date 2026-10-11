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
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(PROJECT_ROOT, 'store', 'fleet-test.sh')
const GUARD_END = '# <<< ROOT_GUARD_BLOCK_END'
const CD_ROOT_CALL = 'cd "$ROOT" || die 3'

function extractGap(scriptText: string): string {
  const endAt = scriptText.indexOf(GUARD_END)
  if (endAt < 0) throw new Error('could not find ROOT_GUARD_BLOCK_END in fleet-test.sh')
  const gapStart = endAt + GUARD_END.length
  const cdAt = scriptText.indexOf(CD_ROOT_CALL, gapStart)
  if (cdAt < 0) throw new Error('could not find the real `cd "$ROOT"` call after ROOT_GUARD_BLOCK_END')
  return scriptText.slice(gapStart, cdAt)
}

// Strips everything from the first `#` on each line (this gap has no quoted literal containing a
// `#`, verified by the fixture below -- a comment-stripped read is what card 12 of the
// Kódminőségi alapelvek requires for this exact "comment mentions it" bypass class), then checks
// for a bare `TEST_TREE=` assignment that is not a read of `$TEST_TREE`.
function hasTestTreeReassignment(gapText: string): boolean {
  const codeOnly = gapText
    .split('\n')
    .map((line) => {
      const hashAt = line.indexOf('#')
      return hashAt === -1 ? line : line.slice(0, hashAt)
    })
    .join('\n')
  return /(?<![$\w])TEST_TREE\s*=/.test(codeOnly)
}

describe('fleet-test.sh: no TEST_TREE= reassignment between the $ROOT guard and the real cd (card 656158fb)', () => {
  it('REAL CODE: the gap between ROOT_GUARD_BLOCK_END and the real cd "$ROOT" call has no TEST_TREE= assignment', () => {
    const scriptText = readFileSync(SCRIPT, 'utf-8')
    const gap = extractGap(scriptText)
    expect(hasTestTreeReassignment(gap)).toBe(false)
  })

  it('MUTATION: a TEST_TREE= reassignment inserted into the gap is detected (proves the check catches mutant I)', () => {
    const scriptText = readFileSync(SCRIPT, 'utf-8')
    const gap = extractGap(scriptText)
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
