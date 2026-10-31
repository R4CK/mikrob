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
import ts from 'typescript'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import * as agentScaffold from '../web/agent-scaffold.js'
import { buildAgentIdHeaderBody } from '../web/agent-scaffold.js'

const WEB_TS_PATH = join(PROJECT_ROOT, 'src', 'web.ts')
const AGENT_PROCESS_TS_PATH = join(PROJECT_ROOT, 'src', 'web', 'agent-process.ts')
const ROOT_CLAUDE_MD_PATH = join(PROJECT_ROOT, 'CLAUDE.md')

// Card 7e202dbf (RedHat F1, on f22ef741/965b0b2b): the ORIGINAL regex here
// (`ensure\w*Section\(\s*MAIN_AGENT_ID\s*\)`) was blind to a mutant that keeps the
// same call but wraps the argument (e.g. a cast, `MAIN_AGENT_ID as string`) -- the
// enumeration would silently shrink and the test suite would stay green with less
// coverage. Parsing with the TypeScript compiler and stripping parens/casts/non-null
// before comparing the argument text closes that class structurally, not just for
// this one shape.
function stripWrappers(n: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(n)) return stripWrappers(n.expression)
  if (ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n)) return stripWrappers(n.expression)
  return n
}

interface EnsureSectionCall { name: string; argText: string | null }

