// CostOps v0.1 -- deterministic cost ledger core.
//
// Pure SQL + arithmetic. NO LLM, no network, no secrets. `db` and `now` are
// passed in so every function is deterministic and unit-testable against an
// in-memory database. FOCUS-inspired: cost_sources (ProviderName/BillingAccount),
// cost_line_items (ChargeRow: ChargePeriod, ChargeCategory, BilledCost,
// ConsumedQuantity/Unit, confidence), budgets (display-only).

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { CostOpsConfig, CostConfidence } from './config.js'
import { estimateCostUsd } from './model-pricing.js'

// ---- month math (UTC, deterministic given `now`) ---------------------------

export interface MonthWindow {
  key: string          // 'YYYY-MM'
  start: number        // epoch sec, inclusive
  end: number          // epoch sec, exclusive (start of next month)
  daysInMonth: number
  fractionElapsed: number  // (0,1], how much of the month has passed at `now`
}

export function monthWindow(now: number, monthKey?: string): MonthWindow {
  let year: number, month: number  // month 0-based
  if (monthKey && /^\d{4}-\d{2}$/.test(monthKey)) {
    year = parseInt(monthKey.slice(0, 4))
    month = parseInt(monthKey.slice(5, 7)) - 1
  } else {
    const d = new Date(now * 1000)
    year = d.getUTCFullYear()
    month = d.getUTCMonth()
  }
  const start = Math.floor(Date.UTC(year, month, 1) / 1000)
  const end = Math.floor(Date.UTC(year, month + 1, 1) / 1000)
  const daysInMonth = Math.round((end - start) / 86400)
  const elapsed = Math.min(Math.max(now - start, 1), end - start)
  const fractionElapsed = elapsed / (end - start)
  const key = `${year}-${String(month + 1).padStart(2, '0')}`
  return { key, start, end, daysInMonth, fractionElapsed }
}

// ---- hashing (no raw account IDs / invoice refs ever stored) ----------------

/** Deterministic, non-reversible ref for account/resource/invoice identifiers. */
export function hashRef(salt: string, raw: string): string {
  return createHash('sha256').update(salt).update('|').update(raw).digest('hex').slice(0, 32)
}

// ---- confidence -> breakdown bucket ----------------------------------------

export type CostBucket = 'fixed_manual' | 'provider' | 'estimate'

export function confidenceBucket(c: CostConfidence): CostBucket {
  switch (c) {
    case 'actual_invoice':
    case 'provider_api':
    case 'billing_export':
      return 'provider'
    case 'estimate':
    case 'local_usage':
      return 'estimate'
    case 'manual':
    default:
      return 'fixed_manual'
  }
}

// ---- write path: reflect config fixed costs into the ledger (idempotent) -----

/**
 * Upsert the config's fixed/manual monthly costs as cost_line_items for the
 * target month, and upsert their cost_sources. Idempotent via a stable
 * dedup_key (`fixed|<source_id>|<YYYY-MM>`) so re-running never duplicates.
 * Returns the number of line items written/updated.
 */
export function syncFixedCostsToLedger(
  db: Database.Database,
  config: CostOpsConfig,
  now: number,
  monthKey?: string,
): number {
  const win = monthWindow(now, monthKey)
  const upsertSource = db.prepare(`
    INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at)
    VALUES (@id, @name, @provider, @source_type, @currency, 1, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, provider=excluded.provider, source_type=excluded.source_type,
      currency=excluded.currency, active=1, updated_at=excluded.updated_at
  `)
  const upsertLine = db.prepare(`
    INSERT INTO cost_line_items
      (source_id, charge_period_start, charge_period_end, charge_category, service_name,
       usage_type, consumed_quantity, consumed_unit, billed_cost, effective_cost, currency,
       confidence, data_freshness, source_ref, dedup_key, created_at)
    VALUES
      (@source_id, @start, @end, @charge_category, @service_name,
       NULL, 1, 'month', @billed_cost, NULL, @currency,
       @confidence, @now, NULL, @dedup_key, @now)
    ON CONFLICT(dedup_key) DO UPDATE SET
      billed_cost=excluded.billed_cost, charge_category=excluded.charge_category,
      service_name=excluded.service_name, currency=excluded.currency,
      confidence=excluded.confidence, data_freshness=excluded.data_freshness
  `)
  const tx = db.transaction((entries: CostOpsConfig['fixed_costs']) => {
    let count = 0
    for (const e of entries) {
      upsertSource.run({
        id: e.source_id, name: e.name, provider: e.provider,
        source_type: e.source_type, currency: e.currency ?? config.currency, now,
      })
      upsertLine.run({
        source_id: e.source_id, start: win.start, end: win.end,
        charge_category: e.charge_category ?? 'subscription', service_name: e.name,
        billed_cost: e.amount, currency: e.currency ?? config.currency,
        confidence: e.confidence ?? 'manual', now,
        dedup_key: `fixed|${e.source_id}|${win.key}`,
      })
      count++
    }
    return count
  })
  return tx(config.fixed_costs)
}

