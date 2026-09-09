// discoverAgentSources must also look in an agent's ISOLATED config dir (card f27c999b, B-wave 4/6).
//
// THE DEFECT UPSTREAM MEASURED. A sub-agent provisioned with its own config dir writes transcripts
// under agents/<name>/.claude-config/projects/, not into ~/.claude. A reader that only walks the
// shared root stops seeing that agent the moment it is migrated -- and stops SILENTLY, because the
// old directory still exists and still parses, so the agent reads as idle. Upstream lost three days
// of fleet consumption from the monitor a model-assignment decision was about to be based on.
//
// THE PARAGRAPH HERE WAS WRONG, and it is corrected rather than deleted because it is half the
// reason the defect below survived review (card 0c4cf655, from Cybered's finding on the efaf8926
// gate). It said the symlinked layout -- provisioning points
// agents/<name>/.claude-config/projects back at ~/.claude/projects, so both roots are one physical
// tree -- was benign, and that the change only bought independence from a provisioning detail.
//
// It was not benign. Reading one tree once per agent booked the WHOLE fleet's consumption under
// every isolated agent's own name, and the unique index could not absorb it because `agent` is its
// first column. Measured before the fix: 4,033,380 rows against 398,952 distinct events, 90.1%
// duplicates. discoverAgentSources now skips an isolated root that RESOLVES to the shared one;
// token-usage-shared-root-skip.test.ts pins that, and the cases below still pin the capability
// this block was added for -- a genuinely isolated tree must still be read.
//
// listAgentNames is mocked because the real one returns the live fleet, and a real agent's
// CONFIGURED dir wins over the probe root -- the override would never be reached.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const FAKE_AGENT = 'agent-f27c999b-fixture'

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...actual, listAgentNames: () => [FAKE_AGENT] }
})

const { discoverAgentSources } = await import('../web/token-usage.js')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tokensrc-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Build agents/<name>/.claude-config/projects/<encoded>/ under the throwaway root. */
function seedIsolated(encodedDirs: string[]): string[] {
  const projects = join(root, 'agents', FAKE_AGENT, '.claude-config', 'projects')
  mkdirSync(projects, { recursive: true })
  return encodedDirs.map((d) => {
    const full = join(projects, d)
    mkdirSync(full, { recursive: true })
    writeFileSync(join(full, 'session.jsonl'), '{}\n')
    return full
  })
}

describe('discoverAgentSources finds isolated transcript roots (card f27c999b)', () => {
  it('picks up an isolated projects dir the shared root knows nothing about', () => {
    const [dir] = seedIsolated(['-home-neon-somewhere-else'])
    const found = discoverAgentSources(root).filter((s) => s.agent === FAKE_AGENT)
    expect(found.map((s) => s.projectDir)).toContain(dir)
  })

  it('attributes by WHOSE config dir it is, not by the encoded project name', () => {
    // The encoded name here names a DIFFERENT agent on purpose. An isolated dir holds only its
    // owner's work, so trusting the directory name instead of the owner would misattribute the
    // rows -- and token attribution is what model-assignment decisions read.
    const [dir] = seedIsolated(['-home-neon-marveen-agents-someone-else'])
    const found = discoverAgentSources(root).filter((s) => s.projectDir === dir)
    expect(found).toHaveLength(1)
    expect(found[0]!.agent).toBe(FAKE_AGENT)
  })

  it('adds every project dir under the isolated root, not just the first', () => {
    const dirs = seedIsolated(['-proj-a', '-proj-b', '-proj-c'])
    const found = discoverAgentSources(root).filter((s) => s.agent === FAKE_AGENT)
    for (const d of dirs) expect(found.map((s) => s.projectDir)).toContain(d)
  })

  it('returns nothing extra when the isolated dir has no projects/ subtree', () => {
    // A half-provisioned config dir must not register a source: there is nothing to parse, and a
    // phantom source would make the agent look present-but-silent rather than absent.
    mkdirSync(join(root, 'agents', FAKE_AGENT, '.claude-config'), { recursive: true })
    expect(discoverAgentSources(root).filter((s) => s.agent === FAKE_AGENT)).toHaveLength(0)
  })

  it('never throws when the root does not exist at all', () => {
    expect(() => discoverAgentSources(join(root, 'nope'))).not.toThrow()
  })
})
