// Card f22ef741, source: WhiteHat INFO 965b0b2b (Gate-SHA 1f6247e1).
//
// web.ts's main-agent boot block (`!webOnly`) calls several agent-scaffold.ts
// `ensure*Section(MAIN_AGENT_ID)` functions. Each one is EITHER a hard no-op for
// MAIN_AGENT_ID (the block is committed statically into the real root CLAUDE.md
// instead, card 2dd28b5d/99fccbcf regression class: a runtime write to the
// git-tracked root CLAUDE.md fights the --ff-only pull that keeps the live
// checkout current), OR writes PROJECT_ROOT/CLAUDE.md idempotently and must
// reproduce the already-committed block byte-for-byte.
//
// This test enumerates the writers FROM web.ts's own source (no hand-maintained
// list -- a future `ensureXSection(MAIN_AGENT_ID)` call is picked up automatically)
// and asserts each one gives 0 diff against the real committed root CLAUDE.md.
//
// It also seeds agentDir(MAIN_AGENT_ID)/CLAUDE.md so a writer that falls through
// its MAIN no-op guard has something observable to dirty -- in this checkout that
// directory does not exist for MAIN_AGENT_ID, which would otherwise mask exactly
// the regression 965b0b2b found (removing the guard is a RED mutant only if the
// write target exists to receive it).
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import * as agentScaffold from '../web/agent-scaffold.js'
import { buildAgentIdHeaderBody } from '../web/agent-scaffold.js'

const WEB_TS_PATH = join(PROJECT_ROOT, 'src', 'web.ts')
const ROOT_CLAUDE_MD_PATH = join(PROJECT_ROOT, 'CLAUDE.md')

function discoverMainSectionWriters(): string[] {
  const src = readFileSync(WEB_TS_PATH, 'utf-8')
  const re = /\b(ensure\w*Section)\(\s*MAIN_AGENT_ID\s*\)/g
  const names = new Set<string>()
  for (const m of src.matchAll(re)) names.add(m[1])
  return [...names].sort()
}

const writerNames = discoverMainSectionWriters()

describe('f22ef741: every MAIN-branch CLAUDE.md section-writer gives 0 diff on the committed root CLAUDE.md', () => {
  it('discovers at least one section-writer from web.ts (sanity: enumeration is not vacuous)', () => {
    expect(writerNames.length).toBeGreaterThan(0)
  })

  it.each(writerNames)('%s(MAIN_AGENT_ID) leaves the committed root CLAUDE.md and agentDir(MAIN_AGENT_ID)/CLAUDE.md untouched', (name) => {
    const fn = (agentScaffold as unknown as Record<string, unknown>)[name]
    expect(typeof fn, `${name} is not exported from agent-scaffold.js`).toBe('function')

    const rootBefore = readFileSync(ROOT_CLAUDE_MD_PATH, 'utf-8')

    const agentClaudeMdDir = agentDir(MAIN_AGENT_ID)
    const agentClaudeMdPath = join(agentClaudeMdDir, 'CLAUDE.md')
    const agentDirPreexisted = existsSync(agentClaudeMdDir)
    const agentClaudeMdPreexisted = existsSync(agentClaudeMdPath)
    const agentClaudeMdBackup = agentClaudeMdPreexisted ? readFileSync(agentClaudeMdPath, 'utf-8') : null

    // Fixture: a freshly-scaffolded sub-agent CLAUDE.md stub, deliberately WITHOUT
    // any of the GENERATED blocks yet. A full copy of the (already-matching) root
    // CLAUDE.md would mask a guard removal here -- the function's own
    // `if (updated === existing) return` idempotency check short-circuits the write
    // whenever the generated block already happens to be present, so the guard's
    // absence only becomes observable against content that does NOT have it yet
    // (the realistic case: a brand-new agent directory).
    const agentStub = '# stub agent CLAUDE.md for pin-test\n'
    mkdirSync(agentClaudeMdDir, { recursive: true })
    writeFileSync(agentClaudeMdPath, agentStub, 'utf-8')

    try {
      ;(fn as (n: string) => void)(MAIN_AGENT_ID)

      const rootAfter = readFileSync(ROOT_CLAUDE_MD_PATH, 'utf-8')
      expect(rootAfter, `${name} changed the committed root CLAUDE.md`).toBe(rootBefore)

      const agentAfter = readFileSync(agentClaudeMdPath, 'utf-8')
      expect(agentAfter, `${name} wrote into agentDir(MAIN_AGENT_ID)/CLAUDE.md`).toBe(agentStub)
    } finally {
      // Always restore the real committed file byte-for-byte, regardless of outcome.
      writeFileSync(ROOT_CLAUDE_MD_PATH, rootBefore, 'utf-8')

      if (agentClaudeMdPreexisted && agentClaudeMdBackup !== null) {
        writeFileSync(agentClaudeMdPath, agentClaudeMdBackup, 'utf-8')
      } else if (!agentDirPreexisted) {
        rmSync(agentClaudeMdDir, { recursive: true, force: true })
      } else {
        rmSync(agentClaudeMdPath, { force: true })
      }
    }
  })
})

describe('f22ef741: the ensureAgentIdHeaderSection static commit matches its own generator (half 1 of the no-op fix)', () => {
  // The hard no-op guard (half 2, tested above) means this writer will NEVER regenerate
  // its block for MAIN_AGENT_ID at boot anymore -- so the only thing that can still pin
  // the STATIC TEXT itself is comparing it directly against buildAgentIdHeaderBody(), the
  // same function the committed block was generated from (card e8eec571a). Markers are
  // the module's own private BEGIN/END constants, inlined here since they are not exported.
  const AGENT_ID_HEADER_BEGIN = '<!-- BEGIN GENERATED: agent-id-header (auto-generated, do not edit by hand) -->'
  const AGENT_ID_HEADER_END = '<!-- END GENERATED: agent-id-header -->'

  it('the committed root CLAUDE.md contains the exact block buildAgentIdHeaderBody(MAIN_AGENT_ID) renders', () => {
    // buildAgentIdHeaderBody() bakes in `join(PROJECT_ROOT, 'store', '.dashboard-token')`, an
    // ABSOLUTE path -- the committed block is pinned to the single real deployment
    // (/home/neon/marveen), but fleet-test.sh runs this very assertion from a disposable
    // worktree (/home/neon/marveen-test) whose own PROJECT_ROOT differs. Normalize that one
    // deployment-path-dependent line out of both sides before comparing, so the pin still
    // catches drift in the rest of the body (the part that is NOT checkout-location-specific)
    // without being a deployment-path oracle.
    const normalize = (s: string): string => s.replace(/cat [^ \n]*\/store\/\.dashboard-token/g, 'cat <PROJECT_ROOT>/store/.dashboard-token')
    const expectedBlock = normalize(`${AGENT_ID_HEADER_BEGIN}\n${buildAgentIdHeaderBody(MAIN_AGENT_ID)}\n${AGENT_ID_HEADER_END}`)
    const root = normalize(readFileSync(ROOT_CLAUDE_MD_PATH, 'utf-8'))
    expect(root, 'the agent-id-header block is missing or drifted from its own generator').toContain(expectedBlock)
  })
})
