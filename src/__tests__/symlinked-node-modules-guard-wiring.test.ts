// The symlinked-node-modules guard must be wired by the SCAFFOLD, not by hand (card 9dc0fba8).
//
// The guard's own behaviour is proven by scripts/hooks/symlinked-node-modules-guard.selftest.py,
// which builds a REAL fixture (a fake shared clone plus a worktree whose apps/web/node_modules is a
// directory symlink into it), reproduces the incident, and then exercises 18 block/allow cases.
// This file covers the other half -- whether every agent actually HAS the hook. Same rot the npm
// sibling documents (card 0fa54550: 5 of 13 agents silently unguarded), and the incident this
// guards recurred within the same hour, so partial coverage is not coverage.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectSymlinkedNodeModulesGuard } from '../web/agent-scaffold.js'
import { REPO_UNDER_TMP, TMP_SKIP_REASON } from './helpers/repo-location.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGENTS_DIR = join(REPO_ROOT, 'agents')
const GUARD = 'symlinked-node-modules-guard.py'

const preToolUse = (s: Record<string, unknown>): unknown[] =>
  ((s.hooks as Record<string, unknown>)?.PreToolUse as unknown[]) ?? []
const guardEntries = (s: Record<string, unknown>): unknown[] =>
  preToolUse(s).filter((e) => JSON.stringify(e).includes(GUARD))

// Same /tmp caveat as its siblings: the injector runs its own path through isUnsafeHookCommand, so
// from a /tmp worktree it correctly refuses to register and every assertion would go red for a
// reason unrelated to the code under test.
describe.skipIf(REPO_UNDER_TMP)('injectSymlinkedNodeModulesGuard', () => {
  it('adds a Bash-matched PreToolUse hook pointing at the guard', () => {
    const s: Record<string, unknown> = {}
    injectSymlinkedNodeModulesGuard(s)
    const entries = guardEntries(s)
    expect(entries).toHaveLength(1)
    expect(JSON.stringify(entries[0])).toContain(GUARD)
    expect((entries[0] as { matcher: string }).matcher).toBe('Bash')
  })

  it('is IDEMPOTENT -- a respawn re-runs it and must not accumulate duplicates', () => {
    const s: Record<string, unknown> = {}
    injectSymlinkedNodeModulesGuard(s)
    injectSymlinkedNodeModulesGuard(s)
    injectSymlinkedNodeModulesGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
  })

  it('coexists with the npm guard rather than displacing it -- they catch different shapes', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/npm-protect-guard.py"' }] },
        ],
      },
    }
    injectSymlinkedNodeModulesGuard(s)
    const all = JSON.stringify(preToolUse(s))
    expect(all).toContain('npm-protect-guard.py')
    expect(all).toContain(GUARD)
  })

  it('preserves unrelated PreToolUse entries and other hook events', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other-gate.mjs' }] }],
      },
    }
    injectSymlinkedNodeModulesGuard(s)
    expect(JSON.stringify(preToolUse(s))).toContain('other-gate.mjs')
    expect((s.hooks as Record<string, unknown>).PreCompact).toBeDefined()
  })

  it('creates the hooks object when settings.json has none at all', () => {
    const s: Record<string, unknown> = { effortLevel: 'high' }
    injectSymlinkedNodeModulesGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
    expect(s.effortLevel).toBe('high')
  })
})

describe('tmp-checkout env gate (always runs)', () => {
  it('reports whether the injector suite in this file was armed or skipped', () => {
    if (REPO_UNDER_TMP) {
      console.log(`[symlinked-node-modules-guard-wiring.test.ts] SKIPPED injector suite -- ${TMP_SKIP_REASON}`)
    } else {
      console.log('[symlinked-node-modules-guard-wiring.test.ts] ARMED -- injector assertions ran.')
    }
    expect(typeof REPO_UNDER_TMP).toBe('boolean')
  })
})

