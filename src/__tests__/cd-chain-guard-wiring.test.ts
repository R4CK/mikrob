// The cd-chain guard must be wired by the SCAFFOLD, not by hand (cards a1b2a1de + 6b32a478).
//
// The guard's own behaviour is proven by scripts/hooks/cd-chain-guard.selftest.py, which this file
// RUNS so its cases are enforced here rather than only when someone remembers to invoke it. What
// this file adds is the half that rots silently: whether every agent actually HAS the hook.
//
// That half has a fresh, measured failure right next door. noisy-command-guard.py -- the newest
// block-and-suggest guard before this one -- has no inject*/ensure* anywhere in the codebase: it
// reached the fleet only where somebody hand-edited a settings.json. Measured 2026-09-04: three
// agents (marketing, penzugy, videooo) never got it, and a newly created agent would not either.
// CLAUDE.md rule 15 describes it as an armed control regardless. Same class as the npm guard
// leaving 5 of 13 agents unguarded (card 0fa54550). So the guard here is wired on both paths --
// settings generation AND the boot backfill -- and this file pins that.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectCdChainGuard } from '../web/agent-scaffold.js'
import { REPO_UNDER_TMP, TMP_SKIP_REASON } from './helpers/repo-location.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GUARD = join(REPO_ROOT, 'scripts', 'hooks', 'cd-chain-guard.py')
const SELFTEST = join(REPO_ROOT, 'scripts', 'hooks', 'cd-chain-guard.selftest.py')

const preToolUse = (s: Record<string, unknown>): unknown[] =>
  ((s.hooks as Record<string, unknown>)?.PreToolUse as unknown[]) ?? []
const guardEntries = (s: Record<string, unknown>): unknown[] =>
  preToolUse(s).filter((e) => JSON.stringify(e).includes('cd-chain-guard.py'))

// Same /tmp caveat as its git/npm/blast siblings: the injector runs its own path through
// isUnsafeHookCommand, so from a /tmp worktree it correctly refuses to register.
describe.skipIf(REPO_UNDER_TMP)('injectCdChainGuard', () => {
  it('adds a PreToolUse hook pointing at the guard', () => {
    const s: Record<string, unknown> = {}
    injectCdChainGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
  })

  it('matches Bash -- the tool the wedge happens on', () => {
    const s: Record<string, unknown> = {}
    injectCdChainGuard(s)
    const matcher = (guardEntries(s)[0] as { matcher: string }).matcher
    expect(new RegExp(`^(${matcher})$`).test('Bash')).toBe(true)
    // Not the file tools: `cd` is a shell construct, so a Write/Edit matcher would fire on
    // nothing this guard cares about (the stale-matcher lesson, card 91c4a369).
    expect(new RegExp(`^(${matcher})$`).test('Edit')).toBe(false)
  })

  it('is IDEMPOTENT -- a respawn re-runs it and must not accumulate duplicates', () => {
    const s: Record<string, unknown> = {}
    injectCdChainGuard(s)
    injectCdChainGuard(s)
    injectCdChainGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
  })

  it('replaces a stale entry in place rather than adding a second one', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/old/scripts/hooks/cd-chain-guard.py"' }] },
        ],
      },
    }
    injectCdChainGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
    expect(JSON.stringify(preToolUse(s))).not.toContain('/old/scripts')
  })

  it('does NOT displace its Bash-matched siblings -- they all coexist', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/git-protect-guard.py"' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/npm-protect-guard.py"' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/noisy-command-guard.py"' }] },
        ],
      },
    }
    injectCdChainGuard(s)
    const all = JSON.stringify(preToolUse(s))
    for (const sibling of ['git-protect-guard.py', 'npm-protect-guard.py', 'noisy-command-guard.py', 'cd-chain-guard.py']) {
      expect(all, sibling).toContain(sibling)
    }
  })

  it('preserves unrelated PreToolUse entries and other hook events', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other-gate.mjs' }] }],
      },
    }
    injectCdChainGuard(s)
    expect(JSON.stringify(preToolUse(s))).toContain('other-gate.mjs')
    expect((s.hooks as Record<string, unknown>).PreCompact).toBeDefined()
  })

  it('creates the hooks object when settings.json has none at all', () => {
    const s: Record<string, unknown> = { effortLevel: 'high' }
    injectCdChainGuard(s)
    expect(guardEntries(s)).toHaveLength(1)
    expect(s.effortLevel).toBe('high')
  })
})

