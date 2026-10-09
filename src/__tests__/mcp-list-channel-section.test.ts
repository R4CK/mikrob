// Functional test for ensureMcpListChannelSection() -- mirrors skills-path-trap-section.test.ts.
// Card 965b0b2b (upstream adoption): warns a channel-owning agent off running `claude mcp list`
// in its own session (measured 2026-09-21 upstream: it silently drops that session's own channel
// plugin). Adapted from upstream's wording -- the trailing pointer to a dedicated measurement doc
// is dropped, because that doc was never ported to this fork.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-mcplist-test-'))

vi.mock('../config.js', () => ({
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

const { ensureMcpListChannelSection } = await import('../web/agent-scaffold.js')

const MARKER_BEGIN = '<!-- BEGIN GENERATED: mcp-list-channel-warning (auto-generated, do not edit by hand) -->'
const MARKER_END = '<!-- END GENERATED: mcp-list-channel-warning -->'

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string): string {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

describe('ensureMcpListChannelSection', () => {
  it('appends the warning block to a CLAUDE.md that lacks it', () => {
    setup('agent-b', '# Agent B\n\nSome persona.\n')
    ensureMcpListChannelSection('agent-b')
    const out = read('agent-b')
    expect(out).toContain(MARKER_BEGIN)
    expect(out).toContain(MARKER_END)
    expect(out).toContain('claude mcp list')
    expect(out).toContain('Some persona.')
  })

  it('does not reference a measurement doc this fork never ported', () => {
    setup('agent-b', '# Agent B\n')
    ensureMcpListChannelSection('agent-b')
    expect(read('agent-b')).not.toContain('mcp-list-channel-plugin.md')
  })

  it('is idempotent: a second call changes nothing', () => {
    setup('agent-b', '# Agent B\n')
    ensureMcpListChannelSection('agent-b')
    const first = read('agent-b')
    ensureMcpListChannelSection('agent-b')
    expect(read('agent-b')).toBe(first)
    expect(first.split(MARKER_BEGIN).length - 1).toBe(1)
  })

  it('replaces ONLY the marked block, preserving hand-written text around it', () => {
    setup('agent-b', `# Agent B\n\n${MARKER_BEGIN}\nRÉGI SZÖVEG\n${MARKER_END}\n\nKézzel írt lábjegyzet.\n`)
    ensureMcpListChannelSection('agent-b')
    const out = read('agent-b')
    expect(out).not.toContain('RÉGI SZÖVEG')
    expect(out).toContain('Kézzel írt lábjegyzet.')
    expect(out).toContain('claude mcp list')
  })

  it('skips silently when there is no CLAUDE.md', () => {
    expect(() => ensureMcpListChannelSection('agent-nonexistent')).not.toThrow()
  })

  it('the main agent path targets PROJECT_ROOT/CLAUDE.md', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureMcpListChannelSection('agent-a')
    const out = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain(MARKER_BEGIN)
  })
})

describe('wiring contracts', () => {
  it('startAgentProcess calls the ensure on every (re)spawn', () => {
    const src = readFileSync(join(__dirname, '../../src/web/agent-process.ts'), 'utf-8')
    const roster = src.indexOf('ensureFleetRosterSection(name)')
    const mcpList = src.indexOf('ensureMcpListChannelSection(name)')
    expect(roster).toBeGreaterThan(0)
    expect(mcpList).toBeGreaterThan(roster)
  })

  it('web.ts calls the ensure for the main agent too', () => {
    const src = readFileSync(join(__dirname, '../../src/web.ts'), 'utf-8')
    expect(src).toContain('ensureMcpListChannelSection(MAIN_AGENT_ID)')
  })
})
