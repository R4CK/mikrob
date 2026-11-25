// ACKONCLOSE927: the message-close rule that ships to every agent's CLAUDE.md.
//
// Closing a message sends an '[Result]' ack to the original sender by
// default. For an incoming report that ack only lengthens the sender's queue
// (measured on an external install, 2026-09-27: three closes took it from 1 to
// 4). `notify: false` already skips it, but no recipe told an agent about it.
//
// Functional part mirrors autonomy-section.test.ts (temp root, mocked config).
// The wiring part reads the two call sites with comment lines removed, so a
// commented-out call does not pass for a live one.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-msgclose-test-'))

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

const { ensureMessageCloseSection, buildMessageCloseBody } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: message-close (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: message-close -->'

function setup(agent: string, content: string) {
  const dir = join(tmpRoot, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}
const read = (agent: string) => readFileSync(join(tmpRoot, 'agents', agent, 'CLAUDE.md'), 'utf-8')

// Card 01eb0d0c: the inline curl recipe (notify boolean, 409 handling) moved into
// store/agent-message-close.sh -- see agent-message-close.selftest.sh for the behavioural
// pins (real JSON boolean, 409-is-a-no-op, quote/backtick-safe --result/--result-file/
// --result-stdin). This generated body only has to NAME the command and keep the
// delegated-vs-report decision visible -- it does NOT by itself prove the wrapper's quoting
// is safe for every call shape (CYBERSEC NO-GO 38468, F1): the FIRST version of this body
// taught `--result "..."` in double quotes, which a backtick/$(...) inside the text executes
// in the CALLER's shell before the wrapper ever runs, regardless of how safe the wrapper's own
// internals are. The fix is that this body must never teach that shape at all.
describe('message-close section: what it says (ACKONCLOSE927, card 01eb0d0c)', () => {
  const body = buildMessageCloseBody('backend')

  it('tells the reader to close an INCOMING report with the default (no --notify flag)', () => {
    expect(body).toMatch(/BEJÖVŐ RIPORT[\s\S]{0,160}--notify false/)
  })

  it('keeps the default for a DELEGATED task, where the ack is the result', () => {
    expect(body).toMatch(/DELEGÁLT FELADAT[\s\S]{0,160}--notify true/)
  })

  it('says a second close of a closed message is a no-op, and must not be retried or reported', () => {
    expect(body).toMatch(/MÁR lezárt[\s\S]{0,120}NEM hiba/)
    // CYBERSEC GO 3a38fe2cc, LOW-2a (rule 7): restore the retry/report half of this pin --
    // "NEM hiba" alone does not say the no-op must not be retried or re-reported.
    expect(body).toMatch(/NEM hiba[\s\S]{0,160}NEM kell jelenteni/)
  })

  it('names the wrapper script instead of the raw curl recipe', () => {
    expect(body).toMatch(/agent-message-close\.sh backend <id>/)
    expect(body).not.toContain('curl -H @-')
  })

  // CYBERSEC NO-GO 38468, F1: this is the actual regression pin -- a double-quoted --result in
  // the shell example is the shape that executes a backtick/$(...) in the caller's shell. Never
  // taught again, in EITHER language's example line.
  it('never teaches a double-quoted --result on the command line (the ```bash example)', () => {
    const codeBlock = body.match(/```bash\n([\s\S]*?)```/)?.[1] ?? ''
    expect(codeBlock.length).toBeGreaterThan(0)
    expect(codeBlock).not.toMatch(/--result\s+"/)
  })

  it('teaches --result-file / --result-stdin as the safe forms, with an explicit double-quote warning', () => {
    expect(body).toContain('--result-file')
    expect(body).toContain('--result-stdin')
    expect(body).toMatch(/SOHA[\s\S]{0,40}--result "\.\.\."/)
    expect(body.toLowerCase()).toContain('backtick')
    // CYBERSEC GO 3a38fe2cc, LOW-1: --result-stdin must not be claimed safe unconditionally --
    // only a quoted heredoc is safe; a double-quoted echo/printf still expands backticks/$(...)
    // in the CALLER's shell. The old text claimed it "nem fut le soha" with no qualifier.
    expect(body).not.toMatch(/result-stdin[\s\S]{0,40}nem fut le soha/)
    expect(body).toMatch(/heredoc/)
    expect(body.toLowerCase()).toContain('echo')
  })
})

describe('message-close section: idempotent insert and update', () => {
  it('appends the block once, and a second run changes nothing', () => {
    setup('agent-b', '# Agent B\n\nexisting text\n')
    ensureMessageCloseSection('agent-b')
    const once = read('agent-b')
    expect(once).toContain('existing text')
    expect(once.split(BEGIN).length - 1).toBe(1)
    expect(once).toContain(END)
    ensureMessageCloseSection('agent-b')
    expect(read('agent-b')).toBe(once)
  })

  it('replaces a stale block in place instead of adding a second one', () => {
    setup('agent-c', `# C\n\n${BEGIN}\nold wording\n${END}\n\ntail\n`)
    ensureMessageCloseSection('agent-c')
    const out = read('agent-c')
    expect(out).not.toContain('old wording')
    expect(out.split(BEGIN).length - 1).toBe(1)
    expect(out).toContain('tail')
  })

  it('the main agent CLAUDE.md is not modified (no-op for MAIN_AGENT_ID)', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureMessageCloseSection('agent-a')
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).not.toContain(BEGIN)
  })
})

describe('message-close section: wired to BOTH surfaces', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const live = (rel: string) => readFileSync(join(here, '..', rel), 'utf-8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('web.ts ensures it for the main agent at boot', () => {
    expect(live('web.ts')).toMatch(/^\s*ensureMessageCloseSection\(MAIN_AGENT_ID\)/m)
  })

  it('agent-process.ts ensures it for every agent start', () => {
    expect(live('web/agent-process.ts')).toMatch(/^\s*ensureMessageCloseSection\(name\)/m)
  })
})
