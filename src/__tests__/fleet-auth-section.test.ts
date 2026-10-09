// Functional test for ensureFleetAuthSection() -- mirrors skills-path-trap-section.test.ts.
// Card 965b0b2b (upstream adoption): documents the token-hygiene rule (CLAUDE_CODE_OAUTH_TOKEN
// source, never copy another agent's credential) that was recurring-incident material upstream
// and is genuinely true for this fork too (store/.claude-oauth-token, MAIN_AGENT_ISOLATED_CONFIG,
// MAIN_AGENT_CONFIG_DIR and per-agent claudeConfigDir all exist here, verified before adoption).
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-fleetauth-test-'))

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

const { ensureFleetAuthSection, buildFleetAuthBody } = await import('../web/agent-scaffold.js')

const MARKER_BEGIN = '<!-- BEGIN GENERATED: fleet-auth-rule (auto-generated, do not edit by hand) -->'
const MARKER_END = '<!-- END GENERATED: fleet-auth-rule -->'

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string): string {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

describe('ensureFleetAuthSection', () => {
  it('appends the auth rule block to a CLAUDE.md that lacks it', () => {
    setup('agent-b', '# Agent B\n\nSome persona.\n')
    ensureFleetAuthSection('agent-b')
    const out = read('agent-b')
    expect(out).toContain(MARKER_BEGIN)
    expect(out).toContain(MARKER_END)
    expect(out).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(out).toContain('SOHA ne másold át másik agent tokenjét')
    expect(out).toContain('Some persona.')
  })

  it('is idempotent: a second call changes nothing', () => {
    setup('agent-b', '# Agent B\n')
    ensureFleetAuthSection('agent-b')
    const first = read('agent-b')
    ensureFleetAuthSection('agent-b')
    expect(read('agent-b')).toBe(first)
    expect(first.split(MARKER_BEGIN).length - 1).toBe(1)
  })

  it('replaces ONLY the marked block, preserving hand-written text around it', () => {
    setup('agent-b', `# Agent B\n\n${MARKER_BEGIN}\nRÉGI SZÖVEG\n${MARKER_END}\n\nKézzel írt lábjegyzet.\n`)
    ensureFleetAuthSection('agent-b')
    const out = read('agent-b')
    expect(out).not.toContain('RÉGI SZÖVEG')
    expect(out).toContain('Kézzel írt lábjegyzet.')
    expect(out).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('skips silently when there is no CLAUDE.md', () => {
    expect(() => ensureFleetAuthSection('agent-nonexistent')).not.toThrow()
  })

  it('no-ops for the MAIN agent -- PROJECT_ROOT/CLAUDE.md is git-tracked, a runtime write there would fight --ff-only (card 2dd28b5d/99fccbcf, re-found by WhiteHat on card 965b0b2b)', () => {
    const before = '# Main\n'
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), before, 'utf-8')
    ensureFleetAuthSection('agent-a')
    const out = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(out).toBe(before)
  })
})

// Card 965b0b2b (WhiteHat NO-GO, H1): the main agent's own PROJECT_ROOT/CLAUDE.md carries a
// STATICALLY COMMITTED copy of this section (ensureFleetAuthSection no-ops for the main agent --
// see the test above -- so nothing keeps that copy synced at runtime). Mirrors the f390a08e
// pattern already established for ensureSystemDirectiveAuthSection. This body has no
// PROJECT_ROOT-derived path segments (no tokenPath/dashboardOrigin interpolation), so an exact
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

    expect(buildFleetAuthBody().trim()).toBe(committedBlock)
  })
})

// Upstream (AUTHSECT919): the block ships to every install, so it must not carry one
// deployment's operator name or agent names -- same reason as template-identity-hygiene.
// Independent of the no-op-for-MAIN behavior above, kept alongside it.
describe('body hygiene', () => {
  it('is host-agnostic: no operator or per-install agent names', () => {
    const body = buildFleetAuthBody()
    expect(body).not.toMatch(/\/(Users|home)\/[A-Za-z0-9._-]+/)
    expect(body).not.toMatch(/Juhász|Viktor|Szabolcs|marveenja/i)
  })
})

describe('wiring contracts', () => {
  it('startAgentProcess calls the ensure on every (re)spawn', () => {
    const src = readFileSync(join(__dirname, '../../src/web/agent-process.ts'), 'utf-8')
    const roster = src.indexOf('ensureFleetRosterSection(name)')
    const auth = src.indexOf('ensureFleetAuthSection(name)')
    expect(roster).toBeGreaterThan(0)
    expect(auth).toBeGreaterThan(roster)
  })

  it('web.ts calls the ensure for the main agent too', () => {
    const src = readFileSync(join(__dirname, '../../src/web.ts'), 'utf-8')
    expect(src).toContain('ensureFleetAuthSection(MAIN_AGENT_ID)')
  })
})
