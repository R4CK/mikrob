// The git-protect guard must be wired by the SCAFFOLD, not by hand (card 0fa54550).
//
// Cybered found the drift on the 6b532950 gate: 8 of 13 agents' settings.json referenced the guard
// and 5 did not, because nothing in agent-scaffold.ts wired it -- the 8 had been hand-edited. Two
// consequences, both invisible: a respawn regenerates settings.json and would silently drop the
// hand-added block, and every NEWLY created agent started unprotected. The asymmetry is the danger:
// the fleet looks guarded while an arbitrary subset is not.
//
// So this file tests the INJECTOR (the durable fix) as well as the current on-disk state (the
// backfill). Testing only the files on disk would pass again the moment someone re-scaffolds.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectGitProtectGuard } from '../web/agent-scaffold.js'
import { REPO_UNDER_TMP, TMP_SKIP_REASON } from './helpers/repo-location.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGENTS_DIR = join(REPO_ROOT, 'agents')

const preToolUse = (s: Record<string, unknown>): unknown[] =>
  ((s.hooks as Record<string, unknown>)?.PreToolUse as unknown[]) ?? []
const guardEntries = (s: Record<string, unknown>): unknown[] =>
  preToolUse(s).filter((e) => JSON.stringify(e).includes('git-protect-guard.py'))

// injectGitProtectGuard derives its script path from PROJECT_ROOT and runs it through
// isUnsafeHookCommand, so from a /tmp worktree the registration guard correctly rejects its own
// script and every assertion below goes red for a reason unrelated to the code under test (see
// helpers/repo-location.ts).
describe.skipIf(REPO_UNDER_TMP)('injectGitProtectGuard', () => {
  it('adds a Bash-matched PreToolUse hook pointing at the guard', () => {
    const s: Record<string, unknown> = {}
    injectGitProtectGuard(s)
    const entries = guardEntries(s)
    expect(entries).toHaveLength(1)
    expect(JSON.stringify(entries[0])).toContain('git-protect-guard.py')
    expect((entries[0] as { matcher: string }).matcher).toBe('Bash')
  })

  it('is IDEMPOTENT -- a respawn re-runs it and must not accumulate duplicates', () => {
    const s: Record<string, unknown> = {}
    injectGitProtectGuard(s)
    injectGitProtectGuard(s)
    injectGitProtectGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
  })

  it('preserves unrelated PreToolUse entries and other hook events', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other-gate.mjs' }] }],
      },
    }
    injectGitProtectGuard(s)
    const all = JSON.stringify(preToolUse(s))
    expect(all).toContain('other-gate.mjs') // the sibling gate survives
    expect(all).toContain('git-protect-guard.py')
    expect((s.hooks as Record<string, unknown>).PreCompact).toBeDefined()
  })

  it('creates the hooks object when settings.json has none at all', () => {
    const s: Record<string, unknown> = { effortLevel: 'high' }
    injectGitProtectGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
    expect(s.effortLevel).toBe('high') // untouched
  })
})

// Always runs: a CI log must never be ambiguous about whether the injector suite above was armed
// or skipped (card 252e36d3 -- 13 phantom "failures" were once tracked as a real red baseline).
describe('tmp-checkout env gate (always runs)', () => {
  it('reports whether the injectGitProtectGuard suite in this file was armed or skipped', () => {
    if (REPO_UNDER_TMP) {
      console.log(`[git-protect-guard-wiring.test.ts] SKIPPED injectGitProtectGuard suite -- ${TMP_SKIP_REASON}`)
    } else {
      console.log('[git-protect-guard-wiring.test.ts] ARMED -- checkout is outside /tmp, injector assertions ran.')
    }
    expect(typeof REPO_UNDER_TMP).toBe('boolean')
  })
})

// `agents/` is GITIGNORED -- those settings.json files are generated runtime state, not source. So
// this half only has anything to check on a LIVE install; a fresh clone or CI has an empty agents/
// dir and must not go red for it. The injector suite above is the part that protects a fresh
// checkout, and it always runs. The meta-test below states which case happened, so an empty run is
// never silently mistaken for a passing one.
const AGENTS = existsSync(AGENTS_DIR)
  ? readdirSync(AGENTS_DIR).filter((a) => {
      const dir = join(AGENTS_DIR, a)
      return statSync(dir).isDirectory() && existsSync(join(dir, '.claude', 'settings.json'))
    })
  : []

describe('agents/ scan gate (always runs)', () => {
  it('reports whether the on-disk backfill checks were armed', () => {
    console.log(
      AGENTS.length > 0
        ? `[git-protect-guard-wiring] ARMED -- checking ${AGENTS.length} scaffolded agent(s) on disk.`
        : '[git-protect-guard-wiring] SKIPPED on-disk checks -- agents/ is gitignored and empty here ' +
          '(fresh clone / CI). The injector suite above still ran.',
    )
    expect(Array.isArray(AGENTS)).toBe(true)
  })
})

describe.skipIf(AGENTS.length === 0)('every scaffolded agent has the guard on disk (backfill)', () => {
  const agents = AGENTS

  it.each(agents)('%s references the git-protect guard exactly once', (agent) => {
    const s = JSON.parse(
      readFileSync(join(AGENTS_DIR, agent, '.claude', 'settings.json'), 'utf-8'),
    ) as Record<string, unknown>
    // Exactly once: zero = unprotected, more than one = the hook fires repeatedly per Bash call.
    expect(guardEntries(s)).toHaveLength(1)
  })

  it('NO agent is left out -- the asymmetry itself is the finding', () => {
    const missing = agents.filter((a) => {
      const s = JSON.parse(
        readFileSync(join(AGENTS_DIR, a, '.claude', 'settings.json'), 'utf-8'),
      ) as Record<string, unknown>
      return guardEntries(s).length === 0
    })
    expect(missing, `unprotected agents: ${missing.join(', ')}`).toEqual([])
  })
})
