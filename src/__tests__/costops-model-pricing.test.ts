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

  // Weekly pricing-reconciliation check (card 270e3ef4), 2026-08-17 run: the official pricing page
  // lists Opus 4.5 and several still-billable retired models (Opus 4.1/4, Sonnet 4, Haiku 3.5) this
  // table did not carry yet. None had appeared in token_usage yet, so nothing was silently
  // mispriced here (estimateCostUsd fails closed to null) -- but the SIBLING table in
  // web/app-token-usage.js WAS already silently mispricing Opus 4.5 via prefix-fallthrough (see
  // token-usage-pricing-fallthrough.test.ts). Pinned here so a future accidental removal of these
  // rows is caught the moment real usage would otherwise start going unpriced/tracked as a gap.
  it('resolves the models added in the 2026-08-17 reconciliation pass', () => {
    const added = ['claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-4', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-haiku-3-5']
    for (const model of added) {
      const cost = estimateCostUsd(model, { input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0 })
      expect(cost, `${model} should resolve to a known rate`).not.toBeNull()
    }
  })

  it('Opus 4.5 is priced at its own tier (5/25), not the old Opus 4/4.1 tier (15/75)', () => {
    const cost = estimateCostUsd('claude-opus-4-5', {
      input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0,
    })
    expect(cost).toBe(5.0)
  })

  // Weekly pricing-reconciliation check (card 270e3ef4), 2026-10-12 run: four new model IDs
  // appeared in token_usage (claude-fable-5-1, claude-haiku-5-5, claude-opus-5-5,
  // claude-sonnet-5-5). None had an explicit row; strict-equality lookup returned null for all.
  // Source: platform.claude.com/docs/en/about-claude/pricing fetched 2026-10-12.
  it('resolves the models added in the 2026-10-12 reconciliation pass', () => {
    const added = ['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']
    for (const model of added) {
      const cost = estimateCostUsd(model, { input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0 })
      expect(cost, `${model} should resolve to a known rate`).not.toBeNull()
    }
  })

  it('Opus 5.5 is priced at 4/20, not at the Opus 5 rate (5/25)', () => {
    const cost = estimateCostUsd('claude-opus-5-5', {
      input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0,
    })
    expect(cost).toBe(4.0)
  })

  // Weekly pricing-reconciliation check (card 270e3ef4), 2026-11-16 run: Opus 5.5 and Sonnet 5.5
  // price cache hits/refreshes at 0.05x base input, NOT the standard 0.1x every other model uses
  // (official pricing page footnote: "Cache hits and refreshes on Claude Opus 5.5 and Claude
  // Sonnet 5.5 are priced at 0.05x the base input price. All other models use the standard 0.1x
  // multiplier."). estimateCostUsd was applying the global 0.1x to everything, overcharging cache
  // reads on both by 2x. Source: platform.claude.com/docs/en/about-claude/pricing, card 808cd7fc.
  it('Opus 5.5 and Sonnet 5.5 discount cache reads to 0.05x input, not the standard 0.1x', () => {
    const opus55 = estimateCostUsd('claude-opus-5-5', {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000, cache_creation_tokens: 0, thinking_tokens: 0,
    })
    expect(opus55).toBeCloseTo(0.2, 10) // 4.0 * 0.05

    const sonnet55 = estimateCostUsd('claude-sonnet-5-5', {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000, cache_creation_tokens: 0, thinking_tokens: 0,
    })
    expect(sonnet55).toBeCloseTo(0.1, 10) // 2.0 * 0.05
  })

  it('CONTROL: siblings without the override still use the standard 0.1x cache-read multiplier', () => {
    const opus5 = estimateCostUsd('claude-opus-5', {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000, cache_creation_tokens: 0, thinking_tokens: 0,
    })
    expect(opus5).toBeCloseTo(0.5, 10) // 5.0 * 0.1, unaffected by the opus-5-5 override

    const sonnet5 = estimateCostUsd('claude-sonnet-5', {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000, cache_creation_tokens: 0, thinking_tokens: 0,
    })
    expect(sonnet5).toBeCloseTo(0.2, 10) // 2.0 * 0.1, unaffected by the sonnet-5-5 override
  })

  it('covers the newly recorded models as of 2026-10-12 DB sweep', () => {
    // From store/claudeclaw.db distinct model list 2026-10-12: all must price to non-null.
    const recorded = [
      'claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5',
      'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
      'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-5',
    ]
    for (const model of recorded) {
      const cost = estimateCostUsd(model, { input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0 })
      expect(cost, `${model} should resolve to a known rate`).not.toBeNull()
    }
  })
})
