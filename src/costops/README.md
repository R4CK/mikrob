# CostOps -- local cost ledger (base)

A deterministic, read-mostly local cost ledger for the operator's own recurring
costs (subscriptions, hosting, domain, SaaS). Pure SQL + arithmetic: no LLM, no
provider API calls, no secrets. Real amounts and account references live in a
gitignored local config, never in the repo.

This is the base slice: manual/fixed cost sources, a monthly summary with
budget thresholds, and token-usage volume reporting, now paired with a static
Anthropic-model USD cost **estimate** (card d2cfa818, see "Token-cost estimate"
below). Provider collectors and provider-API imports (actual billing data, not
a price-table estimate) are still intentionally out of scope and land in
further follow-up changes.

## Data model

- `cost_sources` -- provider/subscription origin (id, name, provider, type,
  currency, active). No raw account IDs.
- `cost_line_items` -- individual charge rows for a charge period (billed_cost,
  confidence, dedup_key for idempotent upserts). FOCUS-inspired.
- `budgets` -- display-only warning/hard thresholds. No action is ever taken;
  status is informational.

## Config (local, gitignored)

The operator's fixed/manual monthly costs and budgets live in
`store/costops-config.json` (under the gitignored `store/` tree, so real amounts
and account references never enter git). A safe `*.example` is generated on first
load if no config exists. With no config present the summary is simply empty --
it never fabricates numbers and never blocks the rest of the app.

```json
{
  "currency": "HUF",
  "fixed_costs": [
    { "source_id": "example-subscription", "name": "Example subscription", "provider": "other", "source_type": "subscription", "amount": 0, "confidence": "manual" }
  ],
  "budgets": [
    { "id": "global-monthly", "name": "Monthly budget", "amount": 0, "warning_threshold": 0.8, "hard_threshold": 1.0 }
  ]
}
```

## API (Bearer-gated, read-only)

- `GET /api/costs/summary` -- monthly spend, forecast, per-source and confidence
  breakdown, budget status, and token-usage volume plus a USD cost estimate
  (`token_usage.estimated_cost_usd`). On read it idempotently reflects the
  config's fixed costs into the ledger (upsert by dedup_key).
- `GET /api/costs/token-cost?days=N` -- the same USD estimate broken down per
  agent per day (default 30-day lookback).
- `GET /api/costs/sources` -- active cost sources.
- `GET /api/costs/budgets` -- configured budgets.

No client writes, no LLM, no provider API, no secrets in any response.

## Token-cost estimate (`model-pricing.ts`, card d2cfa818)

`token_usage.estimated_cost_usd` (in the summary) and `GET /api/costs/token-cost`
(per agent/day) multiply the existing token-usage **volume** rows by a static
Anthropic list-price table (input/output $ per 1M tokens, cache-read at ~0.1x
and cache-write at 1.25x the input rate assuming Claude Code's 5-minute TTL).
Source: the `claude-api` reference skill, cached 2026-06-24.

This is an **estimate**, not a bill, and deliberately stays out of the money
ledger above:
- It is USD; `current_spend`/`budget` are in the operator's own `config.currency`
  (typically HUF) and mixing the two without a live FX rate would misstate both.
- The price table is static (no live provider API, per this slice's own
  guardrail) and needs a manual update when Anthropic's prices change --
  notably Sonnet 5's intro price expires 2026-08-31.
- `token_usage` rows written before the `model` column existed (or tagged
  `<synthetic>`) have no known rate; those are excluded from
  `estimated_cost_usd` and reported separately as `unpriced_calls`/
  `unpriced_tokens` rather than silently priced at zero.

## Guardrails

- Deterministic: every function takes `db` and `now`, unit-tested against an
  in-memory database.
- Manual/fallback is the only cost source in this slice; the provider-derived
  path is empty and handled gracefully.
- Token usage is reported as volume plus a clearly-labelled, separately-tracked
  USD estimate (see above); no token cost is ever folded into the money
  ledger's `current_spend`/`forecast_month_end`/`budget`.
- Additive schema (`CREATE TABLE IF NOT EXISTS`); with no CostOps config the rest
  of the app behaves exactly as before.

## Weekly-limit auto-aggressiveness ramp (`weekly-threshold.ts`, card 346d3933)

Separate from the money ledger: this drives how hard the fleet leans on the free
local GPU as the **weekly Claude usage** approaches the `newDevStop` threshold.

- **Ramp curve** (`rampAggressiveness`): monotone non-decreasing in weekly %,
  linear from `RAMP_FLOOR_AGGRESSIVENESS` (75, the standing "optimal" baseline)
  at weekly 0 up to **100 at `newDevStop`**, pinned at 100 above it. A broken
  threshold fails **safe to 100**.
- **Manual override wins** (`applyAggressivenessRamp`): the offload directive
  (`store/local-llm-offload-active.json`) carries
  `aggressiveness_source: 'manual' | 'auto'`. A `manual` value -- what the
  dashboard slider sets -- is **never** overwritten by the ramp; only `auto`
  follows the curve. A legacy file that already has a value (no `source`) is
  treated as `manual` so turning the ramp on can never clobber an operator value.
- **Wiring**: `weekly-usage-panel-read.sh` (every 30 min) writes the live weekly %
  to `store/weekly-usage.json`, then runs the compiled applier
  `dist/costops/apply-offload-ramp.js`, which reads that %, the threshold, and the
  directive, and writes the ramped aggressiveness **only** under automatic control.
- **FE contract**: `GET /api/local-llm/offload-config` returns
  `aggressivenessSource` and a `ramp` block (`weeklyPct`, `newDevStop`, `floor`,
  `autoAggressiveness`, `autoDifficulty`) so the dashboard can show the auto value
  and offer a "back to Auto" reset (`POST { aggressiveness: "auto" }`).
- **Safety**: draft-only is unchanged -- a higher aggressiveness only widens which
  well-bounded coding sub-steps draft locally (capped at the reliable `module`
  ceiling); it never sends more of the task, and every draft is still gate-checked.