// ---- read path: deterministic monthly summary ------------------------------

export interface CostSummary {
  month: string
  currency: string
  current_spend: number
  forecast_month_end: number
  top_sources: Array<{ source_id: string; name: string; spend: number }>
  // Full list of every configured/active source (not capped) -- top_sources is
  // the top-5 by spend; all_sources is the complete set for the dashboard table.
  all_sources: Array<{ source_id: string; name: string; provider: string; source_type: string; spend: number; confidence: string }>
  confidence_breakdown: Record<string, number>
  breakdown: { fixed_manual: number; provider: number; estimate: number }
  budget: {
    id: string
    amount: number
    used_pct: number
    forecast_pct: number
    status: 'ok' | 'warning' | 'hard'
    warning_threshold: number
    hard_threshold: number
  } | null
  token_usage: {
    note: string
    calls: number
    agents: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
    // USD estimate (card d2cfa818), kept separate from current_spend/budget above (see note).
    estimated_cost_usd: number
    unpriced_calls: number
    unpriced_tokens: number
  }
  data_freshness: number | null
  config_present: boolean
  config_errors: string[]
  generated_at: number
}

interface LineRow {
  source_id: string
  billed_cost: number
  charge_category: string
  confidence: CostConfidence
  data_freshness: number
}

export function getCostSummary(
  db: Database.Database,
  config: CostOpsConfig,
  now: number,
  opts: { monthKey?: string; configExists?: boolean; configErrors?: string[] } = {},
): CostSummary {
  const win = monthWindow(now, opts.monthKey)

  const lines = db.prepare(`
    SELECT source_id, billed_cost, charge_category, confidence, data_freshness
    FROM cost_line_items
    WHERE charge_period_start < @end AND charge_period_end > @start
  `).all({ start: win.start, end: win.end }) as LineRow[]

  let current_spend = 0
  let forecast_month_end = 0
  const confidence_breakdown: Record<string, number> = {}
  const breakdown = { fixed_manual: 0, provider: 0, estimate: 0 }
  const perSource = new Map<string, number>()
  const perSourceConfidence = new Map<string, string>()
  let latestFreshness: number | null = null

  for (const l of lines) {
    current_spend += l.billed_cost
    // Usage-type lines are prorated to month-end; committed/fixed lines are
    // already whole-month (no proration).
    forecast_month_end += l.charge_category === 'usage'
      ? l.billed_cost / win.fractionElapsed
      : l.billed_cost
    confidence_breakdown[l.confidence] = (confidence_breakdown[l.confidence] || 0) + l.billed_cost
    breakdown[confidenceBucket(l.confidence)] += l.billed_cost
    perSource.set(l.source_id, (perSource.get(l.source_id) || 0) + l.billed_cost)
    perSourceConfidence.set(l.source_id, l.confidence)
    if (latestFreshness === null || l.data_freshness > latestFreshness) latestFreshness = l.data_freshness
  }
  current_spend = round2(current_spend)
  forecast_month_end = round2(forecast_month_end)

  // resolve source metadata (name/provider/source_type) for every active source
  const srcRows = db.prepare(`SELECT id, name, provider, source_type FROM cost_sources WHERE active = 1`).all() as Array<{ id: string; name: string; provider: string; source_type: string }>
  const nameMap = new Map(srcRows.map(r => [r.id, r.name]))
  const top_sources = [...perSource.entries()]
    .map(([source_id, spend]) => ({ source_id, name: nameMap.get(source_id) || source_id, spend: round2(spend) }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 5)

  // Full list: every configured/active source with spend (0 if none this month).
  const all_sources = srcRows
    .map(r => ({
      source_id: r.id, name: r.name, provider: r.provider, source_type: r.source_type,
      spend: round2(perSource.get(r.id) || 0), confidence: perSourceConfidence.get(r.id) || 'manual',
    }))
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name))

  // budget (first budget, or the 'global-monthly' one if present)
  const budgetDef = config.budgets.find(b => b.id === 'global-monthly') || config.budgets[0] || null
  let budget: CostSummary['budget'] = null
  if (budgetDef && budgetDef.amount > 0) {
    const warning = budgetDef.warning_threshold ?? 0.8
    const hard = budgetDef.hard_threshold ?? 1.0
    const used_pct = current_spend / budgetDef.amount
    const forecast_pct = forecast_month_end / budgetDef.amount
    // Status is display-only. No action is ever taken here.
    const status: 'ok' | 'warning' | 'hard' =
      used_pct >= hard ? 'hard' : used_pct >= warning ? 'warning' : 'ok'
    budget = {
      id: budgetDef.id, amount: budgetDef.amount,
      used_pct: round4(used_pct), forecast_pct: round4(forecast_pct),
      status, warning_threshold: warning, hard_threshold: hard,
    }
  }

  // token_usage: VOLUME/ACTIVITY totals, unchanged shape from v0.1.
  const tu = db.prepare(`
    SELECT COUNT(*) as calls, COUNT(DISTINCT agent) as agents,
      COALESCE(SUM(input_tokens),0) as input_tokens,
      COALESCE(SUM(output_tokens),0) as output_tokens,
      COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens),0) as cache_creation_tokens
    FROM token_usage WHERE timestamp >= @start AND timestamp < @end
  `).get({ start: win.start, end: win.end }) as {
    calls: number; agents: number; input_tokens: number; output_tokens: number
    cache_read_tokens: number; cache_creation_tokens: number
  }

  // Cost estimate (card d2cfa818): priced PER MODEL, not on the blended totals above --
  // different models have different rates, so summing tokens across models before pricing would
  // be wrong. A separate grouped query rather than reworking `tu` keeps the existing volume
  // aggregation (and the tests pinned to it) untouched.
  const tuByModel = db.prepare(`
    SELECT model, COUNT(*) as calls,
      COALESCE(SUM(input_tokens),0) as input_tokens,
      COALESCE(SUM(output_tokens),0) as output_tokens,
      COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens),0) as cache_creation_tokens,
      COALESCE(SUM(thinking_tokens),0) as thinking_tokens
    FROM token_usage WHERE timestamp >= @start AND timestamp < @end
    GROUP BY model
  `).all({ start: win.start, end: win.end }) as Array<{
    model: string | null; calls: number; input_tokens: number; output_tokens: number
    cache_read_tokens: number; cache_creation_tokens: number; thinking_tokens: number
  }>

  let estimatedCostUsd = 0
  let unpricedCalls = 0
  let unpricedTokens = 0
  for (const r of tuByModel) {
    const cost = estimateCostUsd(r.model, r)
    if (cost === null) {
      unpricedCalls += r.calls
      unpricedTokens += r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens + r.thinking_tokens
    } else {
      estimatedCostUsd += cost
    }
  }

  return {
    month: win.key,
    currency: config.currency,
    current_spend,
    forecast_month_end,
    top_sources,
    all_sources,
    confidence_breakdown: roundValues(confidence_breakdown),
    breakdown: { fixed_manual: round2(breakdown.fixed_manual), provider: round2(breakdown.provider), estimate: round2(breakdown.estimate) },
    budget,
    token_usage: {
      note: 'estimated_cost_usd is a static Anthropic list-price USD estimate (see model-pricing.ts) -- kept separate from current_spend/budget above, which stay in the operator\'s own currency and never include it. Rows whose model is missing/unrecognized are excluded from the estimate and counted in unpriced_calls/unpriced_tokens instead of being silently priced at zero.',
      calls: tu.calls, agents: tu.agents,
      input_tokens: tu.input_tokens, output_tokens: tu.output_tokens,
      cache_read_tokens: tu.cache_read_tokens, cache_creation_tokens: tu.cache_creation_tokens,
      estimated_cost_usd: round4(estimatedCostUsd), unpriced_calls: unpricedCalls, unpriced_tokens: unpricedTokens,
    },
    data_freshness: latestFreshness,
    config_present: opts.configExists ?? true,
    config_errors: opts.configErrors ?? [],
    generated_at: now,
  }
}

