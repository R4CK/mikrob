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
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-rootanchor-test-'))
const OLD_ROOT = '/home/neon/marveen-OLDHOST'
let currentProjectRoot = OLD_ROOT

vi.mock('../config.js', () => ({
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
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

function agentFiles(name: string) {
  const dir = join(tmpRoot, 'agents', name, '.claude')
  mkdirSync(dir, { recursive: true })
  return {
    claudeMdPath: join(tmpRoot, 'agents', name, 'CLAUDE.md'),
    settingsPath: join(dir, 'settings.json'),
    anchorPath: join(dir, 'project-root-anchor.json'),
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
    const anchorPath = join(tmpRoot, 'agents', 'agent-a', '.claude', 'project-root-anchor.json')
    ensureProjectRootAnchor('agent-a')
    expect(existsSync(anchorPath)).toBe(false)
  })
})
