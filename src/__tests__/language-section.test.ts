// Card 867fa8f2 (agent-to-agent English rule, Peti 12303 + 12306): agents talk to EACH OTHER in
// English (inter-agent messages, kanban comments, REVIEW/verdict free text, dispatch messages,
// shared-tier memory), the owner-facing language stays configured (USER_LANGUAGE), never a
// hardcoded constant. This is the "Kész, ha: #2" done-criterion: an agent-scaffold-generated
// agent's CLAUDE.md must carry the rule. Wiring part mirrors message-close-section.test.ts.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-language-test-'))

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
  USER_LANGUAGE: 'de', // non-default: if the generated text hardcodes 'hu', L3 would pass vacuously
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

const { ensureLanguageSection, buildLanguageBody } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: agent-to-agent-language (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: agent-to-agent-language -->'

function setup(agent: string, content: string) {
  const dir = join(tmpRoot, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}
const read = (agent: string) => readFileSync(join(tmpRoot, 'agents', agent, 'CLAUDE.md'), 'utf-8')

describe('language section: what it says', () => {
  const body = buildLanguageBody()

  it('tells the reader to talk to OTHER AGENTS in English', () => {
    expect(body).toMatch(/OTHER AGENTS in English/)
  })

  it('keeps the owner-facing language configured, not hardcoded', () => {
    expect(body).toMatch(/USER_LANGUAGE/)
    expect(body).toMatch(/[Nn]ever hardcode a language/)
  })

  // L3 (card a1eceda6): USER_LANGUAGE had no consumer -- the generated text only NAMED the env
  // var, it never READ it. The mocked config.js above sets USER_LANGUAGE to 'hu'; the generated
  // body must echo that actual value, not a hardcoded example.
  it('reads the actual configured USER_LANGUAGE value into the generated text', () => {
    expect(body).toContain('currently `de`')
  })

  it('lists the protocol tokens that never change language', () => {
    expect(body).toContain('Gate-SHA:')
    expect(body).toContain('Fix-Direction:')
    expect(body).toContain('CYBERSEC GO/NO-GO')
  })

  it('warns against mirroring the sender\'s language', () => {
    expect(body).toMatch(/[Mm]irroring/)
  })

  // N3 (card d4c89ff1): function replacer prevents String.replace special-pattern injection.
  // QA2 FAIL (comment 25659) on the first version of this test: JS String.replace only
  // interprets $&/$'/$` on the REPLACEMENT side, never the matched/searched text -- a $& planted
  // in the pre-existing file content (the match side, as the old test here did) is inert and the
  // test was 11/11 green even with the vulnerable string replacer restored. The real regression
  // coverage (replacement-side injection via a hostile USER_LANGUAGE value) lives in
  // language-section-replacer-injection.test.ts, in its own file because this file's USER_LANGUAGE
  // mock is fixed at module scope (vi.mock is hoisted) and the injection test needs a different,
  // hostile value -- vi.resetModules()-ing just for one test here would invalidate every other
  // test's already-imported module instance.
})

describe('language section: idempotent insert and update', () => {
  it('appends the block once, and a second run changes nothing', () => {
    setup('agent-b', '# Agent B\n\nexisting text\n')
    ensureLanguageSection('agent-b')
    const once = read('agent-b')
    expect(once).toContain('existing text')
    expect(once.split(BEGIN).length - 1).toBe(1)
    expect(once).toContain(END)
    ensureLanguageSection('agent-b')
    expect(read('agent-b')).toBe(once)
  })

  it('replaces a stale block in place instead of adding a second one', () => {
    setup('agent-c', `# C\n\n${BEGIN}\nold wording\n${END}\n\ntail\n`)
    ensureLanguageSection('agent-c')
    const out = read('agent-c')
    expect(out).not.toContain('old wording')
    expect(out.split(BEGIN).length - 1).toBe(1)
    expect(out).toContain('tail')
  })

  it('the main agent CLAUDE.md is not modified (no-op for MAIN_AGENT_ID, statically committed instead)', () => {
    // MAIN_AGENT_ID is 'agent-a' (see the vi.mock('../config.js') above), and agentDir('agent-a')
    // resolves to tmpRoot/agents/agent-a -- that is the file the guard must leave untouched. A
    // nonexistent path would make this test pass vacuously (existsSync short-circuits before the
    // MAIN_AGENT_ID check ever runs), so the file must actually exist here.
    setup('agent-a', '# Main\n')
    const before = read('agent-a')
    ensureLanguageSection('agent-a')
    expect(read('agent-a')).toBe(before)
    expect(read('agent-a')).not.toContain(BEGIN)
  })
})

describe('language section: wired to BOTH surfaces', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const live = (rel: string) => readFileSync(join(here, '..', rel), 'utf-8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('web.ts ensures it for the main agent at boot', () => {
    expect(live('web.ts')).toMatch(/^\s*ensureLanguageSection\(MAIN_AGENT_ID\)/m)
  })

  it('agent-process.ts ensures it for every agent start', () => {
    expect(live('web/agent-process.ts')).toMatch(/^\s*ensureLanguageSection\(name\)/m)
  })
})