// A hook pointing at a missing file is a hook that never runs, and nothing else here would notice.
describe('the guard script the injector points at', () => {
  it('exists and is executable', () => {
    const p = join(REPO_ROOT, 'scripts', 'hooks', GUARD)
    expect(existsSync(p)).toBe(true)
    expect(statSync(p).mode & 0o111).toBeGreaterThan(0)
  })

  it('ships its own self-test', () => {
    expect(existsSync(join(REPO_ROOT, 'scripts', 'hooks', 'symlinked-node-modules-guard.selftest.py'))).toBe(true)
  })
})

// The safe replacement the guard's block message points agents at must exist and be runnable --
// a guard that says "use X instead" while X is missing just leaves people stuck.
describe('the safe gate-worktree script the guard recommends', () => {
  it('exists and is executable', () => {
    const p = join(REPO_ROOT, 'store', 'cc-gate-worktree.sh')
    expect(existsSync(p)).toBe(true)
    expect(statSync(p).mode & 0o111).toBeGreaterThan(0)
  })

  it('never creates a DIRECTORY symlink for node_modules -- that is the shape it exists to remove', () => {
    const src = readFileSync(join(REPO_ROOT, 'store', 'cc-gate-worktree.sh'), 'utf-8')
    // The only ln -s targets are individual entries; a `ln -s <main>/x/node_modules <wt>/x/node_modules`
    // would reintroduce the incident.
    expect(src).not.toMatch(/ln -s[^\n]*\$MAIN[^\n]*\/node_modules"?\s*"?\$TREE/)
    expect(src).toContain('mkdir -p "$dst"')
  })

  it('refuses to run a dependency installer', () => {
    const src = readFileSync(join(REPO_ROOT, 'store', 'cc-gate-worktree.sh'), 'utf-8')
    expect(src).not.toMatch(/^\s*(pnpm|npm|yarn)\s+(install|ci|add)/m)
  })
})

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
        ? `[symlinked-node-modules-guard-wiring] ARMED -- checking ${AGENTS.length} scaffolded agent(s) on disk.`
        : '[symlinked-node-modules-guard-wiring] SKIPPED on-disk checks -- agents/ is gitignored and empty here.',
    )
    expect(Array.isArray(AGENTS)).toBe(true)
  })
})

const guardCount = (agent: string): number => {
  const raw = readFileSync(join(AGENTS_DIR, agent, '.claude', 'settings.json'), 'utf-8')
  return (JSON.parse(raw).hooks?.PreToolUse ?? []).filter((e: unknown) =>
    JSON.stringify(e).includes(GUARD),
  ).length
}

// ROLLOUT WINDOW, stated rather than papered over. ensureSymlinkedNodeModulesGuard runs in the
// dashboard's startup migration loop, so between landing this commit and the next dist rebuild +
// dashboard restart NO agent has the hook on disk yet. A flat "every agent has it" assertion would
// therefore be red for every agent's landing during that window (fleet-test.sh runs on each land),
// which is its own outage class -- see the fork-upstream-conflict-guard incident where one red
// guard blocked the whole fleet from landing.
//
// So the split is: duplicates are ALWAYS wrong (that is a real defect at any time), and full
// coverage is asserted once the rollout has actually started. That still catches the failure this
// file exists for -- card 0fa54550's PARTIAL coverage, 5 of 13 agents silently unguarded -- because
// a partially rolled-out fleet has some agents at 1 and some at 0, which fails the second block.
describe.skipIf(AGENTS.length === 0 || REPO_UNDER_TMP)('scaffolded agents on disk', () => {
  it.each(AGENTS)('%s never has a DUPLICATE guard entry', (agent) => {
    expect(guardCount(agent)).toBeLessThanOrEqual(1)
  })

  it('has either NO agent wired yet (pre-rollout) or ALL of them -- never a partial fleet', () => {
    const wired = AGENTS.filter((a) => guardCount(a) === 1)
    if (wired.length === 0) {
      console.log(
        `[symlinked-node-modules-guard-wiring] PRE-ROLLOUT -- 0/${AGENTS.length} agents wired. ` +
        'Rebuild dist and restart the dashboard to run ensureSymlinkedNodeModulesGuard.',
      )
      expect(wired).toHaveLength(0)
      return
    }
    expect(wired).toHaveLength(AGENTS.length)
  })
})
