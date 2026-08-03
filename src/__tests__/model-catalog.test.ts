import { describe, it, expect } from 'vitest'
import {
  CLAUDE_MODELS,
  MODEL_LADDER,
  ladderIndexOf,
  weeklyTargetModel,
  buildAgentTierRows,
  decideParkedModelUpdate,
  applyNoHaikuFloor,
  NO_HAIKU_AGENTS,
} from '../model-catalog.js'

describe('the model ladder is one coherent source (card 5d2002b5)', () => {
  it('every ladder rung is a pickable model; the picker may carry extra off-ladder models', () => {
    // A rung with no picker entry is a target nobody can be assigned -- still forbidden.
    // But since 2026-08-03 (Peti's per-agent-chain policy) the picker MAY expose a model that is not a
    // ramp rung: Opus 4.8 stays selectable but was removed from the ladder, so an operator can still
    // pick it while the weekly ramp leaves an Opus-4.8 base alone (off-ladder = never stepped).
    const pickerIds = new Set(CLAUDE_MODELS.map((m) => m.id))
    const ladderIds = new Set(MODEL_LADDER)
    expect([...ladderIds].filter((id) => !pickerIds.has(id))).toEqual([])
    expect([...pickerIds].filter((id) => !ladderIds.has(id))).toEqual(['claude-opus-4-8[1m]'])
  })

  it('the ladder is capability/price DESCENDING (Fable 5 first, Haiku last)', () => {
    // Corrected 2026-08-02 (Peti caught it): Anthropic prices Fable 5 ABOVE Opus 5
    // ($10/$50 vs $5/$25 per MTok) and calls it "the most capable widely released model" --
    // it is the top rung, not the bottom. A prior session had guessed the opposite with no
    // benchmark backing it, purely from the name sounding like a lighter/creative model.
    expect(MODEL_LADDER[0]).toBe('claude-fable-5')
    expect(MODEL_LADDER[MODEL_LADDER.length - 1]).toBe('claude-haiku-4-5-20251001')
    expect(ladderIndexOf('claude-fable-5')).toBeLessThan(ladderIndexOf('claude-opus-5'))
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
    expect(opusAtT1).toBe('claude-sonnet-5') // one rung below Opus 5 (Opus 4.8 removed from ladder 2026-08-03)
    expect(sonnetAtT1).toBe('claude-sonnet-4-6') // one rung below Sonnet 5
    expect(opusAtT1).not.toBe(sonnetAtT1)
  })

  it('tier 2 steps two rungs from the base', () => {
    expect(weeklyTargetModel('claude-opus-5', 2)).toBe('claude-sonnet-4-6') // Opus 5 -> Sonnet 5 -> Sonnet 4.6
  })

  it('an agent already near the bottom clamps at the cheapest, never off the end', () => {
    // A Haiku-based agent at tier 2 cannot step past Haiku (now the actual cheapest rung); it does
    // not wrap or return undefined.
    expect(weeklyTargetModel('claude-haiku-4-5-20251001', 2)).toBe('claude-haiku-4-5-20251001')
  })

  it('a Fable-based agent steps DOWN the ladder like any other base (Fable is the top rung now)', () => {
    // Fable 5 is the most capable/priciest rung (corrected 2026-08-02), so stepping it down moves
    // toward Opus, not toward itself -- the reverse of the old (wrong) placement.
    expect(weeklyTargetModel('claude-fable-5', 1)).toBe('claude-opus-5')
    expect(weeklyTargetModel('claude-fable-5', 2)).toBe('claude-sonnet-5') // Fable -> Opus 5 -> Sonnet 5
  })

  it('an OFF-CATALOG base is left on its own model, never rewritten onto Claude by the weekly ramp', () => {
    // Cybered HIGH (card 5d2002b5): an agent deliberately on Ollama/DeepSeek/OpenRouter must NOT be
    // stepped onto a paid Claude model when the weekly % climbs -- that would burn the quota the ramp
    // protects and undo the offload. Its weekly target is always itself, at every tier.
    expect(weeklyTargetModel('some-openrouter-model', 1)).toBe('some-openrouter-model')
    expect(weeklyTargetModel('ollama:deepseek-coder', 2)).toBe('ollama:deepseek-coder')
    // and it is emphatically NOT any ladder (Claude) model
    expect(MODEL_LADDER).not.toContain(weeklyTargetModel('some-openrouter-model', 2))
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
    expect(rows[0].targetModel).toBe('claude-sonnet-5') // Opus 5 base, tier 1 => one rung down
    expect(rows[1].targetModel).toBe('claude-haiku-4-5-20251001') // Haiku is the last rung, clamps to itself
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
    expect(row.targetModel).toBe('claude-sonnet-4-6') // opus base, tier 2 => two rungs down
  })

  it('an off-catalog agent at a non-zero tier targets its OWN model, not a Claude rung (Cybered HIGH)', () => {
    // The display must not tell the operator that an Ollama/OpenRouter agent will be stepped onto
    // Claude at tier 2 -- because it will not (weeklyTargetModel leaves off-ladder bases alone).
    const [row] = buildAgentTierRows(
      [{ name: 'local', baseModel: 'ollama:deepseek-coder', currentModel: 'ollama:deepseek-coder', exempt: false }],
      2,
    )
    expect(row.tier).toBe(2) // it IS at the fleet tier...
    expect(row.targetModel).toBe('ollama:deepseek-coder') // ...but its target stays its own model
    expect(MODEL_LADDER).not.toContain(row.targetModel)
  })
})

