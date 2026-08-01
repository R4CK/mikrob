import { describe, it, expect } from 'vitest'
import {
  CLAUDE_MODELS,
  MODEL_LADDER,
  ladderIndexOf,
  weeklyTargetModel,
} from '../model-catalog.js'

describe('the model ladder is one coherent source (card 5d2002b5)', () => {
  it('every dropdown model has a rung on the ladder, and vice versa', () => {
    // The whole point of the redesign: one list, no drift. A model in the picker with no ladder rung
    // could be assigned but never tier-stepped; a rung with no picker entry is a target nobody can be.
    const pickerIds = new Set(CLAUDE_MODELS.map((m) => m.id))
    const ladderIds = new Set(MODEL_LADDER)
    expect([...pickerIds].filter((id) => !ladderIds.has(id))).toEqual([])
    expect([...ladderIds].filter((id) => !pickerIds.has(id))).toEqual([])
  })

  it('the ladder is capability/price DESCENDING (Opus 5 first, Fable last)', () => {
    expect(MODEL_LADDER[0]).toBe('claude-opus-5')
    expect(MODEL_LADDER[MODEL_LADDER.length - 1]).toBe('claude-fable-5')
    expect(ladderIndexOf('claude-opus-5')).toBeLessThan(ladderIndexOf('claude-sonnet-5'))
    expect(ladderIndexOf('claude-sonnet-5')).toBeLessThan(ladderIndexOf('claude-haiku-4-5-20251001'))
  })

  it('an unrecognised model is treated as the TOP rung, never promoted', () => {
    // An OpenRouter id or a typo must read as a full-capability base: the stepdown can only move it
    // down from 0, never silently upgrade it to something dearer.
    expect(ladderIndexOf('openrouter-auto:frontier')).toBe(0)
    expect(ladderIndexOf('')).toBe(0)
  })
})

describe('weeklyTargetModel steps each agent from its OWN base (the bug this fixes)', () => {
  it('tier 0 keeps the base model', () => {
    expect(weeklyTargetModel('claude-opus-5', 0)).toBe('claude-opus-5')
    expect(weeklyTargetModel('claude-haiku-4-5-20251001', 0)).toBe('claude-haiku-4-5-20251001')
  })

  it('an OPUS-based and a SONNET-based agent land on DIFFERENT models at the same tier', () => {
    // The old code used the tier as an absolute chain index, so both of these returned chain[1].
    // That is exactly the defect: a Sonnet agent should not be stepped onto Opus's cheaper neighbour.
    const opusAtT1 = weeklyTargetModel('claude-opus-5', 1)
    const sonnetAtT1 = weeklyTargetModel('claude-sonnet-5', 1)
    expect(opusAtT1).toBe('claude-opus-4-8[1m]') // one rung below Opus 5
    expect(sonnetAtT1).toBe('claude-sonnet-4-6') // one rung below Sonnet 5
    expect(opusAtT1).not.toBe(sonnetAtT1)
  })

  it('tier 2 steps two rungs from the base', () => {
    expect(weeklyTargetModel('claude-opus-5', 2)).toBe('claude-sonnet-5')
  })

  it('an agent already near the bottom clamps at the cheapest, never off the end', () => {
    // A Haiku-based agent at tier 2 cannot step past Fable; it does not wrap or return undefined.
    expect(weeklyTargetModel('claude-haiku-4-5-20251001', 2)).toBe('claude-fable-5')
    expect(weeklyTargetModel('claude-fable-5', 2)).toBe('claude-fable-5')
  })

  it('an unknown base is treated as the top, so it can only step DOWN', () => {
    expect(weeklyTargetModel('some-openrouter-model', 1)).toBe('claude-opus-4-8[1m]')
  })
})
