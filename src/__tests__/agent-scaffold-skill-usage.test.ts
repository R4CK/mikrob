// Tests for the skill-usage block (card 27b02677, 527c9584 Feladat 2: "Skill-térkép bekötése az
// ügynökök CLAUDE.md-jébe"). This is the full, generated completion of the 20. munkavégzési
// szabály (feladattípus -> skill, nem próza) -- the f0cefd85 audit found 9 of 16 role agents had
// no such table at all, and the 7 that did only covered a hand-picked subset of their bound
// skills. The generated table is a COMPANION to any existing hand-curated one, not a replacement:
// duplicating it would violate the no-unnecessary-duplication principle, so the body text must
// say "look at the short table first" rather than silently competing with it.
//
// Source-level assertions, matching the technique of the sibling scaffold tests
// (agent-scaffold-evidence-rule.test.ts): the body is built from a static data table, so the
// source (plus the data file) is the testable surface without spinning up a model.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SKILL_USAGE_DATA } from '../web/skill-usage-data.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold.ts'), 'utf-8')
const AGENT_PROCESS = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')
const SWEEPER = readFileSync(join(__dirname, '..', 'web', 'scaffold-section-sweeper.ts'), 'utf-8')

const buildFn = SCAFFOLD.slice(
  SCAFFOLD.indexOf('function buildSkillUsageBody('),
  SCAFFOLD.indexOf('export function ensureSkillUsageSection('),
)

describe('skill-usage scaffold block', () => {
  it('defines BEGIN/END markers matching the generated-block convention', () => {
    expect(SCAFFOLD).toContain("const SKILL_USAGE_BEGIN = '<!-- BEGIN GENERATED: skill-usage")
    expect(SCAFFOLD).toContain("const SKILL_USAGE_END = '<!-- END GENERATED: skill-usage -->'")
  })

  it('uses a non-greedy block regex so it cannot eat unrelated content', () => {
    const re = SCAFFOLD.slice(SCAFFOLD.indexOf('const SKILL_USAGE_BLOCK_RE'))
    expect(re.slice(0, 300)).toContain('[\\\\s\\\\S]*?')
  })

  it('ensureSkillUsageSection is exported and writes atomically', () => {
    expect(SCAFFOLD).toContain('export function ensureSkillUsageSection(')
    const fn = SCAFFOLD.slice(SCAFFOLD.indexOf('export function ensureSkillUsageSection('))
    expect(fn.slice(0, 1400)).toContain('atomicWriteFileSync')
  })

  it('no-ops for the main agent and for any name absent from SKILL_USAGE_DATA', () => {
    const fn = SCAFFOLD.slice(SCAFFOLD.indexOf('export function ensureSkillUsageSection('))
    expect(fn.slice(0, 400)).toContain('name === MAIN_AGENT_ID) return')
    expect(fn.slice(0, 400)).toContain('if (body === null) return')
  })

  it('returns without writing when the computed block is unchanged', () => {
    const fn = SCAFFOLD.slice(SCAFFOLD.indexOf('export function ensureSkillUsageSection('))
    expect(fn.slice(0, 1400)).toContain('if (updated === existing) return')
  })

  it('is applied to every sub-agent on respawn', () => {
    expect(AGENT_PROCESS).toContain('ensureSkillUsageSection(name)')
  })

  // Deliberately NOT in the sweeper: the sweeper's own header scopes itself to
  // security-propagation sections (evidence-rule, mcp-list-channel-warning and
  // message-close are absent from it too, for the same reason). Adding an informational
  // section there would be scope creep against that documented boundary.
  it('is not added to the scaffold-section-sweeper (informational, not security-propagation)', () => {
    expect(SWEEPER).not.toContain('ensureSkillUsageSection')
  })

  it('points to an existing hand-curated table first, rather than silently duplicating it', () => {
    expect(buildFn).toContain('melyik feladathoz melyik')
    expect(buildFn).toContain('ELŐSZÖR')
  })

  it('marks a KÖTELEZŐ-GAP skill distinctly from an already-bound one', () => {
    expect(buildFn).toContain('KÖTELEZŐ-GAP')
  })
})

