import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'
import { SCAFFOLD_SWEEP_INTERVAL_MS } from '../web/scaffold-section-sweeper.js'

// Card 75a6fbe6. The sweeper's VALUE is entirely in being wired and in being reached on a timer --
// a correct sweep function that nothing calls is the same as no sweep, which is precisely the
// failure this card is about (a control present in the code and absent from 9 of 15 agents).
// So the assertions below are about WIRING and SHAPE, not about the ensure* writers themselves:
// those already have their own suites, and re-testing them here would pass whether or not the
// sweeper ever runs.
const SWEEPER = readFileSync(join(REPO_ROOT, 'src', 'web', 'scaffold-section-sweeper.ts'), 'utf-8')
const WEB = readFileSync(join(REPO_ROOT, 'src', 'web.ts'), 'utf-8')

describe('scaffold-section sweeper: wiring (card 75a6fbe6)', () => {
  it('is STARTED from web.ts, not merely defined', () => {
    // The whole defect class this card belongs to: a module that exists and is never reached.
    expect(WEB).toContain("import { startScaffoldSectionSweeper } from './web/scaffold-section-sweeper.js'")
    expect(WEB).toMatch(/startScaffoldSectionSweeper\(\)/)
  })

  it('is webOnly-GUARDED, like every other section writer in that file', () => {
    // A staging/WEB_ONLY copy must never rewrite the live fleet's persona files. The existing
    // ensure* calls in web.ts carry that guard and say why; a sweeper without it would hand a
    // staging instance a fleet-wide write loop.
    expect(WEB).toMatch(/scaffoldSweepInterval = webOnly \? undefined : startScaffoldSectionSweeper\(\)/)
  })

  it('is CLEARED on shutdown, like its sibling watcher', () => {
    // Its sibling (selfAdvanceClearInterval) is cleared; an interval that outlives shutdown keeps
    // the process alive and keeps writing after the server believes it stopped.
    expect(WEB).toContain('if (scaffoldSweepInterval) clearInterval(scaffoldSweepInterval)')
  })
})

describe('scaffold-section sweeper: shape', () => {
  it('sweeps the SAME writers start-time already applies -- three for main, five for sub-agents', () => {
    // Scope discipline: this card is about propagating existing sections, not adding new ones.
    // If someone later adds a writer here that agent start does NOT apply, the sweep would start
    // introducing a section no fresh agent gets -- a silent divergence between the two paths.
    for (const fn of ['ensureAutonomySection', 'ensureSkillsPathTrapSection', 'ensureSystemDirectiveAuthSection']) {
      expect(SWEEPER, `${fn} missing`).toContain(fn)
    }
    for (const fn of ['ensureFleetRosterSection', 'ensureLocalFirstSection']) {
      expect(SWEEPER, `${fn} missing`).toContain(fn)
    }
    // The main agent must NOT get the two sub-agent-only writers: web.ts does not give them to it.
    const mainBlock = SWEEPER.slice(SWEEPER.indexOf('ensureAutonomySection(MAIN_AGENT_ID)'), SWEEPER.indexOf('for (const name of listAgentNames'))
    expect(mainBlock).not.toContain('ensureFleetRosterSection')
    expect(mainBlock).not.toContain('ensureLocalFirstSection')
  })

  it('is FAIL-SOFT PER AGENT -- one bad file must not stop the rest', () => {
    // A sweep that aborts halfway recreates the partial coverage it exists to end, and silently:
    // the un-swept agents look untouched rather than failed.
    const loop = SWEEPER.slice(SWEEPER.indexOf('for (const name of listAgentNames'))
    expect(loop).toContain('try {')
    expect(loop).toContain('catch')
    expect(loop).toContain('(continuing)')
  })

  it('does not skip the main agent by looping it twice', () => {
    // MAIN_AGENT_ID is handled before the loop; listAgentNames() may also contain it.
    expect(SWEEPER).toContain('if (name === MAIN_AGENT_ID) continue')
  })

  it('runs on a bounded, sane cadence', () => {
    // Not a correctness bound, a sanity one: a few minutes is pointless churn, a day is not a
    // control. The writers no-op when nothing changed, so the cost of the interval is file reads.
    expect(SCAFFOLD_SWEEP_INTERVAL_MS).toBeGreaterThanOrEqual(5 * 60 * 1000)
    expect(SCAFFOLD_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(60 * 60 * 1000)
  })
})