// Cybered finding on card e33af7c4 (card a115cd7f, LOW): the PARKED-agent path must not silently
// undo a cheaper model an agent already sits on (e.g. its own banner-fallback axis already dropped
// it to Haiku before it got parked) by writing the weekly tier's target back UP over it.
describe('decideParkedModelUpdate enforces "cheaper tier wins" for parked agents (card a115cd7f)', () => {
  it('writes the weekly target when the parked agent is still on its (pricier) base', () => {
    const action = decideParkedModelUpdate('claude-sonnet-5', null, 1)
    expect(action).toEqual({ kind: 'write', model: 'claude-sonnet-4-6' })
  })

  it('does NOT write a pricier weekly target over an already-cheaper current model', () => {
    // The agent is on Haiku (its own banner axis dropped it further than the weekly target would),
    // baseline says Sonnet 5 -> weekly target at tier 1 is Sonnet 4.6, which is MORE expensive than
    // Haiku. Writing it would undo the deeper downgrade -- must stay put.
    const action = decideParkedModelUpdate('claude-haiku-4-5-20251001', 'claude-sonnet-5', 1)
    expect(action).toEqual({ kind: 'none' })
  })

  it('writes when the parked agent is already exactly at the weekly target (idempotent no-op via none)', () => {
    const action = decideParkedModelUpdate('claude-sonnet-4-6', 'claude-sonnet-5', 1)
    expect(action).toEqual({ kind: 'none' })
  })

  it('at tier 0 (home), targets the recorded baseline regardless of ladder position', () => {
    // Tier 0 is a genuine revert -- climbing back UP to base is the correct direction, so the
    // cheaper-wins guard (which only applies at tier > 0) must not block it.
    const action = decideParkedModelUpdate('claude-haiku-4-5-20251001', 'claude-sonnet-5', 0)
    expect(action).toEqual({ kind: 'write', model: 'claude-sonnet-5' })
  })

  it('at tier 0 with no baseline and already-current model, nothing to do', () => {
    const action = decideParkedModelUpdate('claude-sonnet-5', null, 0)
    expect(action).toEqual({ kind: 'none' })
  })
})

// Peti policy (2026-08-03, option "b"): the ONLY agents floored off Haiku are the review gate QA/QA2 --
// the gate must not lose quality under the heaviest weekly pressure (nothing left to catch a missed
// bug). Everyone else follows their chain to its natural bottom, Haiku included: Peti deliberately
// routes the FE builders and support agents to Haiku at tier 2. The Opus-5-based coding agents never
// reach Haiku anyway (2-tier chain bottoms at Sonnet 4.6), so they need no floor entry.
describe('NO_HAIKU_AGENTS floors only the QA gate off the cheapest rung (Peti 2026-08-03, option b)', () => {
  it('lists exactly QA and QA2', () => {
    expect(NO_HAIKU_AGENTS).toEqual(new Set(['qa', 'qa2']))
  })

  it('clamps a QA-gate agent at Haiku up to Sonnet 4.6 instead', () => {
    expect(applyNoHaikuFloor('qa', 'claude-haiku-4-5-20251001')).toBe('claude-sonnet-4-6')
    expect(applyNoHaikuFloor('qa2', 'claude-haiku-4-5-20251001')).toBe('claude-sonnet-4-6')
  })

  it('is a no-op for a non-gate agent (FE builders and support DO reach Haiku), or a target that is not Haiku', () => {
    expect(applyNoHaikuFloor('fron-ted', 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
    expect(applyNoHaikuFloor('jogasz', 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
    expect(applyNoHaikuFloor('marketing', 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
    expect(applyNoHaikuFloor('qa', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  it('decideParkedModelUpdate applies the QA floor when given the agent name', () => {
    // qa at tier 2 from a Sonnet 5 baseline would normally land on Haiku -- floored to Sonnet 4.6.
    const stillHigher = decideParkedModelUpdate('claude-sonnet-5', 'claude-sonnet-5', 2, 'qa')
    expect(stillHigher).toEqual({ kind: 'write', model: 'claude-sonnet-4-6' }) // floored, not Haiku
    // a non-gate FE builder is NOT floored: Sonnet 5 base at tier 2 goes all the way to Haiku.
    const feBuilder = decideParkedModelUpdate('claude-sonnet-5', 'claude-sonnet-5', 2, 'fron-ted')
    expect(feBuilder).toEqual({ kind: 'write', model: 'claude-haiku-4-5-20251001' })
  })

  it('omitting agentName preserves the unfloored behavior', () => {
    const action = decideParkedModelUpdate('claude-sonnet-5', 'claude-sonnet-5', 2)
    expect(action).toEqual({ kind: 'write', model: 'claude-haiku-4-5-20251001' })
  })
})
