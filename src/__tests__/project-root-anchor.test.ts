// Card 8c6f30fb (HOSTMOVE923, upstream f3ce19ed+75be3249 adapted -- deferred on 965b0b2b
// because upstream's suffix-list mechanism is shaped for upstream's own generated content).
//
// What is pinned here is the BEHAVIOUR ensureProjectRootAnchor() exists to provide:
//   - a brand-new/pre-mechanism agent gets a baseline anchor written, with NO file rewrite
//     (there is nothing to compare the recorded root against yet),
//   - once an anchor exists and PROJECT_ROOT has not changed, nothing is read-modified,
//   - once PROJECT_ROOT has changed since the anchor was written, every literal occurrence
//     of the OLD root in CLAUDE.md and settings.json is replaced with the new one, and the
//     anchor itself is updated to the new root,
//   - the main agent is skipped entirely (its CLAUDE.md and settings.json are git-tracked).
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-rootanchor-test-'))
const STORE_DIR = join(tmpRoot, 'store')
const OLD_ROOT = '/home/neon/marveen-OLDHOST'
let currentProjectRoot = OLD_ROOT

vi.mock('../config.js', () => ({
  STORE_DIR,
  get PROJECT_ROOT() {
    return currentProjectRoot
  },
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  AGENT_API_ORIGIN: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureProjectRootAnchor } = await import('../web/agent-scaffold.js')

// Card b5d19a32: the anchor now lives in STORE_DIR, keyed by agent name -- not under the
// agent's own .claude dir, which the agent can write to (or symlink away).
function anchorPathFor(name: string): string {
  return join(STORE_DIR, 'project-root-anchors', `${name}.json`)
}

function agentFiles(name: string) {
  const dir = join(tmpRoot, 'agents', name, '.claude')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(STORE_DIR, 'project-root-anchors'), { recursive: true })
  return {
    claudeMdPath: join(tmpRoot, 'agents', name, 'CLAUDE.md'),
    settingsPath: join(dir, 'settings.json'),
    anchorPath: anchorPathFor(name),
  }
}

describe('ensureProjectRootAnchor', () => {
  it('writes a baseline anchor and touches no file when none exists yet', () => {
    currentProjectRoot = OLD_ROOT
    const { claudeMdPath, settingsPath, anchorPath } = agentFiles('agent-b')
    const claudeMdBody = `# Agent\n\ncat ${OLD_ROOT}/store/.dashboard-token\n`
    writeFileSync(claudeMdPath, claudeMdBody)
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ command: `python3 ${OLD_ROOT}/scripts/hooks/taskstate-replay.py` }] }] } }))

    ensureProjectRootAnchor('agent-b')

    expect(JSON.parse(readFileSync(anchorPath, 'utf-8')).root).toBe(OLD_ROOT)
    expect(readFileSync(claudeMdPath, 'utf-8')).toBe(claudeMdBody) // untouched on baseline run
  })

  it('does nothing when the recorded root matches the live PROJECT_ROOT', () => {
    currentProjectRoot = OLD_ROOT
    const { claudeMdPath, settingsPath, anchorPath } = agentFiles('agent-c')
    writeFileSync(anchorPath, JSON.stringify({ root: OLD_ROOT }))
    const claudeMdBody = `# Agent\n\ncat ${OLD_ROOT}/store/.dashboard-token\n`
    writeFileSync(claudeMdPath, claudeMdBody)
    writeFileSync(settingsPath, '{}')

    ensureProjectRootAnchor('agent-c')

    expect(readFileSync(claudeMdPath, 'utf-8')).toBe(claudeMdBody)
  })

  it('re-anchors CLAUDE.md and settings.json to the new root after a host move', () => {
    const NEW_ROOT = '/home/neon/marveen-NEWHOST'
    currentProjectRoot = OLD_ROOT
    const { claudeMdPath, settingsPath, anchorPath } = agentFiles('agent-d')
    writeFileSync(anchorPath, JSON.stringify({ root: OLD_ROOT }))
    writeFileSync(
      claudeMdPath,
      `# Agent\n\ncat ${OLD_ROOT}/store/.dashboard-token\nbash ${OLD_ROOT}/scripts/skill-index.sh\n`,
    )
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { PreCompact: [{ hooks: [{ command: `python3 ${OLD_ROOT}/scripts/hooks/taskstate-replay.py` }] }] },
      }),
    )

    currentProjectRoot = NEW_ROOT
    ensureProjectRootAnchor('agent-d')

    const claudeMdAfter = readFileSync(claudeMdPath, 'utf-8')
    expect(claudeMdAfter).toContain(`cat ${NEW_ROOT}/store/.dashboard-token`)
    expect(claudeMdAfter).toContain(`bash ${NEW_ROOT}/scripts/skill-index.sh`)
    expect(claudeMdAfter).not.toContain(OLD_ROOT)

    const settingsAfter = readFileSync(settingsPath, 'utf-8')
    expect(settingsAfter).toContain(`python3 ${NEW_ROOT}/scripts/hooks/taskstate-replay.py`)
    expect(settingsAfter).not.toContain(OLD_ROOT)

    expect(JSON.parse(readFileSync(anchorPath, 'utf-8')).root).toBe(NEW_ROOT)
  })

  it('is a no-op for the main agent (CLAUDE.md and settings.json are git-tracked there)', () => {
    currentProjectRoot = OLD_ROOT
    ensureProjectRootAnchor('agent-a')
    expect(existsSync(anchorPathFor('agent-a'))).toBe(false)
  })

  // Card eed22288 F1: a corrupt/empty recorded root must never be used for the replace --
  // `content.includes('')` is always true, so an unvalidated empty anchor would insert
  // PROJECT_ROOT between every character of CLAUDE.md/settings.json.
  it('treats an empty recorded root as no anchor, instead of rewriting every character', () => {
    currentProjectRoot = OLD_ROOT
    const { claudeMdPath, settingsPath, anchorPath } = agentFiles('agent-e')
    writeFileSync(anchorPath, JSON.stringify({ root: '' }))
    const claudeMdBody = `# Agent\n\ncat ${OLD_ROOT}/store/.dashboard-token\n`
    writeFileSync(claudeMdPath, claudeMdBody)
    writeFileSync(settingsPath, '{}')

    ensureProjectRootAnchor('agent-e')

    expect(readFileSync(claudeMdPath, 'utf-8')).toBe(claudeMdBody) // untouched
    expect(JSON.parse(readFileSync(anchorPath, 'utf-8')).root).toBe(OLD_ROOT) // re-baselined
  })

  // Card eed22288 F2: the old root must not match as a prefix of an unrelated sibling path --
  // a plain substring replace would also corrupt `${OLD_ROOT}-agent-worktrees`.
  it('does not rewrite a sibling path that only starts with the old root', () => {
    const NEW_ROOT = '/home/neon/marveen-NEWHOST'
    currentProjectRoot = OLD_ROOT
    const { claudeMdPath, settingsPath, anchorPath } = agentFiles('agent-f')
    writeFileSync(anchorPath, JSON.stringify({ root: OLD_ROOT }))
    const siblingPath = `${OLD_ROOT}-agent-worktrees/backend`
    writeFileSync(claudeMdPath, `# Agent\n\ncat ${OLD_ROOT}/store/.dashboard-token\ncd ${siblingPath}\n`)
    writeFileSync(settingsPath, '{}')

    currentProjectRoot = NEW_ROOT
    ensureProjectRootAnchor('agent-f')

    const claudeMdAfter = readFileSync(claudeMdPath, 'utf-8')
    expect(claudeMdAfter).toContain(`cat ${NEW_ROOT}/store/.dashboard-token`)
    expect(claudeMdAfter).toContain(`cd ${siblingPath}`) // sibling path left exactly as-is
  })

  // Card eed22288 delta (CYBERSEC GO): String.replace(pattern, newRoot) interprets `$` sequences
  // IN newRoot itself (e.g. a literal `$&` would re-insert the whole match) -- a string replacer
  // must become a function replacer so newRoot is substituted literally.
  it('writes a new root containing a literal $& exactly, not expanded as a replacement pattern', () => {
    const NEW_ROOT = '/home/neon/marveen$&weird'
    currentProjectRoot = OLD_ROOT
    const { claudeMdPath, settingsPath, anchorPath } = agentFiles('agent-g')
    writeFileSync(anchorPath, JSON.stringify({ root: OLD_ROOT }))
    writeFileSync(claudeMdPath, `# Agent\n\ncat ${OLD_ROOT}/store/.dashboard-token\n`)
    writeFileSync(settingsPath, '{}')

    currentProjectRoot = NEW_ROOT
    ensureProjectRootAnchor('agent-g')

    const claudeMdAfter = readFileSync(claudeMdPath, 'utf-8')
    expect(claudeMdAfter).toBe(`# Agent\n\ncat ${NEW_ROOT}/store/.dashboard-token\n`)
  })

  // Card b5d19a32 (Cybersec finding on eed22288): if agent A's .claude is a symlink into agent
  // B's .claude, agentSettingsPath('A') resolves through the link to B's real settings.json.
  // Without a refusal, the sweep for 'A' would rewrite B's file using a drift A had no business
  // triggering. The whole sweep for 'A' must refuse instead, leaving B's file untouched.
  it('refuses the whole sweep when the agent is a symlink into another agent (victim untouched)', () => {
    const NEW_ROOT = '/home/neon/marveen-NEWHOST'
    currentProjectRoot = OLD_ROOT
    const victim = agentFiles('agent-victim')
    writeFileSync(victim.anchorPath, JSON.stringify({ root: OLD_ROOT }))
    const victimSettings = JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ command: `python3 ${OLD_ROOT}/scripts/hooks/taskstate-replay.py` }] }] } })
    writeFileSync(victim.settingsPath, victimSettings)

    // Seed a STORE_DIR anchor for the attacker that already shows drift, exactly like a
    // legitimate prior run would have left behind.
    mkdirSync(join(STORE_DIR, 'project-root-anchors'), { recursive: true })
    writeFileSync(anchorPathFor('agent-attacker'), JSON.stringify({ root: OLD_ROOT }))
    // The attacker's OWN .claude dir does not exist yet -- replace it with a symlink into the
    // victim's real .claude dir (the attack this fix defends against).
    mkdirSync(join(tmpRoot, 'agents', 'agent-attacker'), { recursive: true })
    symlinkSync(join(tmpRoot, 'agents', 'agent-victim', '.claude'), join(tmpRoot, 'agents', 'agent-attacker', '.claude'))

    currentProjectRoot = NEW_ROOT
    ensureProjectRootAnchor('agent-attacker')

    expect(readFileSync(victim.settingsPath, 'utf-8')).toBe(victimSettings) // untouched
  })

  // Card b5d19a32: an anchor file an agent plants under its OWN .claude dir (the pre-fix
  // location) must be ignored -- only the STORE_DIR copy, which no agent process can write, is
  // ever trusted.
  it('ignores an anchor file written under the agent\'s own .claude dir', () => {
    currentProjectRoot = OLD_ROOT
    const { claudeMdPath, settingsPath } = agentFiles('agent-h')
    const claudeMdBody = `# Agent\n\ncat ${OLD_ROOT}/store/.dashboard-token\n`
    writeFileSync(claudeMdPath, claudeMdBody)
    writeFileSync(settingsPath, '{}')
    // Planted anchor, attacker-chosen root, in the OLD (agent-local) location -- never in
    // STORE_DIR for this agent.
    writeFileSync(join(tmpRoot, 'agents', 'agent-h', '.claude', 'project-root-anchor.json'), JSON.stringify({ root: '/evil/attacker-chosen-root' }))

    ensureProjectRootAnchor('agent-h')

    // Treated as "no anchor yet": baseline written to STORE_DIR with the real PROJECT_ROOT,
    // CLAUDE.md untouched (no drift to compare against the planted value).
    expect(JSON.parse(readFileSync(anchorPathFor('agent-h'), 'utf-8')).root).toBe(OLD_ROOT)
    expect(readFileSync(claudeMdPath, 'utf-8')).toBe(claudeMdBody)
  })
})
