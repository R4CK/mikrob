// Collector test (card 5a15cd5a). History:
//
// - Cybersec NO-GO (H1): ensureMemorySearchLabelSection drifted from its statically committed
//   CLAUDE.md block after upstream commit 323d7c41 enriched the generator text, and no
//   single-section test caught it, because none of them runs ALL seven main-agent writers
//   together, the way a real boot does (WhiteHat's own I3 recommendation on 965b0b2b).
// - QA FAIL on the first version of this file: a "run all seven, diff the file" design LOOKED
//   like it would catch a guard regression but did not, on TWO independent mutations (QA's own
//   measurement). (1) ensureMemorySearchLabelSection's no-op guard removed: the function fell
//   through to the OLD ternary, which for 'mikrob' still resolves to PROJECT_ROOT/CLAUDE.md -- a
//   real write WOULD have happened, but this file's normalize() happened to absorb the only
//   difference (the tmpRoot-vs-real token path), because the REST of the content already
//   matched (the H1 fix itself had already synced it). (2) ensureFleetAuthSection's no-op guard
//   removed: the function fell through to `join(agentDir(name), 'CLAUDE.md')`, a path this file
//   never created, so `existsSync` returned false and the function returned early FOR A
//   DIFFERENT REASON -- the guard's absence was never actually exercised.
// - Second attempt (write-spy across both possible target paths) ALSO failed, for the opposite
//   reason: ensureAutonomySection (one of the three functions that legitimately still writes for
//   MAIN, relying on content-match idempotency, not a guard) embeds PROJECT_ROOT-derived
//   tokenPath/dashboardOrigin -- mocking PROJECT_ROOT to a tmp dir for safety makes its generated
//   text genuinely differ from the real committed block's real-path text, so it writes for an
//   entirely unrelated, expected reason, and a bare "zero write calls" assertion flags that as a
//   false failure.
//
// Fix: stop trying to make ONE mechanism do both jobs. Two SEPARATE, independent checks:
//
//   A) STRUCTURAL (catches guard removal, deterministically, immune to path/content coincidence):
//      read agent-scaffold.ts's own source and assert that each of the four main-agent-exempt
//      functions' FIRST statement is the `if (name === MAIN_AGENT_ID) return` guard. This is the
//      same technique the individual per-section tests already use successfully (confirmed by
//      QA: those are NOT the ones that missed the regression) -- it reads the one line whose
//      presence IS the property under test, so it cannot be fooled by which path a post-guard
//      fallback resolves to or by content happening to already match there.
//   B) CONTENT DRIFT (catches a generator/committed-block mismatch, for whichever functions
//      actually run to completion): run all seven writers against a temp copy of the real
//      committed file and assert a normalized zero-diff, same normalization the sibling
//      per-section static-match tests already use for the same PROJECT_ROOT-path reason. This
//      is NOT the guard-detection mechanism (that is (A)); its job is content drift, which it
//      correctly caught for the original H1 bug.
//
// Scope: the seven STATIC, deterministic section-writers web.ts calls for MAIN_AGENT_ID
// (ensureAutonomySection, ensureSkillsPathTrapSection, ensureSystemDirectiveAuthSection,
// ensureMemorySearchLabelSection, ensureFleetAuthSection, ensureEvidenceSection,
// ensureMcpListChannelSection). Deliberately EXCLUDES ensureFederationClaudeMdSection: that
// writer's main-agent behaviour is NOT static -- it adds or REMOVES a block depending on live
// store/ federation state (WhiteHat INFO I1 on this same card), a separate, as yet undecided
// question, not a static-drift bug this collector is built to catch.
//
// Runs against a TEMP COPY of the real file, never the real one.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-main-claudemd-zerodiff-'))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'mikrob',
  BOT_NAME: 'mikrob',
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
  listAgentNames: () => ['mikrob'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const {
  ensureAutonomySection,
  ensureSkillsPathTrapSection,
  ensureSystemDirectiveAuthSection,
  ensureMemorySearchLabelSection,
  ensureFleetAuthSection,
  ensureEvidenceSection,
  ensureMcpListChannelSection,
} = await import('../web/agent-scaffold.js')

const SCAFFOLD_SOURCE = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold.ts'), 'utf-8')

// The four functions WhiteHat/965b0b2b established the no-op-for-MAIN pattern for, in web.ts's
// call order. ensureAutonomySection/ensureSkillsPathTrapSection/ensureSystemDirectiveAuthSection
// are NOT in this list -- they still write for MAIN, relying on content-match idempotency, which
// check B below still exercises correctly.
const MAIN_EXEMPT_FUNCTIONS = [
  'ensureMemorySearchLabelSection',
  'ensureFleetAuthSection',
  'ensureEvidenceSection',
  'ensureMcpListChannelSection',
]

describe('the no-op-for-MAIN guard is present in source, on all four exempt writers (card 5a15cd5a QA FAIL fix)', () => {
  for (const fnName of MAIN_EXEMPT_FUNCTIONS) {
    it(`${fnName}'s first statement is the MAIN_AGENT_ID no-op guard`, () => {
      const start = SCAFFOLD_SOURCE.indexOf(`export function ${fnName}(`)
      expect(start, `${fnName} not found in agent-scaffold.ts`).toBeGreaterThan(-1)
      const body = SCAFFOLD_SOURCE.slice(start, start + 200)
      // The guard must be the FIRST statement after the opening brace -- not merely present
      // somewhere in the function, which a ternary fallback further down could also satisfy
      // textually without actually preventing the write.
      const afterBrace = body.slice(body.indexOf('{') + 1).trimStart()
      expect(afterBrace.startsWith('if (name === MAIN_AGENT_ID) return'), `${fnName} does not open with the no-op guard -- found: ${afterBrace.slice(0, 80)}`).toBe(true)
    })
  }
})

// Same normalisation as the sibling per-section static-match tests (system-directive-auth-
// section.test.ts, memory-search-label-backfill.test.ts): the committed block embeds the REAL
// install's absolute token path, which is not the same literal path as this test's tmpRoot.
const TOKEN_PATH_RE = /cat [^)]+\/store\/\.dashboard-token/g
const normalize = (s: string) => s.replace(TOKEN_PATH_RE, 'cat <PROJECT_ROOT>/store/.dashboard-token')

describe('every static main-agent CLAUDE.md writer stays in sync with its committed block (card 5a15cd5a)', () => {
  it('produces a zero-diff (modulo PROJECT_ROOT) after all seven writers run, in the same order web.ts calls them', async () => {
    const { REPO_ROOT } = await import('./helpers/repo-location.js')
    const original = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf-8')

    const copyPath = join(tmpRoot, 'CLAUDE.md')
    writeFileSync(copyPath, original, 'utf-8')

    try {
      // Exact order from src/web.ts's `if (!webOnly) { ... }` block (MAIN_AGENT_ID calls),
      // minus ensureFederationClaudeMdSection (see the file header for why).
      ensureAutonomySection('mikrob')
      ensureSkillsPathTrapSection('mikrob')
      ensureSystemDirectiveAuthSection('mikrob')
      ensureMemorySearchLabelSection('mikrob')
      ensureFleetAuthSection('mikrob')
      ensureEvidenceSection('mikrob')
      ensureMcpListChannelSection('mikrob')

      const after = readFileSync(copyPath, 'utf-8')
      expect(normalize(after), 'a main-agent section writer changed the committed CLAUDE.md -- its generator text drifted from the statically committed block').toBe(normalize(original))
    } finally {
      rmSync(copyPath, { force: true })
    }
  })
})
