// Card 86d5de34 F3 (WhiteHat CYBERSEC GO, msg 10474): store/session-memory-inject-agents.json's
// enabled_agents list named backend2, backend3 and logs, but the shared-memory-inject.py
// SessionStart hook was never wired into any of the three -- backend2's own seed-fleet-agents
// entry carried only taskstate-replay.py, and backend3/logs have no seed-fleet-agents directory
// at all, so a brand-new agent falls through to templates/settings.json.template (scaffoldAgentDir),
// which never had the hook either. Being on the enabled list does nothing if the hook that reads
// it never runs -- the flag was structurally inert for all three.
//
// Same shape as taskstate-replay-matcher.test.ts: a sandboxed unit-test section for the boot
// backfill function, then a static-file section that reads the REAL seed templates and the
// generic template so drift here is caught without needing a live install.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'shared-mem-inject-wiring-'))

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  // STORE_DIR is a top-level `const` in config.ts (join(PROJECT_ROOT, 'store')), computed once
  // when the REAL module body runs above (via `orig()`) -- overriding PROJECT_ROOT alone does NOT
  // retroactively move it, so it must be overridden explicitly too, or ensureSharedMemoryInject's
  // enabled_agents read falls through to the REAL (gitignored, often-absent-in-a-worktree)
  // store/session-memory-inject-agents.json instead of this test's sandboxed one.
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store'), MAIN_AGENT_ID: 'marveen' }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { ensureSharedMemoryInject } = await import('../web/agent-scaffold.js')

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const GATE_AGENTS = ['qa', 'qa2', 'cybersec', 'cybersec2', 'cybered']

function settingsPath(agent: string): string {
  return join(SANDBOX, 'agents', agent, '.claude', 'settings.json')
}

function seedAgent(agent: string, sessionStart: unknown): string {
  const p = settingsPath(agent)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify({ hooks: { SessionStart: sessionStart } }, null, 2))
  return p
}

function readSettings(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
}

function taskstateOnlyEntry() {
  return { matcher: 'startup|resume|compact|clear', hooks: [{ type: 'command', command: 'python3 /opt/marveen/scripts/hooks/taskstate-replay.py', timeout: 15 }] }
}

// RedHat NO-GO on f1309aae4 (dispatch 16908), F2: the backfill must only wire an agent that is
// actually on store/session-memory-inject-agents.json's enabled_agents list -- wiring an
// unlisted agent (elemzo, in the real fleet) contradicted this very test file's own
// "correctly bare" claim for it. Sandbox the config file the same way agent settings are
// sandboxed, so the unit tests below control exactly who is "enabled" instead of depending on
// the real fleet's list.
function seedEnabledAgents(names: string[]): void {
  mkdirSync(join(SANDBOX, 'store'), { recursive: true })
  writeFileSync(join(SANDBOX, 'store', 'session-memory-inject-agents.json'), JSON.stringify({ enabled_agents: names }))
}

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('ensureSharedMemoryInject (boot backfill, card 86d5de34 F3)', () => {
  beforeEach(() => {
    rmSync(join(SANDBOX, 'agents'), { recursive: true, force: true })
    seedEnabledAgents(['backend2'])
  })

  it('wires the hook from scratch for a non-gate agent that has none (backend2 repro)', () => {
    const p = seedAgent('backend2', [taskstateOnlyEntry()])
    expect(ensureSharedMemoryInject('backend2')).toBe(true)
    const ss = readSettings(p).hooks as { SessionStart: unknown[] }
    expect(JSON.stringify(ss.SessionStart)).toContain('shared-memory-inject.py')
    // the pre-existing entry is left in place, untouched
    expect(JSON.stringify(ss.SessionStart)).toContain('taskstate-replay.py')
  })

  it('is idempotent: a second pass changes nothing and says so', () => {
    seedAgent('backend2', [taskstateOnlyEntry()])
    ensureSharedMemoryInject('backend2')
    const after = readFileSync(settingsPath('backend2'), 'utf8')
    expect(ensureSharedMemoryInject('backend2')).toBe(false)
    expect(readFileSync(settingsPath('backend2'), 'utf8')).toBe(after)
  })

  it('does nothing if the hook is already wired', () => {
    const existing = {
      matcher: 'startup|resume|compact|clear',
      hooks: [{ type: 'command', command: 'python3 /opt/marveen/scripts/hooks/shared-memory-inject.py', timeout: 15 }],
    }
    const p = seedAgent('backend2', [taskstateOnlyEntry(), existing])
    const before = readFileSync(p, 'utf8')
    expect(ensureSharedMemoryInject('backend2')).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe(before)
  })

  it.each(GATE_AGENTS)('never touches a gate agent (%s): the gate-specific function owns that', (agent) => {
    seedEnabledAgents(['backend2', agent]) // enabled or not, a gate agent is excluded either way
    seedAgent(agent, [taskstateOnlyEntry()])
    expect(ensureSharedMemoryInject(agent)).toBe(false)
    expect(JSON.stringify(readSettings(settingsPath(agent)))).not.toContain('shared-memory-inject.py')
  })

  it('a missing settings.json is skipped, and none is created', () => {
    expect(ensureSharedMemoryInject('ghost')).toBe(false)
    expect(existsSync(settingsPath('ghost'))).toBe(false)
  })

  it('a malformed settings.json is skipped, not rewritten', () => {
    const p = settingsPath('broken')
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, '{ this is not json')
    expect(ensureSharedMemoryInject('broken')).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe('{ this is not json')
  })

  // RedHat F2 (dispatch 16908), red-first: an agent NOT on enabled_agents must stay untouched,
  // even though it otherwise qualifies (non-gate, has a settings.json, no hook yet) -- this is
  // elemzo's exact live shape.
  it('F2: an agent not on enabled_agents is left untouched (elemzo repro)', () => {
    seedEnabledAgents(['backend2']) // elemzo deliberately absent
    const p = seedAgent('elemzo', [taskstateOnlyEntry()])
    const before = readFileSync(p, 'utf8')
    expect(ensureSharedMemoryInject('elemzo')).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe(before)
  })

  // RedHat F2, the fail-safe-off default: a missing/unreadable config file means nobody is
  // enabled, same posture as shared-memory-inject.py's own _feature_enabled_agents().
  it('F2: a missing session-memory-inject-agents.json means nobody is enabled', () => {
    rmSync(join(SANDBOX, 'store', 'session-memory-inject-agents.json'), { force: true })
    const p = seedAgent('backend2', [taskstateOnlyEntry()])
    const before = readFileSync(p, 'utf8')
    expect(ensureSharedMemoryInject('backend2')).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe(before)
  })
})