// Every call `ensure<...>Section(<arg?>)` in a source file, found by walking the real
// AST (not a regex over the text) -- `argText` is the stripped first-argument source,
// or null for a zero-arg call like ensureFederationClaudeMdSection().
function findEnsureSectionCalls(filePath: string): EnsureSectionCall[] {
  const src = readFileSync(filePath, 'utf-8')
  const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true)
  const out: EnsureSectionCall[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^ensure\w*Section$/.test(n.expression.text)) {
      const arg = n.arguments[0]
      out.push({ name: n.expression.text, argText: arg ? stripWrappers(arg).getText(sf) : null })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

const webCalls = findEnsureSectionCalls(WEB_TS_PATH)
// The original set: writers web.ts itself invokes with the literal MAIN_AGENT_ID
// argument on the main-agent boot path.
const writerNames = [...new Set(webCalls.filter((c) => c.argText === 'MAIN_AGENT_ID').map((c) => c.name))].sort()
// Zero-argument writers (today: only the federation onboarding reconciler).
const zeroArgWriterNames = [...new Set(webCalls.filter((c) => c.argText === null).map((c) => c.name))].sort()

// Card 7e202dbf (original ask + RedHat F1): web.ts's literal-argument calls are not the
// only way a writer reaches the main agent. agent-process.ts's startAgentProcessUnlocked
// calls several of the SAME writer functions with a variable `name` -- unconditionally,
// for whatever agent is being (re)started, including MAIN_AGENT_ID in deployments where
// agentDir(MAIN_AGENT_ID) exists (this checkout's own early `if (!existsSync(dir)) return`
// just happens to mask it here, the same reason this file's own fixture below exists).
// Any writer found ONLY here (not already proven safe via web.ts) is a sibling of the
// 965b0b2b class and must pass the exact same 0-diff test.
const agentProcessCalls = findEnsureSectionCalls(AGENT_PROCESS_TS_PATH)
const siblingWriterNames = [...new Set(agentProcessCalls.map((c) => c.name))].filter((n) => !writerNames.includes(n)).sort()

// The union is what the mutation-pin test below actually exercises.
const allNoOpWriterNames = [...new Set([...writerNames, ...siblingWriterNames])].sort()

describe('f22ef741/7e202dbf: every MAIN-branch CLAUDE.md section-writer gives 0 diff on the committed root CLAUDE.md', () => {
  it('discovers at least one section-writer from web.ts (sanity: enumeration is not vacuous)', () => {
    expect(writerNames.length).toBeGreaterThan(0)
  })

  // Count floor (RedHat F1): a missed writer -- renamed call, dropped import, a wrapper
  // the AST walk somehow still failed to see through -- must shrink this number and go
  // RED, not silently pass with fewer writers checked.
  it('the web.ts literal-MAIN_AGENT_ID writer count has not silently shrunk (count floor)', () => {
    expect(writerNames.length).toBeGreaterThanOrEqual(10)
  })

  it('discovers the zero-argument federation writer from web.ts (RedHat F2)', () => {
    expect(zeroArgWriterNames).toContain('ensureFederationClaudeMdSection')
  })

  it('discovers the agent-process.ts siblings not already covered via web.ts, by name (count floor)', () => {
    expect(siblingWriterNames.length).toBeGreaterThanOrEqual(2)
    expect(siblingWriterNames).toContain('ensureThinChiefHandoffSection')
    expect(siblingWriterNames).toContain('ensureFleetRosterSection')
  })

  it.each(allNoOpWriterNames)('%s(MAIN_AGENT_ID) leaves the committed root CLAUDE.md and agentDir(MAIN_AGENT_ID)/CLAUDE.md untouched', (name) => {
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
    // Two pieces of buildAgentIdHeaderBody()'s output are deployment-config-dependent, not
    // body-prose: the PROJECT_ROOT-derived token path, and the `name` argument itself (MAIN_AGENT_ID
    // resolves from .env, which a disposable fleet-test.sh worktree does not carry -- it defaults to
    // 'marveen' there instead of the real deployment's 'mikrob'). The committed block is correctly
    // pinned to the one real deployment's values; re-deriving them from THIS block itself (rather
    // than importing the test process's own PROJECT_ROOT/MAIN_AGENT_ID) keeps the pin meaningful
    // for drift in the surrounding prose without being a deployment-config oracle.
    const root = readFileSync(ROOT_CLAUDE_MD_PATH, 'utf-8')
    const normalize = (s: string): string => s.replace(/cat [^ \n]*\/store\/\.dashboard-token/g, 'cat <PROJECT_ROOT>/store/.dashboard-token')
    const begin = root.indexOf(AGENT_ID_HEADER_BEGIN)
    expect(begin, 'agent-id-header block missing from committed root CLAUDE.md').toBeGreaterThanOrEqual(0)
    const nameMatch = /X-Agent-Id: ([^"\s]+)/.exec(root.slice(begin))
    expect(nameMatch, 'could not find the embedded X-Agent-Id name in the committed block').not.toBeNull()
    const embeddedName = nameMatch![1]

    const expectedBlock = normalize(`${AGENT_ID_HEADER_BEGIN}\n${buildAgentIdHeaderBody(embeddedName)}\n${AGENT_ID_HEADER_END}`)
    expect(normalize(root), 'the agent-id-header block is missing or drifted from its own generator').toContain(expectedBlock)
  })
})

// Card 7e202dbf (RedHat F2) scope note: ensureFederationClaudeMdSection() is deliberately
// NOT given a 0-diff behavioral pin here. It is not the 965b0b2b bug class -- it has no
// `name` argument, and when federation is enabled it is DESIGNED to reconcile a
// delegation block into the committed root CLAUDE.md, so a MAIN no-op guard would just
// break the feature. F2's own Kész-ha only asked for discovery (zeroArgWriterNames test
// above) and a count floor, both met. While writing a candidate behavioral pin for this
// writer I found that calling it with this worktree's own (disabled) federation config
// against the real tracked root CLAUDE.md -- which was committed while federation was
// ENABLED on the live install -- strips the whole federation section rather than leaving
// it untouched: a config-driven re-dirty of the git-tracked file, gated by federation
// enabled-state instead of MAIN_AGENT_ID. That is a real but separate finding (not
// something a no-op guard fixes, since enabling federation legitimately needs the write);
// flagging it in the REVIEW for a follow-up card rather than fixing it silently here.
