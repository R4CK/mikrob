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
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'shared-mem-inject-wiring-'))

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, MAIN_AGENT_ID: 'marveen' }
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

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('ensureSharedMemoryInject (boot backfill, card 86d5de34 F3)', () => {
  beforeEach(() => rmSync(join(SANDBOX, 'agents'), { recursive: true, force: true }))

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
  const enabledSet: Set<string> = existsSync(configPath)
    ? new Set(
        (JSON.parse(readFileSync(configPath, 'utf8')) as { enabled_agents?: unknown }).enabled_agents as string[] ?? [],
      )
    : new Set()
  it.each(seeds.filter((s) => !GATE_AGENTS.includes(s) && enabledSet.has(s)))('%s: shared-memory-inject is wired', (agent) => {
    const d = JSON.parse(readFileSync(join(seedDir, agent, '.claude', 'settings.json'), 'utf8')) as {
      hooks?: { SessionStart?: { hooks?: { command?: string }[] }[] }
    }
    const entries = (d.hooks?.SessionStart ?? []).filter((e) =>
      (e.hooks ?? []).some((h) => (h.command ?? '').includes('shared-memory-inject.py')),
    )
    expect(entries.length).toBeGreaterThanOrEqual(1)
  })
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
