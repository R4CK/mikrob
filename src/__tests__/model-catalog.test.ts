import { describe, it, expect } from 'vitest'
import {
  CLAUDE_MODELS,
  MODEL_LADDER,
  ladderIndexOf,
  weeklyTargetModel,
  buildAgentTierRows,
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

describe('buildAgentTierRows assembles the read-only display (redesign point 4)', () => {
  it('an exempt agent is pinned to tier 0 and its target equals its base', () => {
    // mikrob-channels never steps down by the weekly %, even when the fleet is at tier 2.
    const [row] = buildAgentTierRows(
      [{ name: 'mikrob-channels', baseModel: 'claude-opus-5', currentModel: 'claude-opus-5', exempt: true }],
      2,
    )
    expect(row.exempt).toBe(true)
    expect(row.tier).toBe(0)
    expect(row.targetModel).toBe('claude-opus-5')
  })

  it('two agents at the same fleet tier target DIFFERENT models by their base (the core fix, end to end)', () => {
    const rows = buildAgentTierRows(
      [
        { name: 'opus-agent', baseModel: 'claude-opus-5', currentModel: 'claude-opus-5', exempt: false },
        { name: 'haiku-agent', baseModel: 'claude-haiku-4-5-20251001', currentModel: 'claude-haiku-4-5-20251001', exempt: false },
      ],
      1,
    )
    expect(rows[0].targetModel).toBe('claude-opus-4-8[1m]')
    expect(rows[1].targetModel).toBe('claude-fable-5') // Haiku's one rung down is the last, clamped
    expect(rows[0].targetModel).not.toBe(rows[1].targetModel)
  })

  it('labels resolve from the catalog, and an off-catalog id falls back to the raw id', () => {
    const [row] = buildAgentTierRows(
      [{ name: 'a', baseModel: 'openrouter-x', currentModel: 'openrouter-x', exempt: false }],
      0,
    )
    expect(row.baseLabel).toBe('openrouter-x') // no blank for an unknown model
    const [known] = buildAgentTierRows(
      [{ name: 'b', baseModel: 'claude-opus-5', currentModel: 'claude-opus-5', exempt: false }],
      0,
    )
    expect(known.baseLabel).toBe('Opus 5 (legújabb Opus)')
  })

  it('current model distinct from base is preserved (a stepped-down agent shows both)', () => {
    const [row] = buildAgentTierRows(
      [{ name: 'a', baseModel: 'claude-opus-5', currentModel: 'claude-sonnet-5', exempt: false }],
      2,
    )
    expect(row.baseModel).toBe('claude-opus-5')
    expect(row.currentModel).toBe('claude-sonnet-5')
    expect(row.targetModel).toBe('claude-sonnet-5') // opus base, tier 2 => two rungs down
  })
})
