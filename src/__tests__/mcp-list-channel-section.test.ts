// Functional test for ensureMcpListChannelSection() -- mirrors skills-path-trap-section.test.ts.
// Card 965b0b2b (upstream adoption): warns a channel-owning agent off running `claude mcp list`
// in its own session (measured 2026-09-21 upstream: it silently drops that session's own channel
// plugin). Adapted from upstream's wording -- the trailing pointer to a dedicated measurement doc
// is dropped, because that doc was never ported to this fork.
//
// DEFERRED (upstream-sync batch 6, docs/mcp-list-channel-plugin.md landed in this batch): the
// richer body (measurement date, doc pointer, BEJÖVŐ-not-measured caveat) is NOT adopted here --
// 965b0b2b's gated, statically-committed CLAUDE.md block would need updating in lockstep (the
// STATIC-block test below requires a byte-exact match), and that is a separate, explicit decision
// beyond this sync batch's scope. The evidence doc itself lands standalone; its own content is
// still covered below.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-mcplist-test-'))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  // agent-scaffold.js now imports mcp-inheritance.js, which imports settings-store.js,
  // which derives OVERRIDES_PATH from STORE_DIR at module-import time (MCPOROKLES923).
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
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

  it('no-ops for the MAIN agent -- PROJECT_ROOT/CLAUDE.md is git-tracked, a runtime write there would fight --ff-only (card 2dd28b5d/99fccbcf, re-found by WhiteHat on card 965b0b2b)', () => {
    const before = '# Main\n'
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), before, 'utf-8')
    ensureMcpListChannelSection('agent-a')
    const out = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(out).toBe(before)
  })
})

// Card 965b0b2b (WhiteHat NO-GO, H1): the main agent's own PROJECT_ROOT/CLAUDE.md carries a
// STATICALLY COMMITTED copy of this section (ensureMcpListChannelSection no-ops for the main
// agent -- see the test above). This body has no PROJECT_ROOT-derived path segments, so an exact
// match is correct here -- no normalisation needed.
describe('the STATIC CLAUDE.md block matches the generator (card 965b0b2b)', () => {
  it("the committed section in THIS checkout's own CLAUDE.md equals the generator output", async () => {
    const { REPO_ROOT } = await import('./helpers/repo-location.js')
    const claudeMd = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf-8')
    const start = claudeMd.indexOf(MARKER_BEGIN)
    const end = claudeMd.indexOf(MARKER_END)
    expect(start, 'the generated marker is missing from CLAUDE.md -- has the section never been committed?').toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const committedBlock = claudeMd.slice(start + MARKER_BEGIN.length, end).trim()

    const { buildMcpListChannelBody } = await import('../web/agent-scaffold.js')
    expect(buildMcpListChannelBody().trim()).toBe(committedBlock)
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

// Upstream (MCPLISTCSATORNA921): docs/mcp-list-channel-plugin.md landed in this sync batch as a
// standalone evidence doc, not yet wired into buildMcpListChannelBody() (see the DEFERRED note at
// the top of this file). Its own content is still worth pinning independently of that wiring
// decision -- these checks are about the doc's prose, not about ensureMcpListChannelSection.
describe('mcp-list channel warning: the evidence doc', () => {
  it('separates what was measured from what was not', async () => {
    const { REPO_ROOT } = await import('./helpers/repo-location.js')
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'mcp-list-channel-plugin.md'), 'utf-8')
    expect(doc).toMatch(/Amit a mérés MEGÁLLAPÍT/)
    expect(doc).toMatch(/Amit a mérés NEM állapít meg/)
    expect(doc).toMatch(/külső beküldő mérte/)
  })

  it('records the before-state as a separate round, which is what makes the after meaningful', async () => {
    const { REPO_ROOT } = await import('./helpers/repo-location.js')
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'mcp-list-channel-plugin.md'), 'utf-8')
    expect(doc).toMatch(/két külön körben|KÜLÖN körben/)
  })
})
