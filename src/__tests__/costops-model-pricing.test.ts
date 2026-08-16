import { describe, it, expect } from 'vitest'
import { estimateCostUsd, stripDateSuffix, MODEL_PRICING } from '../costops/model-pricing.js'

describe('costops stripDateSuffix', () => {
  it('strips a trailing YYYYMMDD snapshot suffix', () => {
    expect(stripDateSuffix('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
  })
  it('leaves a model id with no date suffix untouched', () => {
    expect(stripDateSuffix('claude-sonnet-5')).toBe('claude-sonnet-5')
  })
  it('does not strip a short numeric tail that is not 8 digits', () => {
    expect(stripDateSuffix('claude-opus-4-8')).toBe('claude-opus-4-8')
  })
})

describe('costops estimateCostUsd', () => {
  it('prices input/output tokens at the model rate', () => {
    // claude-sonnet-5: $2/$10 per MTok (intro price)
    const cost = estimateCostUsd('claude-sonnet-5', {
      input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0,
    })
    expect(cost).toBe(2.0)
  })

  it('bills thinking tokens at the output rate', () => {
    const withThinking = estimateCostUsd('claude-sonnet-5', {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 1_000_000,
    })
    const output = estimateCostUsd('claude-sonnet-5', {
      input_tokens: 0, output_tokens: 1_000_000, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0,
    })
    expect(withThinking).toBe(output)
    expect(withThinking).toBe(10.0)
  })

  it('discounts cache reads to 0.1x the input rate', () => {
    const cost = estimateCostUsd('claude-sonnet-5', {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000, cache_creation_tokens: 0, thinking_tokens: 0,
    })
    expect(cost).toBeCloseTo(0.2, 10) // 2.0 * 0.1
  })

  it('surcharges cache writes at 1.25x the input rate (5-minute TTL)', () => {
    const cost = estimateCostUsd('claude-sonnet-5', {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 1_000_000, thinking_tokens: 0,
    })
    expect(cost).toBeCloseTo(2.5, 10) // 2.0 * 1.25
  })

  it('strips a date-suffixed model id before lookup', () => {
    const suffixed = estimateCostUsd('claude-haiku-4-5-20251001', {
      input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0,
    })
    const bare = estimateCostUsd('claude-haiku-4-5', {
      input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0,
    })
    expect(suffixed).toBe(bare)
    expect(suffixed).toBe(1.0)
  })

  it('returns null (never a fabricated price) for an unrecognized model', () => {
    expect(estimateCostUsd('gpt-4o', {
      input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0,
    })).toBeNull()
    expect(estimateCostUsd('<synthetic>', {
      input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0,
    })).toBeNull()
  })

  it('returns null for a missing model rather than treating it as free', () => {
    expect(estimateCostUsd(null, { input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0 })).toBeNull()
    expect(estimateCostUsd(undefined, { input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0 })).toBeNull()
    expect(estimateCostUsd('', { input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0 })).toBeNull()
  })

  it('covers every model this repo has actually recorded (live DB sweep, 2026-08-16)', () => {
    // Measured against store/claudeclaw.db: claude-sonnet-5, claude-sonnet-4-6, claude-opus-5,
    // claude-opus-4-8, claude-haiku-4-5-20251001 are the only non-null/non-synthetic values on
    // record. If any of these stop resolving, real usage silently stops being priced.
    const recorded = ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001']
    for (const model of recorded) {
      const cost = estimateCostUsd(model, { input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0 })
      expect(cost, `${model} should resolve to a known rate`).not.toBeNull()
    }
  })

  it('the pricing table itself has no negative or zero rates', () => {
    for (const [model, rate] of Object.entries(MODEL_PRICING)) {
      expect(rate.inputPerMTok, model).toBeGreaterThan(0)
      expect(rate.outputPerMTok, model).toBeGreaterThan(0)
    }
  })
})
