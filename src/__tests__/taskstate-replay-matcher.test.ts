// Card 1ce3fd90. The taskstate-replay SessionStart hook has TWO halves, and only one of them was
// ever widened.
//
// The DECIDING half (agent-taskstate.ts REPLAY_SOURCES) gained 'startup' in 2026-07 so a crash
// respawn mid-task would get its state back. The TRIGGERING half -- the hook's `matcher` in every
// agent's settings.json -- stayed `compact|resume`. Measured on this install, 2026-08-23: all 15
// settings.json files (14 agents + main) carried the stale matcher, so the hook never ran on a cold
// start and the 'startup' support was unreachable for every restart since it was added. The exact
// shape of card 91c4a369's egress-gate lesson: referencing the script is not running it.
//
// This card needs 'clear' for the same reason (rule 14, and the fresh model-step-down respawn), so
// the coupling itself is pinned here rather than the individual values.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readdirSync } from 'node:fs'

const SANDBOX = mkdtempSync(join(tmpdir(), 'taskstate-matcher-'))

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, MAIN_AGENT_ID: 'marveen' }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { ensureTaskstateReplayMatcher, TASKSTATE_REPLAY_MATCHER } = await import('../web/agent-scaffold.js')
const { REPLAY_SOURCES } = await import('../web/agent-taskstate.js')

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const TASKSTATE_CMD = 'python3 /opt/marveen/scripts/hooks/taskstate-replay.py'
const SHARED_MEM_ENTRY = {
  matcher: 'startup|resume|compact|clear',
  hooks: [{ type: 'command', command: 'python3 /opt/marveen/scripts/hooks/shared-memory-inject.py', timeout: 15 }],
}

function settingsPath(agent: string): string {
  return join(SANDBOX, 'agents', agent, '.claude', 'settings.json')
}

function seedAgent(agent: string, sessionStart: unknown): string {
  const p = settingsPath(agent)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify({ hooks: { SessionStart: sessionStart } }, null, 2))
  return p
}

function staleEntry() {
  return { matcher: 'compact|resume', hooks: [{ type: 'command', command: TASKSTATE_CMD, timeout: 15 }] }
}

function readSettings(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
}

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// The coupling. This is the finding, not the individual matcher value.
// ---------------------------------------------------------------------------
describe('the matcher and the replay decision name the SAME set of sources', () => {
  it('every source the dashboard replays on is a source the hook fires on, and vice versa', () => {
    const branches = new Set(TASKSTATE_REPLAY_MATCHER.split('|'))
    expect([...branches].sort()).toEqual([...REPLAY_SOURCES].sort())
  })

  // Direction matters and set-equality alone can be read as symmetric bookkeeping, so both failures
  // are named. A source the DECIDER accepts but the matcher misses is unreachable support (the
  // 'startup' bug). A branch the matcher fires on but the decider refuses is a wasted hook run --
  // harmless, but it means one of the two was edited without the other, which is the actual defect.
  it('neither half carries a source the other does not', () => {
    const branches = TASKSTATE_REPLAY_MATCHER.split('|')
    expect(branches.filter((b) => !REPLAY_SOURCES.has(b))).toEqual([])
    expect([...REPLAY_SOURCES].filter((s) => !branches.includes(s))).toEqual([])
  })

  it('and it actually contains clear, which is what this card needed', () => {
    expect(REPLAY_SOURCES.has('clear')).toBe(true)
    expect(TASKSTATE_REPLAY_MATCHER.split('|')).toContain('clear')
  })
})

// ---------------------------------------------------------------------------
// The boot migration.
// ---------------------------------------------------------------------------
describe('ensureTaskstateReplayMatcher (boot backfill)', () => {
  beforeEach(() => rmSync(join(SANDBOX, 'agents'), { recursive: true, force: true }))

  it('widens a stale matcher and reports the change', () => {
    const p = seedAgent('backend2', [staleEntry()])
    expect(ensureTaskstateReplayMatcher('backend2')).toBe(true)
    const ss = readSettings(p).hooks as { SessionStart: { matcher: string }[] }
    expect(ss.SessionStart[0]?.matcher).toBe(TASKSTATE_REPLAY_MATCHER)
  })

  it('is idempotent: a second pass changes nothing and says so', () => {
    seedAgent('backend2', [staleEntry()])
    ensureTaskstateReplayMatcher('backend2')
    const after = readFileSync(settingsPath('backend2'), 'utf8')
    expect(ensureTaskstateReplayMatcher('backend2')).toBe(false)
    expect(readFileSync(settingsPath('backend2'), 'utf8')).toBe(after)
  })

  // WIDEN-ONLY, deliberately. Creation belongs to the seed templates that own the SessionStart
  // block; an injector here would be a second definition of the same entry, free to disagree.
  it('does NOT create the hook where the agent has none', () => {
    const p = seedAgent('marketing', [SHARED_MEM_ENTRY])
    expect(ensureTaskstateReplayMatcher('marketing')).toBe(false)
    expect(JSON.stringify(readSettings(p))).not.toContain('taskstate-replay.py')
  })

  it('leaves a co-resident SessionStart hook untouched', () => {
    const p = seedAgent('qa', [SHARED_MEM_ENTRY, staleEntry()])
    expect(ensureTaskstateReplayMatcher('qa')).toBe(true)
    const ss = readSettings(p).hooks as { SessionStart: Record<string, unknown>[] }
    expect(ss.SessionStart[0]).toEqual(SHARED_MEM_ENTRY)
    expect(ss.SessionStart[1]?.matcher).toBe(TASKSTATE_REPLAY_MATCHER)
  })

  // A boot migration runs on EVERY agent at startup, including whatever half-written file happens to
  // be on disk. It must never take the dashboard down with it, and must never overwrite something it
  // could not parse.
  it('a malformed settings.json is skipped, not rewritten', () => {
    const p = settingsPath('broken')
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, '{ this is not json')
    expect(ensureTaskstateReplayMatcher('broken')).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe('{ this is not json')
  })

  it('a missing settings.json is skipped, and none is created', () => {
    expect(ensureTaskstateReplayMatcher('ghost')).toBe(false)
    expect(existsSync(settingsPath('ghost'))).toBe(false)
  })

  it('a settings.json with no hooks at all is skipped', () => {
    const p = settingsPath('bare')
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify({ model: 'claude-opus-5' }, null, 2))
    expect(ensureTaskstateReplayMatcher('bare')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The templates. The migration fixes today's fleet; the seeds decide what every agent created
// tomorrow starts with. Fixing one without the other is how this drifted in the first place.
// ---------------------------------------------------------------------------
describe('the seed templates ship the current matcher', () => {
  const seedDir = join(REPO_ROOT, 'seed-fleet-agents')
  const seeds = readdirSync(seedDir).filter((d) => existsSync(join(seedDir, d, '.claude', 'settings.json')))

  it('finds the seed templates at all', () => {
    expect(seeds.length).toBeGreaterThan(5)
  })

  it.each(seeds)('%s: taskstate-replay uses the current matcher', (agent) => {
    const d = JSON.parse(readFileSync(join(seedDir, agent, '.claude', 'settings.json'), 'utf8')) as {
      hooks?: { SessionStart?: { matcher?: string; hooks?: { command?: string }[] }[] }
    }
    const entries = (d.hooks?.SessionStart ?? []).filter((e) =>
      (e.hooks ?? []).some((h) => (h.command ?? '').includes('taskstate-replay.py')),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.matcher).toBe(TASKSTATE_REPLAY_MATCHER)
  })
})
