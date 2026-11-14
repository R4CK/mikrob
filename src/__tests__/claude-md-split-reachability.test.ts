// Card cc72cb3e (RedHat CYBERED GO 30478 on c60e229a, Gate-SHA b9ee959cb, F2 MEDIUM): the
// reachability + index-structure checker (scripts/claude-md-split-reachability-check.py) had
// nothing in the repo running it -- its only references were itself and DECISIONS.md. A gate-
// green mutant of CLAUDE.md or docs/rules could ship forever and nothing would notice. These
// two tests are the standing control: the first pins the LIVE files (a real weakening of a
// binding rule, a moved/orphaned docs/rules file, a broken/relative link, a corrupted protocol
// token, or a deleted/inverted index bullet turns this test red); the second pins the CHECKER
// ITSELF against regressing (RedHat's own 10 mutants, comment 30478, plus the pre-existing
// in-place-weakening control -- scripts/claude-md-split-reachability-check.selftest.py asserts
// each one still flips the checker red).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHECKER = join(ROOT, 'scripts', 'claude-md-split-reachability-check.py')
const SELFTEST = join(ROOT, 'scripts', 'claude-md-split-reachability-check.selftest.py')
// The pre-split commit the card-c60e229a split started from (develop has since moved, but
// CLAUDE.md/docs/rules have not -- see DECISIONS.md c60e229a entries).
const OLD_REF = '61a258e38'

describe('claude-md-split-reachability-check.py: standing control (card cc72cb3e)', () => {
  it('the live CLAUDE.md + docs/rules pass the reachability + index-structure check', () => {
    expect(() =>
      execFileSync(
        'python3',
        [CHECKER, OLD_REF, join(ROOT, 'CLAUDE.md'), join(ROOT, 'docs', 'rules')],
        { cwd: ROOT, encoding: 'utf-8' }
      )
    ).not.toThrow()
  })

  it(
    "RedHat's 10 mutants (comment 30478) + the in-place-weakening control still flip the checker red",
    () => {
      // ~6s on a quiet machine: 26 cases, several spawning 2-3 of their own python3 subprocesses
      // each (the --update-baseline round-trips). Default vitest timeout (5s) is too tight.
      expect(() => execFileSync('python3', [SELFTEST], { cwd: ROOT, encoding: 'utf-8' })).not.toThrow()
    },
    30000,
  )
})
