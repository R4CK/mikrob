// fleet-test.sh must clean the tree BEFORE switching commits, not only after (card 1d2f4bfb).
//
// THE FAILURE WAS REPRODUCED, not imagined. The suite mutates tracked files in the test tree while
// it runs (store/, .env -- the same paths the live-install guard exists to protect, sandboxed here
// instead of refused). A run killed mid-suite leaves those mutations sitting uncommitted, and
// `git checkout --detach` refuses to switch commits when the target's version of a locally-modified
// file differs from HEAD's ("local changes would be overwritten"). Reproduced by hand: dirtying a
// tracked file that also differs between the tree's current commit and a new --ref target made the
// PRE-FIX script fail with "could not move ... to <sha>" and no indication why; the fixed script,
// pointed at the identical dirty tree, cleaned it first and completed the run (card c26a9064 first
// hit this and recovered by hand -- confirmed nothing was lost).
//
// WHY THIS TEST IS STRUCTURAL, not an execution of the real script. Reproducing the dirty-tree
// scenario needs a real git worktree, a real killed-mid-mutation file edit, and a real checkout
// attempt -- seconds of work and a mutation of shared state, inside a suite that must stay cheap and
// side-effect free (same reasoning as fleet-test-builds-before-running.test.ts and
// fleet-test-serialises-runs.test.ts, its siblings for this same script). What actually needs
// protecting is an ORDER (clean happens before checkout, not only after) and that a checkout failure
// SURFACES git's own reason instead of a bare "could not move". Those are properties of the script's
// text, and the control below keeps the reading honest.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'fleet-test.sh')

/** Only the update branch (the tree already exists) -- the one-time creation branch above it does
 *  not have this problem, since `git worktree add` starts from nothing. */
function updateBranch(text: string): string {
  const fromCreate = text.indexOf('worktree add')
  if (fromCreate < 0) return ''
  const elseAt = text.indexOf('\nelse\n', fromCreate)
  if (elseAt < 0) return ''
  const fiAt = text.indexOf('\nfi\n', elseAt)
  return fiAt < 0 ? '' : text.slice(elseAt, fiAt)
}

/** Returns the problems found, so the same reading can be pointed at a deliberately broken copy. */
function problems(text: string): string[] {
  const found: string[] = []
  const branch = updateBranch(text)
  if (!branch) return ['this test is looking at the wrong file (no update branch found)']

  const at = (needle: string | RegExp) =>
    typeof needle === 'string' ? branch.indexOf(needle) : (branch.match(needle)?.index ?? -1)

  const preReset = at(/reset --hard\s*>/) // bare reset (no $TARGET arg) -- resets to the CURRENT commit
  const preClean = at(/clean -fdq -e node_modules\s*>/)
  const checkout = at('checkout --detach')

  if (checkout < 0) found.push('this test is looking at the wrong file (no checkout in the update branch)')
  if (preReset < 0 || preReset > checkout) found.push('no reset --hard before the checkout')
  if (preClean < 0 || preClean > checkout) found.push('no clean before the checkout')
  // Order between the two pre-checkout steps does not matter (either fully clears local state before
  // the other runs), only that BOTH precede the checkout -- already asserted above.

  // A checkout failure must show git's OWN reason, not just a static string: a bare "could not move"
  // gave the person debugging it (card c26a9064) nothing to act on beyond re-running by hand.
  if (!/checkout_err=.*2>&1/.test(branch)) found.push('checkout stderr is discarded, not captured')
  if (!/\$checkout_err/.test(branch.slice(at('checkout --detach')))) {
    found.push('the captured git error is never shown to the caller')
  }

  return found
}

describe('fleet-test.sh cleans the tree before checkout, not only after (card 1d2f4bfb)', () => {
  const text = readFileSync(SCRIPT, 'utf-8')

  it('resets and cleans before switching commits, and surfaces a real checkout failure', () => {
    expect(problems(text)).toEqual([])
  })

  it('CONTROL: the same reading REJECTS the script as it was before this card', () => {
    // The mutation is the actual pre-fix shape: checkout straight away, errors discarded, reset and
    // clean only happen AFTER (against $TARGET, which is the existing post-checkout step below).
    const preFix = text.replace(
      /git -C "\$TEST_TREE" reset --hard >\/dev\/null 2>&1\n  git -C "\$TEST_TREE" clean -fdq -e node_modules >\/dev\/null 2>&1\n  checkout_err="\$\(git -C "\$TEST_TREE" checkout --detach "\$TARGET" 2>&1\)" \|\| die 3 "[\s\S]*?status"/,
      'git -C "$TEST_TREE" checkout --detach "$TARGET" >/dev/null 2>&1 \\\n    || die 3 "could not move $TEST_TREE to $TARGET"',
    )
    expect(preFix, 'the mutation did not apply -- the block was not found').not.toBe(text)
    expect(preFix).not.toContain('checkout_err')
    const p = problems(preFix)
    expect(p).toContain('no reset --hard before the checkout')
    expect(p).toContain('no clean before the checkout')
    expect(p).toContain('checkout stderr is discarded, not captured')
  })

  it('CONTROL: cleaning only AFTER the checkout (the existing post-checkout step) does not count as before', () => {
    // A naive "does the branch mention reset and clean" check would pass on the ORIGINAL script too,
    // since it already reset+cleaned after a successful checkout. Order is the property that matters.
    const postOnly = text.replace(
      /git -C "\$TEST_TREE" reset --hard >\/dev\/null 2>&1\n  git -C "\$TEST_TREE" clean -fdq -e node_modules >\/dev\/null 2>&1\n  checkout_err=/,
      'checkout_err=',
    )
    expect(postOnly, 'the mutation did not apply').not.toBe(text)
    const p = problems(postOnly)
    expect(p).toContain('no reset --hard before the checkout')
    expect(p).toContain('no clean before the checkout')
  })
})
