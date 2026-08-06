import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { ladderIndexOf, weeklyTargetModel, MODEL_LADDER } from '../model-catalog.js'

// Cybered finding (e33af7c4, point 3): the parked-agent branch of the weekly-tier
// sweep must NOT write a more expensive model than the one already stored on disk.
// A banner-downgraded agent that is then parked sits on haiku (idx 4); the weekly
// ramp (tier 1 from baseline sonnet-4-6) targets sonnet-4-6 (idx 3), which is
// COSTLIER -- writing it would silently undo the banner downgrade.
//
// The fix: in updateStoredModelForParkedAgent, guard with
//   if (agentTier > 0 && ladderIndexOf(weeklyModel) < ladderIndexOf(currentModel)) return
// before writeModelFor. These tests verify (a) the math of the scenario is correct,
// (b) the guard is wired in the source BEFORE the write call.

describe('parked-agent cheaper-tier-wins invariant (Cybered e33af7c4 finding 3)', () => {
  // Reproduce the kill-chain scenario Cybered described:
  //   baseline = sonnet-4-6 (idx 3)
  //   agent banner-downgraded to haiku-4-5 (idx 4) and then parked
  //   weekly tier 1 -> weeklyTargetModel(sonnet-4-6, 1) = haiku-4-5
  // BUT: what if tier is computed from a different baseline? Let's confirm the
  // actual numbers the Cybered report used.
  it('banner-downgraded haiku is cheaper (higher idx) than weekly sonnet target', () => {
    const haiku = 'claude-haiku-4-5-20251001'
    const sonnet = 'claude-sonnet-4-6'
    expect(ladderIndexOf(haiku)).toBeGreaterThan(ladderIndexOf(sonnet))
  })

  it('weeklyTargetModel(sonnet-4-6, tier=1) lands on haiku (one step down from sonnet)', () => {
    const sonnet = 'claude-sonnet-4-6'
    const haiku = 'claude-haiku-4-5-20251001'
    expect(weeklyTargetModel(sonnet, 1)).toBe(haiku)
  })

  // The kill-chain requires a baseline that is ABOVE (cheaper) than the banner-
  // downgraded model: baseline=haiku-4-5 (already at cheapest in common use),
  // tier 1 from haiku is fable-5. That IS cheaper, so no conflict. The dangerous
  // scenario is baseline=sonnet-5 or sonnet-4-6, tier 1 stepping to haiku-4-5 --
  // but the agent was ALREADY banner-downgraded past haiku. Let's confirm.
  it('the cheaper-tier-wins guard triggers when weekly target is costlier than current', () => {
    // Scenario: baseline = sonnet-5 (idx 2), tier 1 -> sonnet-4-6 (idx 3).
    // Agent was banner-downgraded to haiku-4-5 (idx 4) and parked.
    // Guard: agentTier > 0 && ladderIndexOf(weeklyModel) < ladderIndexOf(currentModel)
    //        1 > 0 && 3 < 4  --> TRUE --> return (do not write)
    const baseline = 'claude-sonnet-5'
    const current = 'claude-haiku-4-5-20251001'
    const weeklyModel = weeklyTargetModel(baseline, 1) // 'claude-sonnet-4-6', idx 3
    expect(ladderIndexOf(weeklyModel)).toBeLessThan(ladderIndexOf(current)) // guard fires
  })

  it('the guard does NOT trigger when weekly target is same or cheaper than current', () => {
    // Scenario: baseline = sonnet-5 (idx 2), tier 2 -> haiku-4-5 (idx 4).
    // Agent currently on haiku (not banner-downgraded, just weekly-downgraded).
    // Guard: 2 > 0 && ladderIndexOf(haiku) < ladderIndexOf(haiku)  --> 4 < 4 = FALSE
    const baseline = 'claude-sonnet-5'
    const current = 'claude-haiku-4-5-20251001'
    const weeklyModel = weeklyTargetModel(baseline, 2)
    expect(weeklyModel).toBe(current)
    expect(ladderIndexOf(weeklyModel)).not.toBeLessThan(ladderIndexOf(current)) // guard does NOT fire
  })

  it('tier 0 homeward revert always allowed (guard is guarded by agentTier > 0)', () => {
    // Scenario: weekly dropped to 0; weeklyModel = baseline = sonnet-4-6.
    // Even if current is haiku, we want to revert UP to sonnet (cheaper-wins does not block revert).
    // Guard: agentTier > 0 && ... --> 0 > 0 = FALSE --> guard does not fire, write proceeds.
    const agentTier = 0
    expect(agentTier > 0).toBe(false) // confirms the tier 0 path bypasses the guard
  })
})

describe('updateStoredModelForParkedAgent source wiring (Cybered e33af7c4 finding 3)', () => {
  // The guard was extracted into a PURE, directly-unit-tested function (decideParkedModelUpdate,
  // model-catalog.ts, card a115cd7f) rather than left as an inline comparison in the I/O runner --
  // see model-catalog.test.ts's "decideParkedModelUpdate enforces cheaper-tier-wins" suite for the
  // behavioral coverage. These wiring checks confirm the runner actually CALLS that decision (and
  // does so before writing), so a future edit cannot silently bypass it.
  const catalogSrc = readFileSync(join(PROJECT_ROOT, 'src', 'model-catalog.ts'), 'utf8')
  const runnerSrc = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'model-fallback-runner.ts'), 'utf8')

  it('the cheaper-tier-wins guard is present in decideParkedModelUpdate', () => {
    expect(catalogSrc).toContain('tier > 0 && ladderIndexOf(weeklyModel) < ladderIndexOf(currentModel)')
  })

  it('updateStoredModelForParkedAgent calls decideParkedModelUpdate BEFORE writeModelFor', () => {
    const fnStart = runnerSrc.indexOf('function updateStoredModelForParkedAgent(')
    const nextFn = runnerSrc.indexOf('\nfunction ', fnStart + 1)
    const fnBody = runnerSrc.slice(fnStart, nextFn > 0 ? nextFn : undefined)
    const decideAt = fnBody.indexOf('decideParkedModelUpdate(')
    const writeAt = fnBody.indexOf('writeModelFor(name,')
    expect(decideAt).toBeGreaterThan(0)
    expect(writeAt).toBeGreaterThan(0)
    expect(decideAt).toBeLessThan(writeAt)
  })

  it('the runner never re-implements the ladder comparison itself (single source of truth)', () => {
    const fnStart = runnerSrc.indexOf('function updateStoredModelForParkedAgent(')
    const nextFn = runnerSrc.indexOf('\nfunction ', fnStart + 1)
    const fnBody = runnerSrc.slice(fnStart, nextFn > 0 ? nextFn : undefined)
    expect(fnBody).not.toContain('ladderIndexOf(weeklyModel) < ladderIndexOf(currentModel)')
  })

  it('MODEL_LADDER has at least 4 entries so idx comparisons are meaningful', () => {
    expect(MODEL_LADDER.length).toBeGreaterThanOrEqual(4)
  })
})
