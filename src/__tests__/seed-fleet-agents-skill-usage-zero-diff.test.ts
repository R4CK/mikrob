// Card cfc70d36: the committed seed-fleet-agents/<agent>/CLAUDE.md "Skill-használat" generated
// block drifts from what ensureSkillUsageSection() actually produces today (the seed still carries
// the OLD full-catalog format for several agents, e.g. the QA/WhiteHat/RedHat families' curated
// tables never landed there -- measured: `grep -c 'gate-worktree-pattern'` on the committed seed
// files returns 0 for qa/qa2/cybersec/cybersec2/cybered, where the live, runtime-regenerated
// agents/<name>/CLAUDE.md returns 1 each). The generator (buildSkillUsageBody in
// agent-scaffold.ts) only ever writes to agentDir(name)/CLAUDE.md, i.e. the LIVE agents/ tree --
// nothing calls it against seed-fleet-agents/, so a seed file baked in before a generator change
// (or never regenerated at all) just lies forever; install-linux.sh copies it verbatim for every
// new agent.
//
// This is the SAME problem and the SAME fix shape as
// agent-scaffold-main-claude-md-zero-diff.test.ts: run the real writer against a TEMP COPY of the
// committed file and diff. Scoped to ensureSkillUsageSection only (not the other generated
// blocks): buildSkillUsageBody is a pure function of the agent name plus module-static data (no
// listAgentNames()/readAgentCapabilities()/live-store read), so "the generator's current output"
// is a single well-defined answer for a seed template. ensureFleetRosterSection/ensureAutonomySection
// and friends embed the LIVE fleet roster / dashboard origin -- there is no single correct
// point-in-time snapshot to commit into a template, so baking those into seed-fleet-agents is a
// different, NOT-yet-decided question, deliberately left out of this card's scope.
//
// Regeneration step (criterion 1, run from this worktree):
//   SEED_REGEN_WRITE=1 npx vitest run src/__tests__/seed-fleet-agents-skill-usage-zero-diff.test.ts
// writes the regenerated block back into every seed-fleet-agents/<name>/CLAUDE.md that has one.
// Without the env var (the normal `npm test` / fleet-test.sh path) this file only asserts zero-diff
// -- criterion 2, a drift test that fails the moment the generator moves again without the seed
// being regenerated.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-seed-skillusage-zerodiff-'))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => [],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureSkillUsageSection } = await import('../web/agent-scaffold.js')
const { REPO_ROOT } = await import('./helpers/repo-location.js')

const SEED_ROOT = join(REPO_ROOT, 'seed-fleet-agents')
const SEED_AGENT_NAMES = readdirSync(SEED_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => existsSync(join(SEED_ROOT, name, 'CLAUDE.md')))

describe('seed-fleet-agents found non-empty agent list to check (sanity, non-vacuity)', () => {
  it('found at least 10 seed agent dirs with a CLAUDE.md', () => {
    expect(SEED_AGENT_NAMES.length).toBeGreaterThanOrEqual(10)
  })
})

const WRITE_BACK = process.env.SEED_REGEN_WRITE === '1'

describe('ensureSkillUsageSection stays in sync with every committed seed-fleet-agents/<name>/CLAUDE.md (card cfc70d36)', () => {
  for (const name of SEED_AGENT_NAMES) {
    it(`${name}: regenerated skill-usage block matches the committed seed block${WRITE_BACK ? ' (WRITE-BACK MODE)' : ''}`, () => {
      const seedPath = join(SEED_ROOT, name, 'CLAUDE.md')
      const original = readFileSync(seedPath, 'utf-8')

      const tmpAgentPath = join(tmpRoot, 'agents', name, 'CLAUDE.md')
      mkdirSync(dirname(tmpAgentPath), { recursive: true })
      writeFileSync(tmpAgentPath, original, 'utf-8')

      ensureSkillUsageSection(name)

      const after = readFileSync(tmpAgentPath, 'utf-8')

      if (WRITE_BACK) {
        if (after !== original) writeFileSync(seedPath, after, 'utf-8')
        // Write-back mode only regenerates; it does not also assert, since its whole point is to
        // fix a currently-failing case.
        return
      }

      expect(
        after,
        `${name}'s committed seed-fleet-agents CLAUDE.md skill-usage block is stale (generator output differs). ` +
          `Regenerate with: SEED_REGEN_WRITE=1 npx vitest run src/__tests__/seed-fleet-agents-skill-usage-zero-diff.test.ts`,
      ).toBe(original)
    })
  }
})
