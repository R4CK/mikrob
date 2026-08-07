// Card 3828a2b6: every agent's standing context must carry the local-LLM-first default.
//
// The measurement that motivated this: on 2026-08-07 NONE of the 11 seed personas and NONE of the
// 14 live agents mentioned the local model. The skill described the behaviour, but a skill is only
// consulted once an agent decides it is relevant -- which is exactly the decision being missed. So
// the reminder is injected into CLAUDE.md the same way the roster and autonomy blocks are, and
// these tests hold the three properties that make that injection safe: it reaches agents that have
// no seed persona, it replaces rather than accumulates, and it never touches hand-written content.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-localfirst-test-'))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'main-agent',
  BOT_NAME: 'main-agent',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureLocalFirstSection } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: local-llm-first (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: local-llm-first -->'

function setup(agentName: string, content: string): string {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'CLAUDE.md')
  writeFileSync(path, content, 'utf-8')
  return path
}

describe('the local-first block reaches every agent (card 3828a2b6)', () => {
  it('is appended to an agent whose persona never mentioned the local model', () => {
    // The real starting state: 0 of 11 seed personas and 0 of 14 live agents said anything.
    const path = setup('fresh', '# Fresh agent\n\nSome role text.\n')
    ensureLocalFirstSection('fresh')
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain(BEGIN)
    expect(out).toContain(END)
    expect(out).toContain('Some role text.')
  })

  it('names the concrete units, not just the principle', () => {
    // A reminder that only says "use the local model" moves nothing: the agent still has to decide
    // what qualifies mid-card. These four are the categories the directive named.
    const path = setup('detail', '# x\n')
    ensureLocalFirstSection('detail')
    const out = readFileSync(path, 'utf-8')
    for (const unit of ['teszt-fájl', 'segédfüggvény', 'i18n', 'CRUD']) {
      expect(out, `the block stopped naming ${unit}`).toContain(unit)
    }
    expect(out, 'the invocation must be copy-pasteable or it will not be used').toContain(
      'local-llm-rag.sh',
    )
  })

  it('keeps the draft-not-shippable rule and the online-only carve-out', () => {
    // Raising local usage without these two turns a token saving into an unreviewed-code channel.
    const path = setup('limits', '# x\n')
    ensureLocalFirstSection('limits')
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('DRAFT')
    expect(out).toContain('authz')
    expect(out).toMatch(/3 sikertelen/)
  })

  it('replaces its own block instead of stacking copies on every respawn', () => {
    const path = setup('repeat', '# x\n')
    ensureLocalFirstSection('repeat')
    ensureLocalFirstSection('repeat')
    ensureLocalFirstSection('repeat')
    const out = readFileSync(path, 'utf-8')
    expect(out.split(BEGIN).length - 1, 'the block accumulated').toBe(1)
    expect(out.split(END).length - 1).toBe(1)
  })

  it('does not rewrite the file when the content is already current', () => {
    // startAgentProcess() calls this on EVERY respawn; a needless write churns mtime and races
    // anything else holding the file.
    const path = setup('stable', '# x\n')
    ensureLocalFirstSection('stable')
    const first = statSync(path).mtimeMs
    ensureLocalFirstSection('stable')
    expect(statSync(path).mtimeMs).toBe(first)
  })

  it('leaves hand-written content outside the markers untouched', () => {
    const path = setup('handwritten', '# Role\n\nKEEP THIS EXACT LINE\n')
    ensureLocalFirstSection('handwritten')
    writeFileSync(path, readFileSync(path, 'utf-8').replace('KEEP THIS EXACT LINE', 'EDITED BY HAND'))
    ensureLocalFirstSection('handwritten')
    expect(readFileSync(path, 'utf-8')).toContain('EDITED BY HAND')
  })

  it('does nothing when the agent has no CLAUDE.md', () => {
    expect(() => ensureLocalFirstSection('nonexistent')).not.toThrow()
  })
})
