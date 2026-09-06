// Card 0c4cf655 (parent 07f4cd2f, Cybered's finding on the efaf8926 gate): an isolated projects
// dir that is really a SYMLINK back to the shared root must not be walked a second time under the
// agent's own name.
//
// WHY THIS WAS NOT CAUGHT BEFORE. The block being fixed carried a written reassurance that the
// symlinked layout was harmless, "because the UNIQUE INDEX on (agent, session_id, timestamp, input,
// output) plus INSERT OR IGNORE absorbs the overlap". It does not: `agent` is the index's FIRST
// column, so it absorbs overlap only within one agent name. Every isolated agent walking the shared
// tree books the whole fleet's consumption under its own name, and every copy is unique as far as
// that index can tell. Measured on the main clone's store/claudeclaw.db before this fix: 4,033,380
// rows against 398,952 distinct events -- 90.1% duplicates, five agents reporting byte-identical
// totals, one session id under 16 different agent names.
//
// The mistake was a prose claim about a schema, checked against the prose rather than the schema.
// So these tests assert BEHAVIOUR (what discoverAgentSources returns for each layout), and the
// duplication itself is measured on a real dedup key rather than asserted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SYMLINKED = 'agent-0c4cf655-symlinked'
const ISOLATED = 'agent-0c4cf655-isolated'

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...actual, listAgentNames: () => [SYMLINKED, ISOLATED] }
})

const { discoverAgentSources, resolvesToSharedProjectsRoot } = await import('../web/token-usage.js')

let root: string
let shared: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tokenshared-'))
  // The stand-in for ~/.claude/projects. Passing it in (rather than reaching for the live tree)
  // keeps this hermetic: no test in this file reads or writes the real fleet's transcripts.
  shared = join(root, 'shared-projects')
  mkdirSync(join(shared, '-home-neon-marveen-agents-someone'), { recursive: true })
  writeFileSync(join(shared, '-home-neon-marveen-agents-someone', 'session.jsonl'), '{}\n')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Provision an agent's config dir the way the fleet actually does: projects/ is a SYMLINK back to
 *  the shared root. */
function seedSymlinked(name: string): void {
  const cfg = join(root, 'agents', name, '.claude-config')
  mkdirSync(cfg, { recursive: true })
  symlinkSync(shared, join(cfg, 'projects'))
}

/** The other layout: a genuinely separate tree with its own transcripts. */
function seedTrulyIsolated(name: string): string {
  const dir = join(root, 'agents', name, '.claude-config', 'projects', '-some-private-project')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl'), '{}\n')
  return dir
}

describe('discoverAgentSources skips a shared root wearing a symlink (card 0c4cf655)', () => {
  it('a symlinked projects dir contributes NO source -- this is the whole defect', () => {
    seedSymlinked(SYMLINKED)
    const found = discoverAgentSources(root, shared).filter((s) => s.agent === SYMLINKED)
    expect(found).toEqual([])
  })

  it('CONTROL: a genuinely isolated tree is STILL read, so the fix does not re-open the old hole', () => {
    // The block being changed exists because a migrated agent used to go silently missing from the
    // monitor. Without this control, the test above would pass just as well against a version that
    // dropped the isolated loop entirely -- trading one silent data error for another.
    const dir = seedTrulyIsolated(ISOLATED)
    const found = discoverAgentSources(root, shared).filter((s) => s.agent === ISOLATED)
    expect(found.map((s) => s.projectDir)).toContain(dir)
  })

  it('the two layouts side by side: one is skipped, the other is not', () => {
    seedSymlinked(SYMLINKED)
    const dir = seedTrulyIsolated(ISOLATED)
    const sources = discoverAgentSources(root, shared)
    expect(sources.filter((s) => s.agent === SYMLINKED)).toEqual([])
    expect(sources.filter((s) => s.agent === ISOLATED).map((s) => s.projectDir)).toEqual([dir])
  })

  it('the shared root itself is still walked exactly once, with per-directory attribution', () => {
    // The skip must remove the DUPLICATE reading, not the original one. The encoded directory name
    // under the shared root names its owner, and that attribution is what the monitor reports.
    seedSymlinked(SYMLINKED)
    const sources = discoverAgentSources(root, shared)
    const fromShared = sources.filter((s) => s.projectDir.startsWith(shared))
    expect(fromShared).toHaveLength(1)
    expect(fromShared[0]!.agent).toBe('someone')
  })

  it('THE DUPLICATION ITSELF: N symlinked agents produce N-1 fewer readings of the same tree', () => {
    // Stated as the quantity that actually went wrong, not as a boolean. Before the fix each of
    // these agents contributed its own full copy of the shared tree; that is the 90% in the header.
    seedSymlinked(SYMLINKED)
    seedSymlinked(ISOLATED)
    const readings = discoverAgentSources(root, shared).filter((s) => s.projectDir.startsWith(shared))
    expect(readings).toHaveLength(1)
  })
})

describe('resolvesToSharedProjectsRoot', () => {
  it('sees through a symlink, which string comparison cannot', () => {
    const link = join(root, 'link-to-shared')
    symlinkSync(shared, link)
    expect(link).not.toBe(shared) // the paths differ as strings...
    expect(resolvesToSharedProjectsRoot(link, shared)).toBe(true) // ...and name one tree
  })

  it('says false for a genuinely separate directory', () => {
    const other = join(root, 'somewhere-else')
    mkdirSync(other, { recursive: true })
    expect(resolvesToSharedProjectsRoot(other, shared)).toBe(false)
  })

  it('fails toward TREATING IT AS ISOLATED when a path cannot be resolved', () => {
    // Direction matters. False here means "keep reading this dir": a directory we cannot stat is
    // one whose transcripts we should still try to collect, and the duplicate that risks is caught
    // by the dedup key (card b774f057). True would silently drop an agent's usage instead, which is
    // the failure this whole area already had once.
    expect(resolvesToSharedProjectsRoot(join(root, 'does-not-exist'), shared)).toBe(false)
    expect(resolvesToSharedProjectsRoot(shared, join(root, 'does-not-exist'))).toBe(false)
  })
})
