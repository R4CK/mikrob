import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { MODEL_PINNED_AGENTS, isModelPinned, weeklyTargetModel } from '../model-catalog.js'
import { weeklyTierIndex, DEFAULT_WEEKLY_TIER1_PERCENT, DEFAULT_WEEKLY_TIER2_PERCENT } from '../model-fallback.js'

// Peti decision (Telegram 11011, 2026-10-11, card d8d035f8): the fleet's two security gates
// (WhiteHat = cybersec + cybersec2, RedHat = cybered) must stay on claude-sonnet-5-5 -- the weekly
// cost ramp (and the 5h-banner fallback) must never step them down. A downgraded review gate is the
// same "151/151 green, 2 MAJOR bugs hidden" risk the mandatory-gate rule (CLAUDE.md 4.) exists to
// prevent in the first place.

describe('MODEL_PINNED_AGENTS / isModelPinned (card d8d035f8)', () => {
  it('pins exactly the three security-gate agents', () => {
    expect(isModelPinned('cybersec')).toBe(true)
    expect(isModelPinned('cybersec2')).toBe(true)
    expect(isModelPinned('cybered')).toBe(true)
  })

  it('does not pin an unrelated agent', () => {
    expect(isModelPinned('backend2')).toBe(false)
    expect(isModelPinned('qa')).toBe(false)
    expect(isModelPinned('mikrob-channels')).toBe(false)
  })

  it('MODEL_PINNED_AGENTS is exactly the 3-agent set (no accidental extra scope)', () => {
    expect([...MODEL_PINNED_AGENTS].sort()).toEqual(['cybered', 'cybersec', 'cybersec2'])
  })
})

describe('at 99% weekly, a pinned agent stays put while a non-pinned agent steps down', () => {
  // This mirrors exactly what the runner computes: weeklyTierIndex() picks the fleet tier from the
  // live %, then weeklyTargetModel() steps a NON-pinned agent's own base down the ladder. A pinned
  // agent never reaches either call (see the wiring tests below) -- its model is simply never touched.
  const cfg = { weeklyTier1Percent: DEFAULT_WEEKLY_TIER1_PERCENT, weeklyTier2Percent: DEFAULT_WEEKLY_TIER2_PERCENT }
  const tier = weeklyTierIndex(99, cfg, 0)

  it('99% crosses both weekly thresholds (tier 2, the deepest step)', () => {
    expect(tier).toBe(2)
  })

  it('a non-pinned agent on claude-sonnet-5 is stepped away from its base at tier 2', () => {
    const base = 'claude-sonnet-5'
    const target = weeklyTargetModel(base, tier)
    expect(target).not.toBe(base)
  })

  it('a pinned agent is exempt regardless of tier -- isModelPinned alone decides, the % never matters', () => {
    expect(isModelPinned('cybersec')).toBe(true)
    expect(isModelPinned('cybersec2')).toBe(true)
    expect(isModelPinned('cybered')).toBe(true)
    // The model the runner would otherwise have computed for them is irrelevant: see the wiring
    // tests below -- checkAgent() returns before ever calling weeklyTargetModel for a pinned name.
  })
})

describe('checkAgent / updateStoredModelForParkedAgent source wiring (card d8d035f8)', () => {
  const runnerSrc = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'model-fallback-runner.ts'), 'utf8')

  it('model-fallback-runner.ts imports isModelPinned from model-catalog.js', () => {
    expect(runnerSrc).toContain('isModelPinned')
  })

  it('checkAgent returns on isModelPinned BEFORE the parked-agent branch (banner+weekly both skipped)', () => {
    const fnStart = runnerSrc.indexOf('async function checkAgent(')
    expect(fnStart).toBeGreaterThan(0)
    const nextFn = runnerSrc.indexOf('\n/**', fnStart + 1)
    const fnBody = runnerSrc.slice(fnStart, nextFn > 0 ? nextFn : undefined)
    const pinAt = fnBody.indexOf('if (isModelPinned(name)) return')
    const parkedBranchAt = fnBody.indexOf('updateStoredModelForParkedAgent(name, weeklyIdx)')
    expect(pinAt).toBeGreaterThan(0)
    expect(parkedBranchAt).toBeGreaterThan(0)
    expect(pinAt).toBeLessThan(parkedBranchAt)
  })

  it('updateStoredModelForParkedAgent ALSO guards itself (defense in depth), before reading/writing a model', () => {
    const fnStart = runnerSrc.indexOf('function updateStoredModelForParkedAgent(')
    expect(fnStart).toBeGreaterThan(0)
    const nextFn = runnerSrc.indexOf('\nfunction ', fnStart + 1)
    const fnBody = runnerSrc.slice(fnStart, nextFn > 0 ? nextFn : undefined)
    const pinAt = fnBody.indexOf('if (isModelPinned(name)) return')
    const readAt = fnBody.indexOf('readModelFor(name)')
    expect(pinAt).toBeGreaterThan(0)
    expect(readAt).toBeGreaterThan(0)
    expect(pinAt).toBeLessThan(readAt)
  })

  it('readFleetTierState marks a pinned agent exempt for the dashboard display too', () => {
    const fnStart = runnerSrc.indexOf('export function readFleetTierState(')
    expect(fnStart).toBeGreaterThan(0)
    const nextFn = runnerSrc.indexOf('\nexport function ', fnStart + 1)
    const fnBody = runnerSrc.slice(fnStart, nextFn > 0 ? nextFn : undefined)
    expect(fnBody).toContain('collect(name, isModelPinned(name))')
  })
})
