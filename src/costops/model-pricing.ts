// CostOps -- Anthropic provider pricing table (card d2cfa818, the follow-up the base README
// promised: "Provider collectors, provider-API imports, and token-cost pricing ... land in
// follow-up changes").
//
// Static, hand-maintained -- no live provider API call, matching every other guardrail in this
// slice (pure SQL + arithmetic, no network, no secrets). Source: the claude-api reference skill's
// model table (~/.claude/external/anthropics-skills/skills/claude-api/SKILL.md, cached 2026-06-24).
// Sonnet 5's $2/$10 rate is INTRO PRICING, valid through 2026-08-31 -- after that it reverts to
// $3/$15, and this table needs a manual update or every Sonnet-5 estimate from that date on
// silently over-counts by 33-50%. There is no automated refresh; that is a deliberate v1
// limitation (no live provider API, per this slice's own guardrail), not an oversight -- see the
// README for the follow-up this leaves open.
//
// Cache economics (same skill, shared/prompt-caching.md): a cache READ costs ~0.1x the base input
// price; a cache WRITE costs 1.25x (5-minute TTL) or 2x (1-hour TTL). Claude Code uses the
// 5-minute TTL, so 1.25x is used here -- an assumption stated so a future reader can correct it if
// that changes. Thinking tokens bill at the OUTPUT rate (same skill: "thinking happens and is
// billed the same under every [display] setting").

export interface ModelRate {
  inputPerMTok: number // USD per 1,000,000 input tokens
  outputPerMTok: number // USD per 1,000,000 output tokens
}

export const CACHE_READ_MULTIPLIER = 0.1
export const CACHE_WRITE_MULTIPLIER = 1.25 // 5-minute TTL, Claude Code's default

// Keyed by the BASE model id (date-suffix stripped, see stripDateSuffix) -- matches what this repo
// actually records in token_usage.model. Cached 2026-06-24; Sonnet 5 intro price expires 2026-08-31.
export const MODEL_PRICING: Readonly<Record<string, ModelRate>> = {
  'claude-fable-5': { inputPerMTok: 10.0, outputPerMTok: 50.0 },
  'claude-mythos-5': { inputPerMTok: 10.0, outputPerMTok: 50.0 },
  'claude-opus-5': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-opus-4-8': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-opus-4-7': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-opus-4-6': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-sonnet-5': { inputPerMTok: 2.0, outputPerMTok: 10.0 }, // intro price through 2026-08-31
  'claude-sonnet-4-6': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-haiku-4-5': { inputPerMTok: 1.0, outputPerMTok: 5.0 },
}

/** Strips a trailing `-YYYYMMDD` snapshot suffix, e.g. 'claude-haiku-4-5-20251001' -> 'claude-haiku-4-5'. */
export function stripDateSuffix(model: string): string {
  return model.replace(/-\d{8}$/, '')
}

export interface TokenCounts {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  thinking_tokens: number
}

/**
 * USD cost estimate for `counts` under `model`, or null when the model is missing/unrecognized.
 * Never fabricates a price for an unpriced model -- callers must track that gap separately
 * (see getTokenCostByAgentDay's unpriced_tokens) rather than silently treating it as zero cost.
 */
export function estimateCostUsd(model: string | null | undefined, counts: TokenCounts): number | null {
  if (!model) return null
  const rate = MODEL_PRICING[stripDateSuffix(model)]
  if (!rate) return null
  return (
    (counts.input_tokens * rate.inputPerMTok +
      (counts.output_tokens + counts.thinking_tokens) * rate.outputPerMTok +
      counts.cache_read_tokens * rate.inputPerMTok * CACHE_READ_MULTIPLIER +
      counts.cache_creation_tokens * rate.inputPerMTok * CACHE_WRITE_MULTIPLIER) /
    1_000_000
  )
}
