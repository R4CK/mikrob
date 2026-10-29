// N3 (card d4c89ff1, QA2 FAIL comment 25659 fix): ensureLanguageSection's existing.replace() must
// use a FUNCTION replacer, because the REPLACEMENT string (buildLanguageBody()'s output, which
// interpolates USER_LANGUAGE) can contain $&/$'/$` if USER_LANGUAGE ever did. JS String.replace
// only interprets those specials on the replacement side, never the matched/searched text -- the
// first version of this regression test (in language-section.test.ts) planted $& in the existing
// file content instead, which is inert, and stayed green with the vulnerable string replacer
// restored. This file plants the hostile value in USER_LANGUAGE itself (bypassing config.ts's
// real validation via a direct ../config.js mock, same as every other agent-scaffold test), so it
// lands in buildLanguageBody()'s output -- the actual replacement argument.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-language-injection-test-'))
const EVIL = "X$&Y$'Z$`W$1"

vi.mock('../config.js', () => ({
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  HEARTBEAT_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  AGENT_API_ORIGIN: '',
  APP_TZ: 'Europe/Budapest',
  ALLOWED_CHAT_ID: '',
  USER_LANGUAGE: EVIL,
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

const { ensureLanguageSection } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: agent-to-agent-language (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: agent-to-agent-language -->'

function setup(agent: string, content: string) {
  const dir = join(tmpRoot, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}
const read = (agent: string) => readFileSync(join(tmpRoot, 'agents', agent, 'CLAUDE.md'), 'utf-8')

describe('ensureLanguageSection replace() with a hostile USER_LANGUAGE in the replacement', () => {
  it('replaces an existing block exactly once and keeps the hostile value literal, no duplication', () => {
    setup('agent-inject', `# X\n\nhead-marker\n\n${BEGIN}\nold\n${END}\n\ntail-marker\n`)
    ensureLanguageSection('agent-inject')
    const out = read('agent-inject')
    // A string replacer would expand $& to the matched block / $' to the suffix ('\n\ntail-marker\n')
    // / $` to the prefix, duplicating surrounding content. The function replacer keeps EVIL literal.
    expect(out).toContain(`currently \`${EVIL}\``)
    expect(out.split('head-marker').length - 1).toBe(1)
    expect(out.split('tail-marker').length - 1).toBe(1)
    expect(out.split(BEGIN).length - 1).toBe(1)
  })
})
