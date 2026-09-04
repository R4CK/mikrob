// Card 83d970fa: a name in KNOWN_HOOK_SCRIPTS must name a script that EXISTS in this checkout.
//
// WHY THIS IS THE INVARIANT WORTH PINNING, rather than "the list matches the union rule". The list
// decides whether a missing-file hook entry is OURS (prunable) or foreign (kept). So a name whose
// script is NOT here does not fail safe: it arms the pruner against any settings.json that DOES
// reference that script -- deleting a registration this install never owned.
//
// That is exactly the trap in this card as written. It asked for three names; two of them
// (clear-capture.py, clear-replay.py) are upstream's and do not exist in this checkout yet, so
// adding them would have turned a documentation gap that errs SAFE into a pruner that errs
// DANGEROUS. The third, skill-usage-capture.py, is here and was added.
//
// This test is what makes the timing structural: the two names become addable the moment their
// scripts arrive with the upstream merge, and not before -- nobody has to remember the reasoning.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KNOWN_HOOK_SCRIPTS } from '../web/hook-registration-guard.js'
import { PROJECT_ROOT } from '../config.js'

// Every listed script lives in one of these two directories today; a new location is a deliberate
// decision, not something this test should silently accept.
const SEARCH_DIRS = ['scripts/hooks', 'scripts'] as const

function resolveScript(name: string): string | null {
  for (const dir of SEARCH_DIRS) {
    const p = join(PROJECT_ROOT, dir, name)
    if (existsSync(p)) return p
  }
  return null
}

describe('KNOWN_HOOK_SCRIPTS only names scripts this checkout actually has (card 83d970fa)', () => {
  it.each(KNOWN_HOOK_SCRIPTS.map((s) => [s]))('%s exists in the checkout', (name) => {
    expect(
      resolveScript(name),
      `${name} is listed as ours-and-prunable, but no such script exists here -- a settings entry ` +
        'naming it would be DELETED as a stale entry of ours, when it is in fact somebody else\'s',
    ).not.toBeNull()
  })

  it('the fork half of the acknowledged union is present', () => {
    expect(KNOWN_HOOK_SCRIPTS).toContain('outgoing-copy-gate.py')
  })

  it('skill-usage-capture.py is listed -- its script is here, so listing it is free', () => {
    expect(KNOWN_HOOK_SCRIPTS).toContain('skill-usage-capture.py')
  })

  it('the two /clear names stay out until their scripts arrive with the upstream merge', () => {
    // Not a preference: while the files are absent, listing them arms the pruner against installs
    // that DO have them. If a later merge brings the scripts, this expectation is what should be
    // updated -- together with adding the names, in the same commit.
    for (const name of ['clear-capture.py', 'clear-replay.py']) {
      if (resolveScript(name) === null) {
        expect(
          KNOWN_HOOK_SCRIPTS,
          `${name} has no script in this checkout, so it must not be listed yet`,
        ).not.toContain(name)
      } else {
        expect(
          KNOWN_HOOK_SCRIPTS,
          `${name} now exists -- the union rule applies, add it to the array`,
        ).toContain(name)
      }
    }
  })
})
