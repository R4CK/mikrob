// Card 52114c2f: memory-save and daily-log used to live only in the one-time, LLM-written
// new-agent CLAUDE.md prompt -- never regenerated, still reading the shared token. This makes
// them proper idempotent-replace generated sections, on the per-agent helper instead.
//
// Structure mirrors message-close-section.test.ts (temp root, mocked config).
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-memsave-test-'))

vi.mock('../config.js', () => ({
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
  PROJECT_ROOT: tmpRoot,
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

const {
  ensureMemorySaveSection,
  buildMemorySaveBody,
  ensureDailyLogSection,
  buildDailyLogBody,
} = await import('../web/agent-scaffold.js')

const MEMSAVE_BEGIN = '<!-- BEGIN GENERATED: memory-save (auto-generated, do not edit by hand) -->'
const MEMSAVE_END = '<!-- END GENERATED: memory-save -->'
const DAILYLOG_BEGIN = '<!-- BEGIN GENERATED: daily-log (auto-generated, do not edit by hand) -->'
const DAILYLOG_END = '<!-- END GENERATED: daily-log -->'

function setup(agent: string, content: string) {
  const dir = join(tmpRoot, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}
const read = (agent: string) => readFileSync(join(tmpRoot, 'agents', agent, 'CLAUDE.md'), 'utf-8')

describe('memory-save section: what it says and who it authenticates as', () => {
  const body = buildMemorySaveBody('backend')

  it('uses the per-agent auth helper, not the shared token', () => {
    expect(body).toMatch(/agent-auth-header\.sh backend/)
    expect(body).not.toContain('store/.dashboard-token')
  })

  it('the example POSTs to /api/memories with the agent as agent_id', () => {
    expect(body).toMatch(/POST \S+\/api\/memories/)
    expect(body).toContain('"agent_id":"backend"')
  })
})

describe('daily-log section: what it says and who it authenticates as', () => {
  const body = buildDailyLogBody('backend')

  it('uses the per-agent auth helper, not the shared token', () => {
    expect(body).toMatch(/agent-auth-header\.sh backend/)
    expect(body).not.toContain('store/.dashboard-token')
  })

  it('the example POSTs to /api/daily-log with the agent as agent_id', () => {
    expect(body).toMatch(/POST \S+\/api\/daily-log/)
    expect(body).toContain('"agent_id":"backend"')
  })
})

describe('memory-save / daily-log sections: idempotent insert and update', () => {
  it('memory-save: appends the block once, a second run changes nothing', () => {
    setup('agent-b', '# Agent B\n\nexisting text\n')
    ensureMemorySaveSection('agent-b')
    const once = read('agent-b')
    expect(once).toContain('existing text')
    expect(once.split(MEMSAVE_BEGIN).length - 1).toBe(1)
    expect(once).toContain(MEMSAVE_END)
    ensureMemorySaveSection('agent-b')
    expect(read('agent-b')).toBe(once)
  })

  it('memory-save: replaces a stale block in place instead of adding a second one', () => {
    setup('agent-c', `# C\n\n${MEMSAVE_BEGIN}\nold wording\n${MEMSAVE_END}\n\ntail\n`)
    ensureMemorySaveSection('agent-c')
    const out = read('agent-c')
    expect(out).not.toContain('old wording')
    expect(out.split(MEMSAVE_BEGIN).length - 1).toBe(1)
    expect(out).toContain('tail')
  })

  it('daily-log: appends the block once, a second run changes nothing', () => {
    setup('agent-d', '# Agent D\n\nexisting text\n')
    ensureDailyLogSection('agent-d')
    const once = read('agent-d')
    expect(once).toContain('existing text')
    expect(once.split(DAILYLOG_BEGIN).length - 1).toBe(1)
    expect(once).toContain(DAILYLOG_END)
    ensureDailyLogSection('agent-d')
    expect(read('agent-d')).toBe(once)
  })

  it('daily-log: replaces a stale block in place instead of adding a second one', () => {
    setup('agent-e', `# E\n\n${DAILYLOG_BEGIN}\nold wording\n${DAILYLOG_END}\n\ntail\n`)
    ensureDailyLogSection('agent-e')
    const out = read('agent-e')
    expect(out).not.toContain('old wording')
    expect(out.split(DAILYLOG_BEGIN).length - 1).toBe(1)
    expect(out).toContain('tail')
  })

  it('the main agent CLAUDE.md is not modified (no-op for MAIN_AGENT_ID)', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureMemorySaveSection('agent-a')
    ensureDailyLogSection('agent-a')
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).not.toContain(MEMSAVE_BEGIN)
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).not.toContain(DAILYLOG_BEGIN)
  })
})

describe('memory-save / daily-log sections: wired to BOTH surfaces', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const live = (rel: string) => readFileSync(join(here, '..', rel), 'utf-8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('web.ts ensures both for the main agent at boot', () => {
    expect(live('web.ts')).toMatch(/^\s*ensureMemorySaveSection\(MAIN_AGENT_ID\)/m)
    expect(live('web.ts')).toMatch(/^\s*ensureDailyLogSection\(MAIN_AGENT_ID\)/m)
  })

  it('agent-process.ts ensures both for every agent start', () => {
    expect(live('web/agent-process.ts')).toMatch(/^\s*ensureMemorySaveSection\(name\)/m)
    expect(live('web/agent-process.ts')).toMatch(/^\s*ensureDailyLogSection\(name\)/m)
  })
})