// RedHat F1 (dispatch 16908), the #1305 class: this backfill must never reach the owner's
// user-global ~/.claude/settings.json, same refusal every other scaffold hook writer has
// (hook-scope-main-refusal.test.ts). agentSettingsPath(MAIN_AGENT_ID) resolves through
// node:os homedir() -- NOT PROJECT_ROOT -- so HOME itself is redirected per test (same pattern
// as hook-scope-main-refusal.test.ts), never the real operator home.
describe('ensureSharedMemoryInject refuses the main agent (RedHat F1 on f1309aae4)', () => {
  let fakeHome: string
  let realHome: string | undefined

  beforeEach(() => {
    realHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), 'shared-mem-inject-mainrefusal-'))
    process.env.HOME = fakeHome
    mkdirSync(join(fakeHome, '.claude'), { recursive: true })
  })

  afterEach(() => {
    process.env.HOME = realHome
    rmSync(fakeHome, { recursive: true, force: true })
  })

  function mainSettingsPath(): string {
    return join(fakeHome, '.claude', 'settings.json')
  }

  it('red-first: even when the main agent IS on enabled_agents, the write is refused', () => {
    // Deliberately enabling 'marveen' proves the refusal is explicit (refuseMainAgentHookWrite),
    // not an accidental side effect of it never being on the list.
    seedEnabledAgents(['marveen'])
    const p = mainSettingsPath()
    writeFileSync(p, JSON.stringify({ hooks: { SessionStart: [taskstateOnlyEntry()] } }))
    const before = readFileSync(p, 'utf8')
    expect(ensureSharedMemoryInject('marveen')).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe(before)
  })

  it('mutation control: a sub-agent in the same sandbox still gets wired', () => {
    seedEnabledAgents(['marveen', 'backend2'])
    rmSync(join(SANDBOX, 'agents'), { recursive: true, force: true })
    const p = seedAgent('backend2', [taskstateOnlyEntry()])
    expect(ensureSharedMemoryInject('backend2')).toBe(true)
    expect(JSON.stringify(readSettings(p))).toContain('shared-memory-inject.py')
  })
})

