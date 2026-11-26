// MEMKERESVAK917 -- the BACK-FILL half of #1380.
//
// #1380 taught the two GENERATING surfaces to hand the agent the relaxation
// label. Both only run when an agent is CREATED, and no respawn-time updater
// touches the memory section, so on the day it merged the fix reached zero of
// the agents already on disk: nine agent CLAUDE.md files on the owner host
// still carried the search recipe with no way to see the header.
//
// What is pinned here is the BEHAVIOUR that closes that gap, not the wording:
//   - a file with a pre-#1380 recipe gets the block,
//   - a file generated AFTER #1380 does NOT get a second copy,
//   - once the block is in a file it is refreshed in place,
//   - the block is written per-agent, not with a shared /tmp path.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-memlabel-test-'))

vi.mock('../config.js', () => ({
  // agent-scaffold imports settings-store (MCPOROKLES923), which derives a path from
  // STORE_DIR at import time. A never-created dir: nothing here reads the store.
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

const { ensureMemorySearchLabelSection, buildMemorySearchLabelBody } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: memory-search-label (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: memory-search-label -->'

// The shape nine agents actually carry on the owner host: the recipe, with a
// bare `curl -s` and no mention of the header.
const PRE_1380 = `# Agent

## Memoria

Keresés (mielőtt válaszolsz, nézd meg van-e releváns emlék):
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" "http://localhost:3420/api/memories?agent=agent-b&q=KULCSSZO&category=warm"
`

// What generateClaudeMd() writes since #1380: the label is already inline.
const POST_1380 = `# Agent

## Memoria

Keresés (mielőtt válaszolsz, nézd meg van-e releváns emlék):
curl -s -D /tmp/mem-fejlec-agent-c.txt -H "Authorization: Bearer $(cat store/.dashboard-token)" "http://localhost:3420/api/memories?agent=agent-c&q=KULCSSZO&category=warm"
grep -i '^x-memory-search' /tmp/mem-fejlec-agent-c.txt

relaxed=true  -> mentett közelítés, NEM bizonyíték.
relaxed=false -> a kérdés úgy illeszkedett, ahogy kérted.
`

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string): string {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

describe('ensureMemorySearchLabelSection', () => {
  it('back-fills an agent whose recipe predates #1380', () => {
    setup('agent-b', PRE_1380)
    ensureMemorySearchLabelSection('agent-b')
    const out = read('agent-b')
    expect(out).toContain(BEGIN)
    expect(out).toContain(END)
    // The persona above the block is untouched.
    expect(out.startsWith(PRE_1380.trimEnd())).toBe(true)
  })

  it('does NOT add a second copy where #1380 already put the label inline', () => {
    setup('agent-c', POST_1380)
    ensureMemorySearchLabelSection('agent-c')
    expect(read('agent-c')).toBe(POST_1380)
  })

  it('is idempotent: a second run changes nothing', () => {
    setup('agent-d', PRE_1380)
    ensureMemorySearchLabelSection('agent-d')
    const once = read('agent-d')
    ensureMemorySearchLabelSection('agent-d')
    expect(read('agent-d')).toBe(once)
    expect(once.split(BEGIN).length - 1).toBe(1)
  })

  it('refreshes an existing block in place instead of appending another', () => {
    setup('agent-e', PRE_1380 + `\n${BEGIN}\nstale text\n${END}\n`)
    ensureMemorySearchLabelSection('agent-e')
    const out = read('agent-e')
    expect(out).not.toContain('stale text')
    expect(out.split(BEGIN).length - 1).toBe(1)
  })

  // No-op for the main agent (card 2dd28b5d/99fccbcf pattern, re-found by WhiteHat on 965b0b2b
  // for the sibling ensureFleetAuthSection/ensureMcpListChannelSection, and AGAIN on card
  // 5a15cd5a for this function after upstream commit 323d7c41 enriched the body text): a
  // runtime write to the git-tracked PROJECT_ROOT/CLAUDE.md would fight the --ff-only pull.
  // The block is committed there statically instead.
  it('no-ops for the main agent -- PROJECT_ROOT/CLAUDE.md is git-tracked', () => {
    const before = PRE_1380
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), before, 'utf-8')
    ensureMemorySearchLabelSection('agent-a')
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).toBe(before)
    expect(existsSync(join(tmpRoot, 'agents', 'agent-a', 'CLAUDE.md'))).toBe(false)
  })

  it('does nothing when the agent has no CLAUDE.md', () => {
    expect(() => ensureMemorySearchLabelSection('agent-missing')).not.toThrow()
    expect(existsSync(join(tmpRoot, 'agents', 'agent-missing', 'CLAUDE.md'))).toBe(false)
  })
})

// Card 01eb0d0c: the inline "-D tempfile + grep" recipe (and its per-agent /tmp path, the
// percent-encoding warning, the raw X-Memory-Search header text) moved INTO
// store/agent-memory-search.sh, which now does the encoding, the header read, and the
// relaxed/strict distinction itself (pinned behaviourally by agent-memory-search.selftest.sh,
// not by string-matching this generated prose). The failure modes those old assertions
// guarded -- a shared /tmp path, a silent 400 read as a zero-hit search, relaxed=false
// mistaken for "no hit" -- are now structurally impossible (the wrapper uses its own
// mktemp file per invocation and a non-zero exit code for anything that isn't a verified
// answer), so this body only has to tell the reader to USE the wrapper and what its exit
// codes mean.
describe('buildMemorySearchLabelBody', () => {
  it('names the wrapper script with the agent and query filled in, not a literal placeholder', () => {
    const b = buildMemorySearchLabelBody('agent-b')
    expect(b).toMatch(/agent-memory-search\.sh agent-b "KULCSSZÓ"/)
    expect(b).not.toContain('AGENT_NAME')
  })

  it('tells the reader what relaxed vs strict mean via the exit code', () => {
    const b = buildMemorySearchLabelBody('agent-b')
    expect(b).toContain('relaxed=true')
    expect(b).toContain('relaxed=false')
    expect(b).toMatch(/Kilépő kód 6[\s\S]{0,40}relaxed=true/)
  })

  it('says a real, verified zero-hit search is a valid answer (exit 0), distinct from a failed request', () => {
    const b = buildMemorySearchLabelBody('agent-b')
    expect(b).toMatch(/Kilépő kód 0[\s\S]{0,80}valódi, ellenőrzött 0 találat/)
    expect(b).toMatch(/Kilépő kód 5[\s\S]{0,120}ÜRES TALÁLATKÉNT SOHA ne olvasd/)
  })

  it('says --strict is what an absence claim needs', () => {
    expect(buildMemorySearchLabelBody('agent-b')).toContain('--strict')
  })

  // Card f90928e3: the date filter and the searchable diary are part of the
  // recipe every agent is given.
  it('teaches the date filter and the diary mirror', () => {
    const b = buildMemorySearchLabelBody('agent-b')
    expect(b).toContain('--date')
    expect(b).toContain('--since')
    expect(b).toContain('--until')
    expect(b).toContain('[Napló')
  })

  // Card 52114c2f: the one-time new-agent prompt's static copy of this prose was removed
  // (it duplicated the generator and drifted -- see FINDING 34495/34496); the prompt now
  // points at the generator instead of restating the recipe, so the pin is "points at the
  // right generator", not "carries the same literal line" (that would re-introduce the
  // duplication this test used to guard against).
  it('the CLAUDE.md one-time prompt points at ensureMemorySearchLabelSection instead of duplicating the recipe', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(src).toContain('ensureMemorySearchLabelSection')
  })
})

