// The blast-radius guard must be wired by the SCAFFOLD, not by hand (card 398f351b).
//
// The guard's own behaviour is proven by scripts/hooks/blast-radius-guard.selftest.py
// (19 cases, mutation-checked). This file covers the half that rots silently: whether
// every agent actually HAS the hook, and whether it is pointed at the tools that
// matter. Both halves have a documented failure history here -- 5 of 13 agents ran
// unguarded after the npm guard was hand-copied (card 0fa54550), and the egress gate
// reached nobody for a while because a stale matcher counted as "wired" (card 91c4a369).
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectBlastRadiusGuard, BLAST_RADIUS_GUARD_MATCHER } from '../web/agent-scaffold.js'
import { REPO_UNDER_TMP, TMP_SKIP_REASON } from './helpers/repo-location.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGENTS_DIR = join(REPO_ROOT, 'agents')

const preToolUse = (s: Record<string, unknown>): unknown[] =>
  ((s.hooks as Record<string, unknown>)?.PreToolUse as unknown[]) ?? []
const guardEntries = (s: Record<string, unknown>): unknown[] =>
  preToolUse(s).filter((e) => JSON.stringify(e).includes('blast-radius-guard.py'))

// Same /tmp caveat as its git/npm siblings: the injector runs its own path through
// isUnsafeHookCommand, so from a /tmp worktree it correctly refuses to register.
describe.skipIf(REPO_UNDER_TMP)('injectBlastRadiusGuard', () => {
  it('adds a PreToolUse hook pointing at the guard', () => {
    const s: Record<string, unknown> = {}
    injectBlastRadiusGuard(s)
    const entries = guardEntries(s)
    expect(entries).toHaveLength(1)
    expect(JSON.stringify(entries[0])).toContain('blast-radius-guard.py')
  })

  // The whole point of this guard is the file-editing tools. A Bash matcher --
  // correct for its git/npm siblings -- would make it fire on nothing it cares about.
  it('matches the file-editing tools, not Bash', () => {
    const s: Record<string, unknown> = {}
    injectBlastRadiusGuard(s)
    const matcher = (guardEntries(s)[0] as { matcher: string }).matcher
    expect(matcher).toBe(BLAST_RADIUS_GUARD_MATCHER)
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      expect(new RegExp(`^(${matcher})$`).test(tool)).toBe(true)
    }
    expect(new RegExp(`^(${matcher})$`).test('Bash')).toBe(false)
  })

  it('is IDEMPOTENT -- a respawn re-runs it and must not accumulate duplicates', () => {
    const s: Record<string, unknown> = {}
    injectBlastRadiusGuard(s)
    injectBlastRadiusGuard(s)
    injectBlastRadiusGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
  })

  it('does NOT displace the git and npm guards -- all three coexist', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/git-protect-guard.py"' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/npm-protect-guard.py"' }] },
        ],
      },
    }
    injectBlastRadiusGuard(s)
    const all = JSON.stringify(preToolUse(s))
    expect(all).toContain('git-protect-guard.py')
    expect(all).toContain('npm-protect-guard.py')
    expect(all).toContain('blast-radius-guard.py')
  })

  it('replaces a stale entry in place rather than adding a second one', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { matcher: 'Write', hooks: [{ type: 'command', command: 'python3 "/old/scripts/hooks/blast-radius-guard.py"' }] },
        ],
      },
    }
    injectBlastRadiusGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
    expect(JSON.stringify(preToolUse(s))).not.toContain('/old/scripts')
  })

  it('preserves unrelated PreToolUse entries and other hook events', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other-gate.mjs' }] }],
      },
    }
    injectBlastRadiusGuard(s)
    expect(JSON.stringify(preToolUse(s))).toContain('other-gate.mjs')
    expect((s.hooks as Record<string, unknown>).PreCompact).toBeDefined()
  })

  it('creates the hooks object when settings.json has none at all', () => {
    const s: Record<string, unknown> = { effortLevel: 'high' }
    injectBlastRadiusGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
    expect(s.effortLevel).toBe('high')
  })
})

// Always runs, so a log can never be ambiguous about whether the suite above was armed.
describe('tmp-checkout env gate (always runs)', () => {
  it('reports whether the injector suite in this file was armed or skipped', () => {
    console.log(REPO_UNDER_TMP
      ? `[blast-radius-guard-wiring.test.ts] SKIPPED injector suite -- ${TMP_SKIP_REASON}`
      : '[blast-radius-guard-wiring.test.ts] ARMED -- checkout is outside /tmp, injector assertions ran.')
    expect(typeof REPO_UNDER_TMP).toBe('boolean')
  })
})

// A hook pointing at a missing file is a hook that never runs, and nothing else here
// would notice. Same for the measurement library the guard imports at runtime.
describe('the files the injector points at', () => {
  it('the guard script exists and is executable', () => {
    const p = join(REPO_ROOT, 'scripts', 'hooks', 'blast-radius-guard.py')
    expect(existsSync(p)).toBe(true)
    expect(statSync(p).mode & 0o111).toBeGreaterThan(0)
  })

  it('ships its own self-test', () => {
    expect(existsSync(join(REPO_ROOT, 'scripts', 'hooks', 'blast-radius-guard.selftest.py'))).toBe(true)
  })

  // The guard resolves this from its own location at runtime; if it moves or is
  // renamed the guard silently fails open and stops enforcing anything.
  it('the measurement entry point exists next to it', () => {
    const p = join(REPO_ROOT, 'store', 'blast-radius-check.py')
    expect(existsSync(p)).toBe(true)
    expect(statSync(p).mode & 0o111).toBeGreaterThan(0)
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
    console.log(AGENTS.length > 0
      ? `[blast-radius-guard-wiring] ARMED -- checking ${AGENTS.length} scaffolded agent(s) on disk.`
      : '[blast-radius-guard-wiring] SKIPPED on-disk checks -- agents/ is gitignored and empty here.')
    expect(Array.isArray(AGENTS)).toBe(true)
  })
})

describe.skipIf(AGENTS.length === 0 || REPO_UNDER_TMP)('every scaffolded agent has the guard on disk', () => {
  it.each(AGENTS)('%s references the blast-radius guard exactly once, with the current matcher', (agent) => {
    const raw = readFileSync(join(AGENTS_DIR, agent, '.claude', 'settings.json'), 'utf-8')
    const matches = (JSON.parse(raw).hooks?.PreToolUse ?? []).filter((e: unknown) =>
      JSON.stringify(e).includes('blast-radius-guard.py'),
    )
    expect(matches).toHaveLength(1)
    expect((matches[0] as { matcher?: string }).matcher).toBe(BLAST_RADIUS_GUARD_MATCHER)
  })
})
