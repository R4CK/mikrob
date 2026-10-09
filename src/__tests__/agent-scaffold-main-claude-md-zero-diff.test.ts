// Collector test (card 5a15cd5a, Cybersec NO-GO, I3 from 965b0b2b re-raised): running EVERY
// main-agent-targeted CLAUDE.md section-writer against the REAL, committed root CLAUDE.md must
// produce a ZERO-byte diff. 965b0b2b's own structural tests only compared the fleet-auth and
// mcp-list blocks individually; the same hour's writer (ensureMemorySearchLabelSection) drifted
// from its committed block after upstream commit 323d7c41 enriched the generator text, and no
// single-section test caught it because none of them runs ALL seven writers together, the way
// a real boot does. This is the second such drift in one day -- the collector is no longer
// optional (WhiteHat's own I3 recommendation on 965b0b2b, acted on here).
//
// Scope: the seven STATIC, deterministic section-writers web.ts calls for MAIN_AGENT_ID
// (ensureAutonomySection, ensureSkillsPathTrapSection, ensureSystemDirectiveAuthSection,
// ensureMemorySearchLabelSection, ensureFleetAuthSection, ensureEvidenceSection,
// ensureMcpListChannelSection). Deliberately EXCLUDES ensureFederationClaudeMdSection: that
// writer's main-agent behaviour is NOT static -- it adds or REMOVES a block depending on live
// store/ federation state (WhiteHat INFO I1 on this same card), which is a separate, as yet
// undecided question, not a static-drift bug this collector is built to catch.
//
// Runs against a TEMP COPY of the real file, never the real one -- a test must not depend on
// write access to a git-tracked file, and a failing assertion must not leave the copy mutated
// behind it either way.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

// Same normalisation as the sibling per-section static-match tests (system-directive-auth-
// section.test.ts, memory-search-label-backfill.test.ts): the committed block embeds the REAL
// install's absolute token path, which is not the same literal path as this test's tmpRoot.
const TOKEN_PATH_RE = /cat [^)]+\/store\/\.dashboard-token/g
const normalize = (s: string) => s.replace(TOKEN_PATH_RE, 'cat <PROJECT_ROOT>/store/.dashboard-token')

describe('every static main-agent CLAUDE.md writer is a no-op against the committed file (card 5a15cd5a)', () => {
  it('produces a zero-diff after all seven writers run, in the same order web.ts calls them', async () => {
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
