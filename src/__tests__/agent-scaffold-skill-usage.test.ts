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
import { buildDevOFamilySkillUsageBody } from '../web/agent-scaffold.js'

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
    // Peti 24117 addendum: "Minden kódolás" must carry ponytail (full fokozat) alongside
    // karpathy-guidelines, not just karpathy-guidelines + karpathycoder.
    expect(curatedFn).toMatch(/Minden kódolás.*karpathy-guidelines.*ponytail/)
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

  it('QA_FAMILY, WHITEHAT_FAMILY, REDHAT_FAMILY sets are defined in the scaffold', () => {
    expect(SCAFFOLD).toContain("const QA_FAMILY = new Set(")
    expect(SCAFFOLD).toContain("const WHITEHAT_FAMILY = new Set(")
    expect(SCAFFOLD).toContain("const REDHAT_FAMILY = new Set(")
    for (const name of ['qa', 'qa2']) expect(SCAFFOLD).toContain(`'${name}'`)
    for (const name of ['cybersec', 'cybersec2']) expect(SCAFFOLD).toContain(`'${name}'`)
    expect(SCAFFOLD).toContain("'cybered'")
  })

  it('QA family roles route to buildQaFamilySkillUsageBody', () => {
    const dispatch = SCAFFOLD.slice(
      SCAFFOLD.indexOf('function buildSkillUsageBody('),
      SCAFFOLD.indexOf('export function ensureSkillUsageSection('),
    )
    expect(dispatch).toContain('QA_FAMILY.has(name)')
    expect(dispatch).toContain('buildQaFamilySkillUsageBody()')
  })

  it('WhiteHat family roles route to buildWhiteHatFamilySkillUsageBody', () => {
    const dispatch = SCAFFOLD.slice(
      SCAFFOLD.indexOf('function buildSkillUsageBody('),
      SCAFFOLD.indexOf('export function ensureSkillUsageSection('),
    )
    expect(dispatch).toContain('WHITEHAT_FAMILY.has(name)')
    expect(dispatch).toContain('buildWhiteHatFamilySkillUsageBody()')
  })

  it('RedHat family routes to buildRedHatFamilySkillUsageBody, not SKILL_USAGE_DATA', () => {
    const dispatch = SCAFFOLD.slice(
      SCAFFOLD.indexOf('function buildSkillUsageBody('),
      SCAFFOLD.indexOf('export function ensureSkillUsageSection('),
    )
    expect(dispatch).toContain('REDHAT_FAMILY.has(name)')
    expect(dispatch).toContain('buildRedHatFamilySkillUsageBody()')
  })

  // Card 76583edb: FE sibling pair (fron-ted/fron-teddy) gets a curated table mirroring
  // BACKEND_FAMILY, replacing the generic full-catalog fallback -- measured 0/1 karpathy-guidelines
  // use and "nincs illo" on 12/40 REVIEW "Skills:" lines (MikroB Telegram 12195).
  it('FRONTEND_FAMILY is defined and names both fron-ted and fron-teddy', () => {
    expect(SCAFFOLD).toContain("const FRONTEND_FAMILY = new Set(")
    const familySet = SCAFFOLD.slice(
      SCAFFOLD.indexOf('const FRONTEND_FAMILY = new Set('),
      SCAFFOLD.indexOf('const FRONTEND_FAMILY = new Set(') + 80,
    )
    for (const name of ['fron-ted', 'fron-teddy']) expect(familySet).toContain(`'${name}'`)
  })

  it('buildSkillUsageBody dispatches both frontend-family names to the curated table', () => {
    const dispatch = SCAFFOLD.slice(
      SCAFFOLD.indexOf('function buildSkillUsageBody('),
      SCAFFOLD.indexOf('export function ensureSkillUsageSection('),
    )
    expect(dispatch).toContain('FRONTEND_FAMILY.has(name)) return buildFrontendFamilySkillUsageBody()')
  })

  it('frontend family curated table carries karpathy-guidelines and the 14 measured task-type groups, not the full catalog', () => {
    const curatedFn = SCAFFOLD.slice(
      SCAFFOLD.indexOf('function buildFrontendFamilySkillUsageBody('),
      SCAFFOLD.indexOf('function buildSkillUsageBody('),
    )
    expect(curatedFn).toContain('karpathy-guidelines')
    expect(curatedFn).toContain('react-page-api-wiring')
    expect(curatedFn).toContain('fe-rule12-audit')
    expect(curatedFn).toContain('rule13-touch-target-compliance')
    expect(curatedFn).toContain('i18n-parity-sweep')
    expect(curatedFn).toContain('oauth-callback-jwt-wiring')
    expect(curatedFn).toContain('contract-first-codev')
    expect(curatedFn).toContain('local-llm-offload')
    // Catalog-only entries NOT in the curated table.
    for (const catalogOnly of ['working-backwards', 'usability-testing', 'writing-north-star-metrics']) {
      expect(curatedFn).not.toContain(catalogOnly)
    }
    expect(curatedFn).toContain('store/skill-role-map.md')
  })

  // Card 219b07ae: DevO (fullstack, internal id unchanged) gets a curated table mirroring
  // BACKEND_FAMILY/FRONTEND_FAMILY, surfacing infra skills measured at 0 use (MikroB Telegram
  // 12201) plus API design/wiring (Peti 12201+12203).
  it('DEVO_FAMILY is defined and names fullstack', () => {
    expect(SCAFFOLD).toContain("const DEVO_FAMILY = new Set(")
    const familySet = SCAFFOLD.slice(
      SCAFFOLD.indexOf('const DEVO_FAMILY = new Set('),
      SCAFFOLD.indexOf('const DEVO_FAMILY = new Set(') + 60,
    )
    expect(familySet).toContain("'fullstack'")
  })

  it('buildSkillUsageBody dispatches fullstack to the DevO curated table', () => {
    const dispatch = SCAFFOLD.slice(
      SCAFFOLD.indexOf('function buildSkillUsageBody('),
      SCAFFOLD.indexOf('export function ensureSkillUsageSection('),
    )
    expect(dispatch).toContain('DEVO_FAMILY.has(name)) return buildDevOFamilySkillUsageBody()')
  })

  // Rendered-output assertions (card 219b07ae, WhiteHat2 F4): the previous version of this test
  // did a toContain on the function's SOURCE TEXT, so a commented-out row still passed (the
  // identifier stayed in the source even though the real generator would render zero rows for
  // it -- the no-comment-matching lesson from CLAUDE.md principle 12 applies to a function body
  // the same way it applies to a guard regex). Calling the real exported function and asserting
  // on its return value means a removed/commented row shows up as an actually-missing row.
  it('DevO curated table carries API design/wiring and the previously-0-use infra skills, not the full catalog', () => {
    const rendered = buildDevOFamilySkillUsageBody()
    expect(rendered).toContain('karpathy-guidelines')
    expect(rendered).toContain('api-and-interface-design')
    expect(rendered).toContain('contract-first-codev')
    expect(rendered).toContain('injected-port-adapters')
    expect(rendered).toContain('be-endpoint-param-extension')
    expect(rendered).toContain('guarded-write-endpoint-token-email')
    expect(rendered).toContain('oauth-callback-jwt-wiring')
    // The six measured-0-use infra skills (MikroB Telegram 12201) must be surfaced.
    for (const infraSkill of [
      'platform-infrastructure', 'observability-and-instrumentation', 'quota-management',
      'loop-engineering', 'skill-management', 'deprecation-and-migration',
    ]) {
      expect(rendered).toContain(infraSkill)
    }
    // Catalog-only entries NOT in the curated table.
    for (const catalogOnly of ['working-backwards', 'usability-testing', 'writing-north-star-metrics']) {
      expect(rendered).not.toContain(catalogOnly)
    }
    expect(rendered).toContain('store/skill-role-map.md')
  })

  // Peti's approved addendum (comments 24120 + 24125, Telegram 12215/12216/12219): ponytail next
  // to karpathy-guidelines on the "every change" row, and a wizard row for multi-step manual ops
  // (DevO/MikroB runs the generated steps, never the user; the wizard never prints/logs a
  // secret). Rendered-output assertion for the same reason as the test above.
  it('DevO curated table carries the Peti addendum: ponytail on every change, and a wizard row for manual multi-step ops', () => {
    const rendered = buildDevOFamilySkillUsageBody()
    expect(rendered).toContain('ponytail')
    expect(rendered).toContain('`wizard`')
    const wizardRow = rendered.split('\n').find((line) => line.includes('`wizard`'))
    expect(wizardRow).toBeDefined()
    expect(wizardRow).toContain('DevO')
    expect(wizardRow).not.toMatch(/Peti futtatja|a felhasználó futtatja/)
    // mikrob msg_id:16765: the wizard row must also carry the truly-human-only clause --
    // DevO names a 2FA/third-party-login step explicitly in a request, never hands over a
    // runnable script for it.
    expect(wizardRow).toMatch(/2FA.*böngészős bejelentkezés harmadik félnél/)
    expect(wizardRow).toMatch(/explicit megnevezi egy kérésben/)
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

  // Card 3bf6a01a, MikroB 16423 "24118 addendum": the "Minden verdikt" row (gate-worktree-pattern
  // + atomic-fact-gate-protocol, plus redhat-gate-pattern for RedHat and
  // sp-verification-before-completion for QA) was measured MISSING from all three generated
  // family tables (gate-worktree-pattern=0, atomic-fact-gate-protocol=0 in all 5 live
  // agents/*/CLAUDE.md), and nothing pinned it -- reverting the 4-file fix left 59/59 tests green.
  // These assertions pin the row at the source-function level, the same technique the backend
  // family test above (line ~103) already uses for its own curated table.
  it('QA/WhiteHat/RedHat family tables each carry a "Minden verdikt" row naming their gate skills', () => {
    const qaFn = SCAFFOLD.slice(
      SCAFFOLD.indexOf('function buildQaFamilySkillUsageBody('),
      SCAFFOLD.indexOf('function buildWhiteHatFamilySkillUsageBody('),
    )
    expect(qaFn).toMatch(/Minden verdikt.*gate-worktree-pattern.*atomic-fact-gate-protocol.*sp-verification-before-completion/)

    const whiteHatFn = SCAFFOLD.slice(
      SCAFFOLD.indexOf('function buildWhiteHatFamilySkillUsageBody('),
      SCAFFOLD.indexOf('function buildRedHatFamilySkillUsageBody('),
    )
    expect(whiteHatFn).toMatch(/Minden verdikt.*gate-worktree-pattern.*atomic-fact-gate-protocol/)

    const redHatFn = SCAFFOLD.slice(
      SCAFFOLD.indexOf('function buildRedHatFamilySkillUsageBody('),
      SCAFFOLD.indexOf('function buildBackendFamilySkillUsageBody('),
    )
    expect(redHatFn).toMatch(/Minden verdikt.*gate-worktree-pattern.*redhat-gate-pattern.*atomic-fact-gate-protocol/)
  })

  // Peti-approved addendum 24118: ponytail in the QA simplicity row, and a store/repomix.sh row
  // in all three gate families -- measured 0 in all 5 live agents/*/CLAUDE.md before this fix.
  it('QA simplicity row carries ponytail, and all three gate families carry a repomix.sh row', () => {
    const qaFn = SCAFFOLD.slice(
      SCAFFOLD.indexOf('function buildQaFamilySkillUsageBody('),
      SCAFFOLD.indexOf('function buildWhiteHatFamilySkillUsageBody('),
    )
    expect(qaFn).toMatch(/Minden gate.*karpathy-guidelines.*ponytail/)

    for (const [start, end] of [
      ['function buildQaFamilySkillUsageBody(', 'function buildWhiteHatFamilySkillUsageBody('],
      ['function buildWhiteHatFamilySkillUsageBody(', 'function buildRedHatFamilySkillUsageBody('],
      ['function buildRedHatFamilySkillUsageBody(', 'function buildBackendFamilySkillUsageBody('],
    ] as const) {
      const fn = SCAFFOLD.slice(SCAFFOLD.indexOf(start), SCAFFOLD.indexOf(end))
      expect(fn, `${start} is missing the repomix.sh row`).toContain('store/repomix.sh')
    }
  })
})
