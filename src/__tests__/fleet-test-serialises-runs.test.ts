// fleet-test.sh must let only one run at a time mutate a given tree (card 85faec1b).
//
// THE FAILURE WAS MEASURED, and it is worse than a flaky suite. Two full-suite runs at the SAME sha
// reported 13 and 7 failures with different failing sets. The tree's reflog named the mechanism:
// while one run was in flight, other agents checked out fb60b0f at 20:27:54, ccb86e6 at 20:28:19
// and fb60b0f again at 20:28:55. Their checkouts swapped the source under the running suite and
// rewrote source mtimes, so the dist-loading suites judged a build that no longer matched the tree.
// The same sha in an uncontended tree gave 8073 passed with one unrelated failure.
//
// A gate verdict could therefore depend on another agent's checkout: a false red sends correct work
// back to in_progress, a false green lets a real defect through. And because it presents as
// flakiness, the natural response is a re-run rather than an investigation.
//
// THE LOCK BEHAVIOUR ITSELF WAS MEASURED before landing, since the assertions below are structural:
//   * no contention                       -> 2s
//   * a holder keeping the lock for 12s   -> 12s, with the "waiting" notice, then a passing run
//   * a holder on the SHARED tree's lock while running against a PRIVATE tree -> 2s, no waiting
// The third is what pins the lock to the TREE PATH rather than to the script.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'fleet-test.sh')

/** The problems found, so the same reading can be aimed at a deliberately broken copy. */
function problems(text: string): string[] {
  const found: string[] = []
  const at = (needle: string | RegExp) =>
    typeof needle === 'string' ? text.indexOf(needle) : (text.match(needle)?.index ?? -1)

  const lock = at(/flock\b/)
  const checkout = at('checkout --detach')
  const vitest = at('npx vitest')

  if (lock < 0) found.push('no lock at all')
  if (checkout < 0 || vitest < 0) found.push('this test is looking at the wrong file')
  // The critical section must START before the first mutation. A lock taken after the checkout
  // would leave the exact window this card is about wide open.
  if (lock >= 0 && checkout >= 0 && lock > checkout) found.push('the lock is taken AFTER the checkout')

  // Keyed on the tree, so a private FLEET_TEST_TREE does not queue behind the shared one -- which
  // would turn the documented workaround into a slower version of the bug.
  if (!/LOCK_FILE="\$\{TEST_TREE\}\.lock"/.test(text)) found.push('the lock is not keyed on the tree path')
  // Beside the tree, never inside it: `git clean -fdq` runs in there on every invocation.
  if (/LOCK_FILE="\$\{?TEST_TREE\}?\//.test(text)) found.push('the lock file lives inside the tree git clean wipes')

  // A wait with no bound hangs the fleet on one stuck holder; a wait that is not fatal on timeout
  // silently proceeds into the unsynchronised case.
  const wait = at(/flock -w "\$LOCK_WAIT_SECONDS"/)
  if (wait < 0) found.push('the wait is unbounded')
  // `die` has to follow the bounded wait, allowing for the line continuation between them.
  else if (!/\|\|\s*die/.test(text.slice(wait, wait + 160))) found.push('a lock timeout is not fatal')
  if (!/command -v flock/.test(text)) found.push('a missing flock is not detected')

  return found
}

describe('fleet-test.sh serialises runs per tree (card 85faec1b)', () => {
  const text = readFileSync(SCRIPT, 'utf-8')

  it('takes a per-tree lock before touching the tree, bounded and fatal on timeout', () => {
    expect(problems(text)).toEqual([])
  })

  it('CONTROL: the same reading REJECTS the script as it was before this card', () => {
    // Without this, "no problems" and "these checks cannot detect anything" are the same result.
    const preFix = text.replace(/\ncommand -v flock[\s\S]*?\nfi\n/, '\n')
    expect(preFix, 'the mutation did not apply -- the block was not found').not.toMatch(/flock/)
    expect(problems(preFix)).toContain('no lock at all')
  })

  it('CONTROL: a lock taken too late is caught, not just a missing one', () => {
    // Ordering is the half a "does it mention flock" check would miss: a lock acquired after the
    // checkout contains every string this file looks for and leaves the bug intact.
    const late = text.replace(/\ncommand -v flock[\s\S]*?\nfi\n/, '\n').replace('npx vitest run', 'flock -n 9\nnpx vitest run')
    expect(problems(late)).toContain('the lock is taken AFTER the checkout')
  })
})
