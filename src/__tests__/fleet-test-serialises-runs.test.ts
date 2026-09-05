// fleet-test.sh must let only one suite run at a time on this machine (cards 85faec1b, 2f0c7d24).
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
// The third was what pinned the lock to the TREE PATH rather than to the script.
//
// THAT THIRD MEASUREMENT IS NOW REVERSED ON PURPOSE (card 2f0c7d24, Peti approved 2026-09-05). A
// private FLEET_TEST_TREE was a silent opt-out from serialisation, and the tree is not the only
// shared resource: a full suite starts one worker per core, so two runs on two trees starve each
// other's CPU and fail on timeouts instead of on defects. Re-measured after the change, same box,
// with FLEET_TEST_TREE pointed at a private path and another agent's real run holding the lock:
//   * FLEET_TEST_LOCK_WAIT=2 -> "another suite run holds the fleet lock -- waiting (up to 2s)",
//     then exit 3 naming /home/neon/marveen-test.lock -- the SHARED anchor, not the private tree's.
// The path in that message is the measurement: before this card it would have read
// <private tree>.lock, which was free, and the run would have started at once instead of queueing.
// FLEET_TEST_TREE still chooses WHERE a run happens; it no longer chooses WHETHER it queues.
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

  // MACHINE-WIDE, not per tree (card 2f0c7d24, Peti approved 2026-09-05). This assertion is the
  // exact INVERSE of what this file demanded before that card: keying the lock on ${TEST_TREE} made
  // FLEET_TEST_TREE=<own path> a silent opt-out from serialisation, because a private tree got a
  // private lock and queued behind nobody. Two suites on two trees still start one worker per core
  // each and starve one another, and a starved run fails on timeouts rather than on defects.
  if (/LOCK_FILE="\$\{TEST_TREE\}/.test(text)) found.push('the lock is keyed on the tree, so FLEET_TEST_TREE opts out of the queue')
  if (!/LOCK_FILE="\$\{ROOT\}-test\.lock"/.test(text)) found.push('the lock is not anchored to one machine-wide path')
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

describe('fleet-test.sh serialises suite runs machine-wide (cards 85faec1b, 2f0c7d24)', () => {
  const text = readFileSync(SCRIPT, 'utf-8')

  it('takes ONE machine-wide lock before touching the tree, bounded and fatal on timeout', () => {
    expect(problems(text)).toEqual([])
  })

  it('CONTROL: the same reading REJECTS the script as it was before this card', () => {
    // Without this, "no problems" and "these checks cannot detect anything" are the same result.
    const preFix = text.replace(/\ncommand -v flock[\s\S]*?\nfi\n/, '\n')
    expect(preFix, 'the mutation did not apply -- the block was not found').not.toMatch(/flock/)
    expect(problems(preFix)).toContain('no lock at all')
  })

  it('CONTROL: the pre-2f0c7d24 per-tree lock is REJECTED, so the bypass cannot come back', () => {
    // Without this, the two assertions above could both be dead and the file would still be green.
    const perTree = text.replace(/LOCK_FILE="\$\{ROOT\}-test\.lock"/, 'LOCK_FILE="${TEST_TREE}.lock"')
    expect(perTree, 'the mutation did not apply -- the anchor line was not found').toContain('LOCK_FILE="${TEST_TREE}.lock"')
    const found = problems(perTree)
    expect(found).toContain('the lock is keyed on the tree, so FLEET_TEST_TREE opts out of the queue')
    expect(found).toContain('the lock is not anchored to one machine-wide path')
  })

  it('CONTROL: a lock taken too late is caught, not just a missing one', () => {
    // Ordering is the half a "does it mention flock" check would miss: a lock acquired after the
    // checkout contains every string this file looks for and leaves the bug intact.
    const late = text.replace(/\ncommand -v flock[\s\S]*?\nfi\n/, '\n').replace('npx vitest run', 'flock -n 9\nnpx vitest run')
    expect(problems(late)).toContain('the lock is taken AFTER the checkout')
  })
})
