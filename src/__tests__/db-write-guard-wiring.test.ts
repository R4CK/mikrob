// The db-write-guard must be wired by the SCAFFOLD, not by hand (card c1766c6c, 7391f09a follow-up).
// Same reasoning as git-protect-guard-wiring.test.ts: a guard that is hand-copied into N
// settings.json files protects an arbitrary subset, and a respawn regenerates settings.json and
// would silently drop a hand-added block.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectDbWriteGuard } from '../web/agent-scaffold.js'
import { REPO_UNDER_TMP, TMP_SKIP_REASON } from './helpers/repo-location.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGENTS_DIR = join(REPO_ROOT, 'agents')

const preToolUse = (s: Record<string, unknown>): unknown[] =>
  ((s.hooks as Record<string, unknown>)?.PreToolUse as unknown[]) ?? []
const guardEntries = (s: Record<string, unknown>): unknown[] =>
  preToolUse(s).filter((e) => JSON.stringify(e).includes('db-write-guard.py'))

describe.skipIf(REPO_UNDER_TMP)('injectDbWriteGuard', () => {
  it('adds a Bash|Write|Edit|MultiEdit-matched PreToolUse hook pointing at the guard', () => {
    const s: Record<string, unknown> = {}
    injectDbWriteGuard(s)
    const entries = guardEntries(s)
    expect(entries).toHaveLength(1)
    expect(JSON.stringify(entries[0])).toContain('db-write-guard.py')
    // N2 (CYBERSEC NO-GO 28718/28723, card c1766c6c re-gate round 4): "Bash" alone made the
    // hook's own Write/Edit/MultiEdit protection dead code -- the harness never called it for
    // those tools. This assertion fails if the matcher ever regresses back to "Bash" alone.
    expect((entries[0] as { matcher: string }).matcher).toBe('Bash|Write|Edit|MultiEdit')
  })

  it('is IDEMPOTENT -- a respawn re-runs it and must not accumulate duplicates', () => {
    const s: Record<string, unknown> = {}
    injectDbWriteGuard(s)
    injectDbWriteGuard(s)
    injectDbWriteGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
  })

  it('preserves unrelated PreToolUse entries and other hook events', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other-gate.mjs' }] }],
      },
    }
    injectDbWriteGuard(s)
    const all = JSON.stringify(preToolUse(s))
    expect(all).toContain('other-gate.mjs') // the sibling gate survives
    expect(all).toContain('db-write-guard.py')
    expect((s.hooks as Record<string, unknown>).PreCompact).toBeDefined()
  })

  it('creates the hooks object when settings.json has none at all', () => {
    const s: Record<string, unknown> = { effortLevel: 'high' }
    injectDbWriteGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
    expect(s.effortLevel).toBe('high') // untouched
  })
})

describe('tmp-checkout env gate (always runs)', () => {
  it('reports whether the injectDbWriteGuard suite in this file was armed or skipped', () => {
    if (REPO_UNDER_TMP) {
      console.log(`[db-write-guard-wiring.test.ts] SKIPPED injectDbWriteGuard suite -- ${TMP_SKIP_REASON}`)
    } else {
      console.log('[db-write-guard-wiring.test.ts] ARMED -- checkout is outside /tmp, injector assertions ran.')
    }
    expect(typeof REPO_UNDER_TMP).toBe('boolean')
  })
})

// `.claude/settings.json` at the repo root is the tracked template; this half checks it actually
// names the guard (Kesz-ha point 3), the same way agents/ on-disk settings are checked elsewhere.
describe('root .claude/settings.json names the guard', () => {
  it('references db-write-guard.py in a Bash-matched PreToolUse hook', () => {
    const rootSettings = JSON.parse(
      readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf-8'),
    ) as Record<string, unknown>
    expect(guardEntries(rootSettings)).toHaveLength(1)
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
        ? `[db-write-guard-wiring] ARMED -- checking ${AGENTS.length} scaffolded agent(s) on disk.`
        : '[db-write-guard-wiring] SKIPPED on-disk checks -- agents/ is gitignored and empty here ' +
          '(fresh clone / CI). The injector suite above still ran.',
    )
    expect(Array.isArray(AGENTS)).toBe(true)
  })
})

describe.skipIf(AGENTS.length === 0)('every scaffolded agent has the guard on disk (backfill)', () => {
  const agents = AGENTS

  it.each(agents)('%s references the db-write guard exactly once', (agent) => {
    const s = JSON.parse(
      readFileSync(join(AGENTS_DIR, agent, '.claude', 'settings.json'), 'utf-8'),
    ) as Record<string, unknown>
    expect(guardEntries(s)).toHaveLength(1)
  })
})