describe('SKILL_USAGE_DATA (generated from store/skill-role-map.md)', () => {
  it('covers every non-mikrob role agent', () => {
    const roles = [
      'backend', 'backend2', 'backend3', 'cybered', 'cybersec', 'cybersec2',
      'fron-ted', 'fron-teddy', 'fullstack', 'jogasz', 'marketing', 'penzugy',
      'qa', 'qa2', 'teszter', 'videooo',
    ]
    for (const r of roles) expect(SKILL_USAGE_DATA[r]?.length ?? 0).toBeGreaterThan(0)
    expect(SKILL_USAGE_DATA['mikrob']).toBeUndefined()
  })

  it('every entry has a non-empty skill name and task-type text', () => {
    for (const entries of Object.values(SKILL_USAGE_DATA)) {
      for (const e of entries) {
        expect(e.skill.length).toBeGreaterThan(0)
        expect(e.taskType.length).toBeGreaterThan(0)
      }
    }
  })

  // Card 27db86f4: a Peti 12184 request ("vidd egyben a backend családot") replaces the generated
  // 45-line catalog with a hand-picked 12(+2)-line task-type -> skill table for backend/backend2/
  // backend3 ONLY. These assertions read the rendered output the way the card's own "Kész, ha" 1
  // does (grep counts on the written CLAUDE.md), via buildBackendFamilySkillUsageBody's source.
  it('backend family gets the curated table, not the full catalog, for all three roles', () => {
    const curatedFn = SCAFFOLD.slice(
      SCAFFOLD.indexOf('function buildBackendFamilySkillUsageBody('),
      SCAFFOLD.indexOf('function buildSkillUsageBody('),
    )
    // Present: a representative curated-table row.
    expect(curatedFn).toContain('fork-adopt-investigation')
    // Absent: catalog-only entries that are NOT in the curated 12(+2) rows.
    for (const catalogOnly of ['working-backwards', 'usability-testing', 'writing-north-star-metrics']) {
      expect(curatedFn).not.toContain(catalogOnly)
    }
    // The two Peti-12191 addendum rows (security self-check + context7 docs lookup).
    expect(curatedFn).toContain('defensive-security-analysis')
    expect(curatedFn).toContain('context7')
    // Points to the full catalog instead of duplicating it.
    expect(curatedFn).toContain('store/skill-role-map.md')
  })

  it('buildSkillUsageBody dispatches all three backend-family names to the curated table', () => {
    const dispatch = SCAFFOLD.slice(
      SCAFFOLD.indexOf('function buildSkillUsageBody('),
      SCAFFOLD.indexOf('export function ensureSkillUsageSection('),
    )
    expect(dispatch).toContain('BACKEND_FAMILY.has(name)) return buildBackendFamilySkillUsageBody()')
    const familySet = SCAFFOLD.slice(
      SCAFFOLD.indexOf("const BACKEND_FAMILY = new Set("),
      SCAFFOLD.indexOf("const BACKEND_FAMILY = new Set(") + 80,
    )
    for (const name of ['backend', 'backend2', 'backend3']) expect(familySet).toContain(`'${name}'`)
  })

  it('a non-backend role (e.g. cybered) still renders from SKILL_USAGE_DATA, unaffected', () => {
    // BACKEND_FAMILY only has the three backend names (asserted above) -- anything else falls
    // through to the pre-existing `const entries = SKILL_USAGE_DATA[name]` path, byte-for-byte
    // the same code this card found already working for every other role.
    const dispatch = SCAFFOLD.slice(
      SCAFFOLD.indexOf('function buildSkillUsageBody('),
      SCAFFOLD.indexOf('export function ensureSkillUsageSection('),
    )
    expect(dispatch).toContain('const entries = SKILL_USAGE_DATA[name]')
    expect(SKILL_USAGE_DATA['cybered']?.length ?? 0).toBeGreaterThan(0)
  })

  it('marks a known self-claimed-but-unreferenced skill as gap for its role', () => {
    const cybered = SKILL_USAGE_DATA['cybered'] ?? []
    const redHatGate = cybered.find((e) => e.skill === 'redhat-gate-pattern')
    expect(redHatGate?.gap).toBe(true)
  })

  it('does not mark an already-bound skill as gap', () => {
    const backend2 = SKILL_USAGE_DATA['backend2'] ?? []
    const karpathy = backend2.find((e) => e.skill === 'karpathy-guidelines')
    expect(karpathy?.gap).toBe(false)
  })

  it('has no duplicate skill rows within a single role', () => {
    for (const [role, entries] of Object.entries(SKILL_USAGE_DATA)) {
      const names = entries.map((e) => e.skill)
      expect(new Set(names).size, `${role} has duplicate skill rows`).toBe(names.length)
    }
  })
})
