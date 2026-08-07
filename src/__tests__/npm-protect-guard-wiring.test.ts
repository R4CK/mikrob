// The npm-protect guard must be wired by the SCAFFOLD, not by hand (card 0e135261).
//
// The guard itself is proven by scripts/hooks/npm-protect-guard.selftest.py, which builds a fake
// checkout and exercises 40 block/allow cases. This file covers the OTHER half, the one that
// silently rotted last time (card 0fa54550): whether every agent actually HAS the hook. A guard
// hand-added to some settings.json files looks like protection while an arbitrary subset runs
// unguarded, and a respawn regenerates settings.json and drops the hand-added block.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectNpmProtectGuard } from '../web/agent-scaffold.js'
import { REPO_UNDER_TMP, TMP_SKIP_REASON } from './helpers/repo-location.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGENTS_DIR = join(REPO_ROOT, 'agents')

const preToolUse = (s: Record<string, unknown>): unknown[] =>
  ((s.hooks as Record<string, unknown>)?.PreToolUse as unknown[]) ?? []
const guardEntries = (s: Record<string, unknown>): unknown[] =>
  preToolUse(s).filter((e) => JSON.stringify(e).includes('npm-protect-guard.py'))

// Same /tmp caveat as its git sibling: the injector runs its own path through isUnsafeHookCommand,
// so from a /tmp worktree it correctly refuses to register and every assertion would go red for a
// reason unrelated to the code under test.
describe.skipIf(REPO_UNDER_TMP)('injectNpmProtectGuard', () => {
  it('adds a Bash-matched PreToolUse hook pointing at the guard', () => {
    const s: Record<string, unknown> = {}
    injectNpmProtectGuard(s)
    const entries = guardEntries(s)
    expect(entries).toHaveLength(1)
    expect(JSON.stringify(entries[0])).toContain('npm-protect-guard.py')
    expect((entries[0] as { matcher: string }).matcher).toBe('Bash')
  })

  it('is IDEMPOTENT -- a respawn re-runs it and must not accumulate duplicates', () => {
    const s: Record<string, unknown> = {}
    injectNpmProtectGuard(s)
    injectNpmProtectGuard(s)
    injectNpmProtectGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
  })

  it('does NOT displace the git guard -- the two coexist', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/git-protect-guard.py"' }] },
        ],
      },
    }
    injectNpmProtectGuard(s)
    const all = JSON.stringify(preToolUse(s))
    expect(all).toContain('git-protect-guard.py')
    expect(all).toContain('npm-protect-guard.py')
  })

  it('preserves unrelated PreToolUse entries and other hook events', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other-gate.mjs' }] }],
      },
    }
    injectNpmProtectGuard(s)
    expect(JSON.stringify(preToolUse(s))).toContain('other-gate.mjs')
    expect((s.hooks as Record<string, unknown>).PreCompact).toBeDefined()
  })

  it('creates the hooks object when settings.json has none at all', () => {
    const s: Record<string, unknown> = { effortLevel: 'high' }
    injectNpmProtectGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
    expect(s.effortLevel).toBe('high')
  })
})

// Always runs, so a log can never be ambiguous about whether the suite above was armed.
describe('tmp-checkout env gate (always runs)', () => {
  it('reports whether the injectNpmProtectGuard suite in this file was armed or skipped', () => {
    if (REPO_UNDER_TMP) {
      console.log(`[npm-protect-guard-wiring.test.ts] SKIPPED injector suite -- ${TMP_SKIP_REASON}`)
    } else {
      console.log('[npm-protect-guard-wiring.test.ts] ARMED -- checkout is outside /tmp, injector assertions ran.')
    }
    expect(typeof REPO_UNDER_TMP).toBe('boolean')
  })
})

// The guard script must actually exist at the path the injector writes -- a hook pointing at a
// missing file is a hook that never runs, and nothing else here would notice.
describe('the guard script the injector points at', () => {
  it('exists and is executable', () => {
    const p = join(REPO_ROOT, 'scripts', 'hooks', 'npm-protect-guard.py')
    expect(existsSync(p)).toBe(true)
    expect(statSync(p).mode & 0o111).toBeGreaterThan(0)
  })

  it('ships its own self-test', () => {
    expect(existsSync(join(REPO_ROOT, 'scripts', 'hooks', 'npm-protect-guard.selftest.py'))).toBe(true)
  })
})

// agents/ is gitignored runtime state: only a LIVE install has anything to check here.
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
        ? `[npm-protect-guard-wiring] ARMED -- checking ${AGENTS.length} scaffolded agent(s) on disk.`
        : '[npm-protect-guard-wiring] SKIPPED on-disk checks -- agents/ is gitignored and empty here.',
    )
    expect(Array.isArray(AGENTS)).toBe(true)
  })
})

describe.skipIf(AGENTS.length === 0 || REPO_UNDER_TMP)('every scaffolded agent has the guard on disk', () => {
  it.each(AGENTS)('%s references the npm-protect guard exactly once', (agent) => {
    const raw = readFileSync(join(AGENTS_DIR, agent, '.claude', 'settings.json'), 'utf-8')
    const matches = (JSON.parse(raw).hooks?.PreToolUse ?? []).filter((e: unknown) =>
      JSON.stringify(e).includes('npm-protect-guard.py'),
    )
    expect(matches).toHaveLength(1)
  })
})
