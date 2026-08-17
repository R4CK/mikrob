// CostOps -- Anthropic provider pricing table (card d2cfa818, the follow-up the base README
// promised: "Provider collectors, provider-API imports, and token-cost pricing ... land in
// follow-up changes").
//
// Static, hand-maintained -- no live provider API call, matching every other guardrail in this
// slice (pure SQL + arithmetic, no network, no secrets). Source: the official pricing page
// (https://platform.claude.com/docs/en/about-claude/pricing), reconciled 2026-08-17 (weekly
// scheduled-task check, card 270e3ef4).
// Sonnet 5 launched on $2/$10 INTRO pricing, originally due to revert to $3/$15 on 2026-09-01;
// Anthropic has since cancelled that reversion, so $2/$10 is now the standing rate, not a
// temporary one -- do not reintroduce a date-based flip back to $3/$15. There is no automated
// refresh; a weekly scheduled-task reminder re-checks this table against the official page (card
// 270e3ef4) since that is a deliberate v1 limitation (no live provider API), not an oversight.
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
// actually records in token_usage.model. Reconciled against the official pricing page 2026-08-17.
//
// Card 7405ca61's sibling weekly check (2026-08-17): the official page also lists Opus 4.5 and
// several retired-but-still-billable models (Opus 4.1/4, Sonnet 4.5/4, Haiku 3.5, on Bedrock/Google
// Cloud). None had appeared in token_usage yet, so this table was not YET wrong for anything
// actually recorded -- but web/app-token-usage.js's prefix-matching table WAS already silently
// mispricing Opus 4.5 (falling through to the Opus 4/4.1 rate, 15/75 instead of 5/25) had it ever
// appeared. Added here too so a future estimateCostUsd() call resolves instead of returning null
// (unpriced) the moment one of these shows up in real usage.
export const MODEL_PRICING: Readonly<Record<string, ModelRate>> = {
  'claude-fable-5': { inputPerMTok: 10.0, outputPerMTok: 50.0 },
  'claude-mythos-5': { inputPerMTok: 10.0, outputPerMTok: 50.0 },
  'claude-opus-5': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-opus-4-8': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-opus-4-7': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-opus-4-6': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-opus-4-5': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-opus-4-1': { inputPerMTok: 15.0, outputPerMTok: 75.0 }, // retired, still billable on Bedrock/Google Cloud
  'claude-opus-4': { inputPerMTok: 15.0, outputPerMTok: 75.0 }, // retired, still billable on Google Cloud
  'claude-sonnet-5': { inputPerMTok: 2.0, outputPerMTok: 10.0 }, // standing rate, not a temporary intro price
  'claude-sonnet-4-6': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-sonnet-4-5': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-sonnet-4': { inputPerMTok: 3.0, outputPerMTok: 15.0 }, // retired, still billable on Bedrock/Google Cloud
  'claude-haiku-4-5': { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  'claude-haiku-3-5': { inputPerMTok: 0.80, outputPerMTok: 4.0 }, // retired, still billable on Bedrock/Google Cloud
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