// Card 5a15cd5a (Cybersec NO-GO, H1): the main agent's own PROJECT_ROOT/CLAUDE.md carries a
// STATICALLY COMMITTED copy of this section (ensureMemorySearchLabelSection no-ops for the
// main agent -- see the test above, so nothing keeps that copy synced at runtime). Mirrors the
// f390a08e pattern already established for ensureSystemDirectiveAuthSection: this body embeds
// PROJECT_ROOT-derived absolute paths (tokenPath), which are NOT the same literal path in a
// gate-worktree as in the real install -- a naive full-body equality would fail FALSELY in every
// QA/Cybersec/Cybered gate-worktree. Normalise the one environment-derived path segment to a
// fixed placeholder before comparing, on both sides, instead of hardcoding either side's literal
// PROJECT_ROOT.
describe('the STATIC CLAUDE.md block matches the generator (card 5a15cd5a)', () => {
  // Card 01eb0d0c: the recipe no longer embeds tokenPath/agent-auth-header.sh inline (those
  // moved inside store/agent-memory-search.sh), but it still embeds agentMemorySearchScriptPath
  // itself, which is equally PROJECT_ROOT-derived -- normalise that one instead now.
  const SCRIPT_PATH_RE = /[^\s"'`]*\/store\/agent-memory-search\.sh/g
  const normalize = (s: string) => s.replace(SCRIPT_PATH_RE, '<PROJECT_ROOT>/store/agent-memory-search.sh')

  it("the committed section in THIS checkout's own CLAUDE.md equals the generator output, modulo PROJECT_ROOT", async () => {
    const { REPO_ROOT } = await import('./helpers/repo-location.js')
    const claudeMd = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf-8')
    const start = claudeMd.indexOf(BEGIN)
    const end = claudeMd.indexOf(END)
    expect(start, 'the generated marker is missing from CLAUDE.md -- has the section never been committed?').toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const committedBlock = claudeMd.slice(start + BEGIN.length, end).trim()

    // The committed block was generated for the REAL install's main agent, whatever THIS
    // checkout currently names it in the wrapper invocation -- read it back rather than
    // assume "mikrob", so a renamed install does not make this test lie about what it compares.
    const agentMatch = committedBlock.match(/agent-memory-search\.sh (\S+) "KULCSSZÓ"/)
    expect(agentMatch, 'no "agent-memory-search.sh <name> ..." invocation in the committed block -- did the wording change?').not.toBeNull()
    const committedName = agentMatch![1]

    const generated = buildMemorySearchLabelBody(committedName).trim()

    expect(normalize(generated)).toBe(normalize(committedBlock))
  })
})