// Always runs, so a log can never be ambiguous about whether the suite above was armed.
describe('tmp-checkout env gate (always runs)', () => {
  it('reports whether the injector suite in this file was armed or skipped', () => {
    console.log(REPO_UNDER_TMP
      ? `[cd-chain-guard-wiring.test.ts] SKIPPED injector suite -- ${TMP_SKIP_REASON}`
      : '[cd-chain-guard-wiring.test.ts] ARMED -- checkout is outside /tmp, injector assertions ran.')
    expect(typeof REPO_UNDER_TMP).toBe('boolean')
  })
})

// BOTH wiring paths, named explicitly. injectCdChainGuard alone reaches an agent only on the next
// respawn; ensureCdChainGuard alone reaches only agents that already have a settings.json. The
// noisy guard has NEITHER, which is why it covers 12 of 15 agents and no future one.
describe('the guard is wired on both paths, not just one', () => {
  it('the settings GENERATION path calls the injector', () => {
    const scaffold = readFileSync(join(REPO_ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(scaffold).toContain('injectCdChainGuard(existing)')
  })

  it('the boot BACKFILL loop calls the ensurer, so a restart arms agents that already exist', () => {
    const web = readFileSync(join(REPO_ROOT, 'src', 'web.ts'), 'utf-8')
    expect(web).toContain('ensureCdChainGuard(agentName)')
  })
})

// A hook pointing at a missing or unrunnable file is a hook that never runs, and nothing else here
// would notice.
describe('the files the injector points at', () => {
  it('the guard script exists and is executable', () => {
    expect(existsSync(GUARD)).toBe(true)
    expect(statSync(GUARD).mode & 0o111).toBeGreaterThan(0)
  })

  it('the selftest exists and PASSES -- its cases are enforced here, not on request', () => {
    expect(existsSync(SELFTEST)).toBe(true)
    const out = execFileSync('python3', [SELFTEST], { encoding: 'utf-8' })
    // Assert on a COUNTED number of cases, not the sentence: a harness that could report success
    // with zero cases would be worse than no harness (activity-capture selftest lesson).
    expect(out).toMatch(/All [1-9]\d* cases/)
  })
})

// The two shapes the guard exists for and the one it must never eat, driven through the real
// script. Duplicating a little of the selftest is deliberate: this is the layer that runs on every
// landing, and a guard whose block message stops naming the fix silently recreates the stall.
describe('end-to-end through the real hook', () => {
  const verdict = (command: string): { code: number; stderr: string } => {
    try {
      execFileSync('python3', [GUARD], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return { code: 0, stderr: '' }
    } catch (e) {
      const err = e as { status: number; stderr: string }
      return { code: err.status, stderr: err.stderr }
    }
  }

  it('blocks the measured wedge shape AND names the cd-free rewrite', () => {
    const r = verdict('cd /home/neon/wt && grep -rn "x" --include=*.ts .')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('/home/neon/wt')
    expect(r.stderr).toContain('CD_CHAIN_ALLOW=1')
  })

  it('leaves the rewrite it asks for alone -- otherwise the agent has nowhere to go', () => {
    expect(verdict('grep -rn "x" --include=*.ts /home/neon/wt').code).toBe(0)
  })

  it('leaves a non-read command after cd alone (scope is the measured class, not every cd)', () => {
    expect(verdict('cd /home/neon/wt && npm test').code).toBe(0)
  })
})
