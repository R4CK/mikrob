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
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KNOWN_HOOK_SCRIPTS, pruneStaleHookEntries } from '../web/hook-registration-guard.js'
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
    // Not a preference: while the files are absent, listing them arms the pruner against an install
    // that has the ENTRY but not the FILE -- this checkout before the merge -- and the deleted
    // registration is never written back. If a later merge brings the scripts, this expectation is
    // what should be updated -- together with adding the names, in the same commit.
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

  // --- card 38c5e758: the nine Bash-matcher gates, and WHY listing them is not cosmetic ---------
  // The rationale for adding them rests on a measured claim about exit codes, so the claim is
  // executed here rather than asserted in the comment beside the names.
  const BASH_MATCHER_GATES = [
    'egress-gate.mjs',
    'kanban-write-gate.mjs',
    'git-protect-guard.py',
    'npm-protect-guard.py',
    'cd-chain-guard.py',
    'noisy-command-guard.py',
    'blast-radius-guard.py',
    'symlinked-node-modules-guard.py',
    'pentest-tool-install-guard.py',
  ]

  it.each(BASH_MATCHER_GATES.map((g) => [g]))(
    '%s is listed, so a stale entry for it can be self-healed',
    (name) => {
      expect(KNOWN_HOOK_SCRIPTS).toContain(name)
      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: `python3 "/opt/app/scripts/hooks/${name}"` }],
            },
          ],
        },
      }
      const res = pruneStaleHookEntries(settings, { fileExists: () => false })
      expect(
        res.removed.join(' '),
        `a settings entry naming ${name} whose file is gone must be prunable -- while the name is ` +
          'absent from the list the entry reads as foreign and is kept for ever',
      ).toContain(name)
    },
  )

  it('the reason it matters: a missing .py hook exits with the BLOCKING status, .mjs does not', () => {
    // The seven python gates are wired as a bare `python3 "<abs path>"`, with no `[ -f ]` wrapper.
    // PreToolUse treats exit 2 as a block and every other status as non-blocking, so a missing
    // script file does not degrade those gates -- it stops the agent's every Bash call. That is
    // what makes an unprunable stale entry a wedge rather than an untidiness.
    const py = spawnSync('python3', ['/nonexistent/definitely-not-here.py'], { encoding: 'utf-8' })
    expect(
      py.status,
      'if this is no longer 2, the comment on the array overstates the risk and should be reworded',
    ).toBe(2)

    // The other half of the asymmetry, which is why the two .mjs gates really did err safe.
    const mjs = spawnSync(process.execPath, ['/nonexistent/definitely-not-here.mjs'], {
      encoding: 'utf-8',
    })
    expect(mjs.status).not.toBe(2)
  })

  // The paragraph above the array states WHICH install an early listing would hurt. That direction
  // was written backwards once already, and a confident wrong direction is worse than none: it
  // tells the next maintainer to wait for the wrong signal. So it is executed here.
  it('the deferral reasoning, executed: the entry-without-file install is the one at risk', () => {
    const settingsNaming = (script: string) => ({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: `python3 "/opt/app/scripts/hooks/${script}"` }],
          },
        ],
      },
    })
    const listed = { knownScripts: ['clear-capture.py'] as const }

    // Listed + file MISSING -> the registration is DELETED. This is the install the deferral
    // protects: it carries upstream's entry while this checkout has no script yet.
    const atRisk = pruneStaleHookEntries(settingsNaming('clear-capture.py'), {
      ...listed,
      fileExists: () => false,
    })
    expect(atRisk.changed).toBe(true)
    expect(atRisk.removed.join(' ')).toContain('clear-capture.py')

    // Listed + file PRESENT -> untouched. An install that HAS the script is NOT the population at
    // risk; claiming it was is precisely the inversion this test exists to prevent.
    const safe = pruneStaleHookEntries(settingsNaming('clear-capture.py'), {
      ...listed,
      fileExists: () => true,
    })
    expect(safe.changed).toBe(false)
    expect(safe.removed).toHaveLength(0)
  })
})
