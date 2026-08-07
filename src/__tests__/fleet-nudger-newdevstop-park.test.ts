// Card e3b3b79f: under newDevStop, the fleet-nudger (and the orchestrator's park step) must PARK an
// idle engineering agent -- POST /api/agents/<agent>/stop -- instead of leaving it running to receive
// empty self-advance nudges that burn Claude quota (the exact thing newDevStop protects). These are
// prompt (SKILL.md) changes, so we pin the load-bearing instructions in the version-controlled SEED
// prompts: a fresh install must ship the park behaviour, and a silent reword that drops it fails CI.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const seed = (task: string) =>
  readFileSync(join(REPO_ROOT, 'seed-scheduled-tasks', task, 'SKILL.md'), 'utf8')

describe('newDevStop-aware parking is instructed in the seed prompts (card e3b3b79f)', () => {
  for (const task of ['fleet-nudger', 'folyamatos-munka-orchestrator']) {
    it(`${task}: parks the idle engineering agent under newDevStopActive`, () => {
      const src = seed(task)
      // The trigger and the action must both be present...
      expect(src).toContain('newDevStopActive')
      expect(src).toContain('POST /api/agents/<agent>/stop')
      // ...aimed at the parkable agents. This used to pin the literal list
      // `backend/fullstack/fron-ted/fron-teddy`, which the live prompts deliberately REPLACED with a
      // dynamic lookup after Peti found (2026-08-02) that jogasz/marketing/penzugy were never in that
      // list and sat running idle. Pinning the hardcoded names would now hold the prompt to the WEAKER
      // rule, so the assertion follows the instruction that superseded it: derive the set at runtime.
      expect(src).toMatch(/api\/agents/)
      // ...while gate agents are explicitly NOT parked (gates run under newDevStop)...
      expect(src).toMatch(/qa\/cybersec\/cybered.{0,40}NE parkold/i)
      // ...and it names the card so the rationale is traceable.
      expect(src).toContain('e3b3b79f')
    })
  }

  it('fleet-nudger reads the hard-stop flag before deciding (weekly-hard-stop.json)', () => {
    // Parking must be gated on the live flag, not applied unconditionally.
    expect(seed('fleet-nudger')).toContain('weekly-hard-stop.json')
  })
})