export function getCostSources(db: Database.Database): unknown[] {
  return db.prepare(`SELECT id, name, provider, source_type, currency, active, updated_at FROM cost_sources WHERE active = 1 ORDER BY name`).all()
}

export interface AgentDayCost {
  agent: string
  day: string // 'YYYY-MM-DD', UTC (SQLite date(timestamp,'unixepoch'))
  estimated_cost_usd: number
  priced_calls: number
  unpriced_calls: number
  unpriced_tokens: number
}

export interface TokenCostByAgentDay {
  rows: AgentDayCost[]
  since_days: number
  pricing_note: string
  generated_at: number
}

/**
 * Cost-estimate breakdown per agent/per day (card d2cfa818's explicit ask). Same pricing
 * mechanism as getCostSummary's token_usage.estimated_cost_usd, grouped finer -- priced PER
 * (agent, day, model) row so mixed-model days are not blended before pricing.
 */
export function getTokenCostByAgentDay(
  db: Database.Database,
  now: number,
  opts: { days?: number } = {},
): TokenCostByAgentDay {
  const days = opts.days && opts.days > 0 ? Math.floor(opts.days) : 30
  const since = now - days * 86400

  const raw = db.prepare(`
    SELECT agent, date(timestamp, 'unixepoch') as day, model, COUNT(*) as calls,
      COALESCE(SUM(input_tokens),0) as input_tokens,
      COALESCE(SUM(output_tokens),0) as output_tokens,
      COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens),0) as cache_creation_tokens,
      COALESCE(SUM(thinking_tokens),0) as thinking_tokens
    FROM token_usage WHERE timestamp >= @since
    GROUP BY agent, day, model
  `).all({ since }) as Array<{
    agent: string; day: string; model: string | null; calls: number
    input_tokens: number; output_tokens: number; cache_read_tokens: number
    cache_creation_tokens: number; thinking_tokens: number
  }>

  const byAgentDay = new Map<string, AgentDayCost>()
  for (const r of raw) {
    const key = `${r.agent}|${r.day}`
    let acc = byAgentDay.get(key)
    if (!acc) {
      acc = { agent: r.agent, day: r.day, estimated_cost_usd: 0, priced_calls: 0, unpriced_calls: 0, unpriced_tokens: 0 }
      byAgentDay.set(key, acc)
    }
    const cost = estimateCostUsd(r.model, r)
    if (cost === null) {
      acc.unpriced_calls += r.calls
      acc.unpriced_tokens += r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens + r.thinking_tokens
    } else {
      acc.estimated_cost_usd += cost
      acc.priced_calls += r.calls
    }
  }

  const rows = [...byAgentDay.values()]
    .map(r => ({ ...r, estimated_cost_usd: round4(r.estimated_cost_usd) }))
    .sort((a, b) => (a.day !== b.day ? b.day.localeCompare(a.day) : b.estimated_cost_usd - a.estimated_cost_usd))

  return {
    rows,
    since_days: days,
    pricing_note: 'USD estimate from a static Anthropic list-price table (model-pricing.ts), not the live provider API; cache writes assumed at the 5-minute-TTL rate. Rows with a missing/unrecognized model are excluded here and counted in unpriced_calls/unpriced_tokens.',
    generated_at: now,
  }
}

function round2(n: number): number { return Math.round(n * 100) / 100 }
function round4(n: number): number { return Math.round(n * 10000) / 10000 }
function roundValues(obj: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = round2(v)
  return out
}
