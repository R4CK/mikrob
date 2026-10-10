// fleet-test.sh must refuse FLEET_TEST_TREE pointed at $ROOT (the live install) BEFORE the
// reset/clean/checkout block runs against it (card 5d365589, WhiteHat N1).
//
// WHAT WAS WRONG. The only check that caught this case lived deep inside the npm-ci/symlink block
// ("$TEST_TREE contains a LIVE marker"), far downstream of `git -C "$TEST_TREE" reset --hard` +
// `git clean -fdq` + `git checkout --detach`, which already ran unconditionally on whatever
// $TEST_TREE pointed at. Measured on a scratch copy with FLEET_TEST_TREE=$ROOT: an uncommitted
// tracked edit was reverted, an untracked file was deleted, and HEAD went detached -- all BEFORE
// the LIVE-marker die ever got a chance to refuse. Running that reproduction against the REAL live
// install to prove it is exactly the destructive action this test exists to prevent happening by
// accident, so this test reads the script's TEXT and ORDER instead (same reasoning as this file's
// sibling, fleet-test-cleans-before-checkout.test.ts, for the identical "something runs before the
// guard that should gate it" shape).
//
// THE FIX: an early `[ "$TEST_TREE" -ef "$ROOT" ] && die 2 ...` check, placed next to the existing
// temp-dir refusal, well before the lock acquisition and the reset/clean/checkout block.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'fleet-test.sh')

/** Returns the problems found, so the same reading can be pointed at a deliberately broken copy. */
function problems(text: string): string[] {
  const found: string[] = []
  const checkAt = text.search(/\[\s*"\$TEST_TREE"\s+-ef\s+"\$ROOT"\s*\]/)
  if (checkAt < 0) found.push('no `-ef` check comparing $TEST_TREE to $ROOT found')

  const dieAt = text.indexOf('die 2', checkAt < 0 ? 0 : checkAt)
  if (checkAt >= 0 && (dieAt < 0 || dieAt - checkAt > 400)) {
    found.push('the -ef check is not paired with a die 2 close enough to be the refusal itself')
  }

  // The bare string 'reset --hard' also occurs in prose above the check (describing the bug this
  // test guards against), so this looks for the REAL invocation specifically.
  const resetAt = text.indexOf('git -C "$TEST_TREE" reset --hard')
  if (resetAt < 0) found.push('could not find the real `git -C "$TEST_TREE" reset --hard` call to order against')
  if (checkAt >= 0 && resetAt >= 0 && checkAt > resetAt) {
    found.push('the -ef check appears AFTER reset --hard -- too late, the live tree would already be mutated')
  }

  return found
}

describe('fleet-test.sh refuses FLEET_TEST_TREE=$ROOT before the reset/clean/checkout block (card 5d365589 N1)', () => {
  const realText = readFileSync(SCRIPT, 'utf-8')

  it('has the -ef refusal, paired with die 2, positioned before reset --hard', () => {
    expect(problems(realText)).toEqual([])
  })

  it('MUTATION: removing the -ef check is caught', () => {
    const mutated = realText.replace(
      /\[\s*"\$TEST_TREE"\s+-ef\s+"\$ROOT"\s*\]\s*\\\n\s*&&\s*die 2[^\n]*\n/,
      '',
    )
    expect(mutated, 'the mutation did not apply').not.toBe(realText)
    expect(problems(mutated)).not.toEqual([])
  })

  it('MUTATION: moving the check after reset --hard is caught', () => {
    const checkMatch = realText.match(/\[\s*"\$TEST_TREE"\s+-ef\s+"\$ROOT"\s*\]\s*\\\n\s*&&\s*die 2[^\n]*\n/)
    expect(checkMatch, 'could not find the check to relocate').not.toBeNull()
    const checkLine = checkMatch![0]
    const withoutCheck = realText.replace(checkLine, '')
    const resetAt = withoutCheck.indexOf('git -C "$TEST_TREE" reset --hard')
    const insertAt = withoutCheck.indexOf('\n', resetAt) + 1
    const mutated = withoutCheck.slice(0, insertAt) + checkLine + withoutCheck.slice(insertAt)
    expect(mutated, 'the mutation did not apply').not.toBe(realText)
    expect(problems(mutated)).not.toEqual([])
  })
})