// ---------------------------------------------------------------------------
// The templates. The boot migration fixes today's already-scaffolded agents; the seed and the
// generic template decide what every agent created tomorrow starts with. Fixing only the
// migration is how backend3/logs never got the hook in the first place -- they were scaffolded
// from the generic template (no seed-fleet-agents entry of their own existed for them), and the
// template never carried it either.
// ---------------------------------------------------------------------------
describe('the generic template and every seed that has its own SessionStart block ship the hook', () => {
  it('templates/settings.json.template carries shared-memory-inject.py', () => {
    const tpl = JSON.parse(readFileSync(join(REPO_ROOT, 'templates', 'settings.json.template'), 'utf8')) as {
      hooks?: { SessionStart?: { hooks?: { command?: string }[] }[] }
    }
    const entries = (tpl.hooks?.SessionStart ?? []).filter((e) =>
      (e.hooks ?? []).some((h) => (h.command ?? '').includes('shared-memory-inject.py')),
    )
    expect(entries).toHaveLength(1)
  })

  const seedDir = join(REPO_ROOT, 'seed-fleet-agents')
  const seeds = readdirSync(seedDir).filter((d) => existsSync(join(seedDir, d, '.claude', 'settings.json')))

  it('finds the seed templates at all', () => {
    expect(seeds.length).toBeGreaterThan(5)
  })

  // F3's own regression: every ENABLED, non-gate seed that already has its own SessionStart block
  // must carry the hook. A seed for an agent that is simply not on the enabled_agents list (e.g.
  // elemzo) is correctly bare -- that is not this card's bug. A gate seed's --agent-qualified
  // entry is covered by the gate function's own tests, not this one.
  const configPath = join(REPO_ROOT, 'store', 'session-memory-inject-agents.json')
  // Card 2aaa447e's own class, folded in here per MikroB dispatch 16908 (same file): when the
  // config is absent, `it.each` on an empty array silently reports ZERO test cases -- indistinguishable
  // from "ran and passed" in a report, which is how RedHat's F3 found the per-seed guard weaker
  // than claimed in a disposable gate worktree (the gitignored config file does not exist there).
  // A named, visible it.skip makes the degenerate case show up in the test list instead of just
  // vanishing.
  if (!existsSync(configPath)) {
    it.skip('store/session-memory-inject-agents.json is absent on this checkout -- per-seed enabled check skipped visibly', () => {})
  } else {
    const enabledSet: Set<string> = new Set(
      (JSON.parse(readFileSync(configPath, 'utf8')) as { enabled_agents?: unknown }).enabled_agents as string[] ?? [],
    )
    it.each(seeds.filter((s) => !GATE_AGENTS.includes(s) && enabledSet.has(s)))('%s: shared-memory-inject is wired', (agent) => {
      const d = JSON.parse(readFileSync(join(seedDir, agent, '.claude', 'settings.json'), 'utf8')) as {
        hooks?: { SessionStart?: { hooks?: { command?: string }[] }[] }
      }
      const entries = (d.hooks?.SessionStart ?? []).filter((e) =>
        (e.hooks ?? []).some((h) => (h.command ?? '').includes('shared-memory-inject.py')),
      )
      expect(entries.length).toBeGreaterThanOrEqual(1)
    })
  }

  // Card 2aaa447e: the it.each above depends on a gitignored, often-absent-in-a-gate-worktree
  // live file -- exactly the three agents THIS card (86d5de34 F3) is about (backend2, backend3,
  // logs) therefore need a guard that does NOT depend on it. Hardcoded by name (not derived from
  // the config file), so it runs identically whether or not session-memory-inject-agents.json
  // exists on this checkout.
  it.each(['backend2', 'backend3', 'logs'])(
    '%s: either its own seed carries the hook, or it has no seed of its own (template-provisioned) -- independent of the live config file',
    (agent) => {
      const seedSettings = join(seedDir, agent, '.claude', 'settings.json')
      if (!existsSync(seedSettings)) return // no seed of its own -- the generic-template test above covers it
      const d = JSON.parse(readFileSync(seedSettings, 'utf8')) as {
        hooks?: { SessionStart?: { hooks?: { command?: string }[] }[] }
      }
      const wired = (d.hooks?.SessionStart ?? []).some((e) =>
        (e.hooks ?? []).some((h) => (h.command ?? '').includes('shared-memory-inject.py')),
      )
      expect(wired).toBe(true)
    },
  )
})

// ---------------------------------------------------------------------------
// The actual flag file. This is the test the card asked for: it reads the REAL
// store/session-memory-inject-agents.json and flags any enabled, non-gate agent whose OWN seed
// exists but doesn't carry the hook. An agent with no seed of its own is covered by the generic
// template test above instead (that is the path it actually gets provisioned from).
// ---------------------------------------------------------------------------
describe('every enabled_agents entry in session-memory-inject-agents.json is reachable', () => {
  const configPath = join(REPO_ROOT, 'store', 'session-memory-inject-agents.json')
  if (!existsSync(configPath)) {
    it.skip('store/session-memory-inject-agents.json does not exist on this checkout', () => {})
  } else {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { enabled_agents?: unknown }
    const enabled = Array.isArray(config.enabled_agents)
      ? config.enabled_agents.filter((a): a is string => typeof a === 'string' && !GATE_AGENTS.includes(a))
      : []

    it('finds a non-empty, non-gate enabled list to check', () => {
      expect(enabled.length).toBeGreaterThan(0)
    })

    it.each(enabled)('%s: either its own seed carries the hook, or it has no seed of its own (template-provisioned)', (agent) => {
      const seedSettings = join(REPO_ROOT, 'seed-fleet-agents', agent, '.claude', 'settings.json')
      if (!existsSync(seedSettings)) {
        // No seed of its own -- it was (or will be) provisioned from templates/settings.json.template,
        // which the test above already pins.
        return
      }
      const d = JSON.parse(readFileSync(seedSettings, 'utf8')) as {
        hooks?: { SessionStart?: { hooks?: { command?: string }[] }[] }
      }
      const wired = (d.hooks?.SessionStart ?? []).some((e) =>
        (e.hooks ?? []).some((h) => (h.command ?? '').includes('shared-memory-inject.py')),
      )
      expect(wired).toBe(true)
    })
  }
})
