// CostOps v0.1 -- read-mostly HTTP API. Bearer-gated like every /api/* route.
// GET never writes: reflecting the local config's fixed costs into the ledger
// (an idempotent upsert by dedup_key) happens on its own schedule via
// startCostsSyncTask() below (called once at server boot), not as a side effect
// of a client request. No LLM, no provider API, no secrets in the response.

import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'
import { loadCostopsConfig } from '../../costops/config.js'
import { syncFixedCostsToLedger, getCostSummary, getCostSources, getTokenCostByAgentDay } from '../../costops/ledger.js'
import {
  readWeeklySnapshot,
  writeWeeklySnapshot,
  WeeklyLimitError,
} from '../../costops/weekly-limit.js'
import {
  readThresholdConfig,
  writeThresholdConfig,
  WeeklyThresholdError,
} from '../../costops/weekly-threshold.js'
import { readHardStop } from '../../costops/weekly-hard-stop.js'
import {
  readModelFallbackConfig,
  writeModelFallbackConfig,
} from '../model-fallback-store.js'
import { parseModelFallbackUpdate, ModelFallbackConfigError } from '../../model-fallback.js'
import { readFleetTierState } from '../model-fallback-runner.js'
import { knownModelSuggestions } from '../agent-config.js'
import type { RouteContext } from './types.js'

// Runs the fixed-cost -> ledger reflection once immediately (so the summary is
// fresh from the moment the server comes up) and then on a fixed interval, so a
// manual edit to the local costops config eventually shows up without needing a
// restart. 10 minutes is deliberately coarse -- this is a manually-edited local
// config file, not something that needs near-real-time reflection, and this is
// the only place in the whole CostOps slice that writes to the DB at all.
const SYNC_INTERVAL_MS = 10 * 60 * 1000

export function startCostsSyncTask(intervalMs = SYNC_INTERVAL_MS): NodeJS.Timeout {
  const sync = () => {
    try {
      const { config } = loadCostopsConfig()
      syncFixedCostsToLedger(getDb(), config, Math.floor(Date.now() / 1000))
    } catch (err) {
      logger.warn({ err }, 'CostOps fixed-cost sync failed')
    }
  }
  sync()
  return setInterval(sync, intervalMs).unref()
}

export async function tryHandleCosts(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // Weekly-limit % snapshot (card 8388642a, part 3). MANUAL snapshot -- there is no reliable
  // programmatic weekly-% read (memory: weekly-usage-autoread-unavailable). GET returns the
  // recorded snapshot or a descriptive needs-input state (rule 12, never a fake number); POST
  // records the operator's reading.
  if (path === '/api/costs/weekly' && method === 'GET') {
    const snap = readWeeklySnapshot()
    if (!snap) {
      json(res, {
        available: false,
        message:
          'Nincs heti-limit pillanatkép rögzítve. Add meg a Claude usage-képernyőn látható heti százalékot (All models) a kvóta-gauge-nál.',
      })
    } else {
      json(res, { available: true, ...snap })
    }
    return true
  }

  if (path === '/api/costs/weekly' && method === 'POST') {
    try {
      let body: Record<string, unknown>
      try {
        body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
      } catch {
        json(res, { error: 'Érvénytelen JSON törzs.' }, 400)
        return true
      }
      const snap = writeWeeklySnapshot(body, Math.floor(Date.now() / 1000))
      json(res, { available: true, ...snap })
    } catch (err) {
      if (err instanceof WeeklyLimitError) {
        json(res, { error: err.message }, 400)
        return true
      }
      logger.error({ err }, 'CostOps weekly snapshot write failed')
      json(res, { error: 'A heti-limit pillanatkép mentése sikertelen.' }, 500)
    }
    return true
  }

  if (path === '/api/costs/summary' && method === 'GET') {
    try {
      const monthKey = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      const { config, exists, errors } = loadCostopsConfig()
      const summary = getCostSummary(getDb(), config, now, {
        monthKey, configExists: exists, configErrors: errors,
      })
      json(res, summary)
    } catch (err) {
      logger.error({ err }, 'CostOps summary failed')
      json(res, { error: 'Cost summary failed' }, 500)
    }
    return true
  }

  // Per-agent/per-day token-cost estimate (card d2cfa818). ?days=N controls the lookback window
  // (default 30); invalid/absent falls back inside getTokenCostByAgentDay.
  if (path === '/api/costs/token-cost' && method === 'GET') {
    try {
      const daysParam = url.searchParams.get('days')
      const days = daysParam ? parseInt(daysParam, 10) : undefined
      const now = Math.floor(Date.now() / 1000)
      json(res, getTokenCostByAgentDay(getDb(), now, { days }))
    } catch (err) {
      logger.error({ err }, 'CostOps token-cost breakdown failed')
      json(res, { error: 'Token cost breakdown failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/sources' && method === 'GET') {
    try {
      json(res, getCostSources(getDb()))
    } catch (err) {
      logger.error({ err }, 'CostOps sources failed')
      json(res, { error: 'Cost sources failed' }, 500)
    }
    return true
  }

  // Editable weekly new-dev-stop thresholds (card f3248478): the same file
  // store/pre-dispatch-check.sh reads, so the dashboard sliders and the bash gate
  // never drift out of sync.
  if (path === '/api/costs/weekly-thresholds' && method === 'GET') {
    // Card d08b98f4: the panel needs BOTH the configured levels and whether the harder one is
    // currently in force -- otherwise the sliders show a policy while the fleet is already parked by
    // it, with nothing on screen saying so.
    json(res, { ...readThresholdConfig(), hardStop: readHardStop() })
    return true
  }

  if (path === '/api/costs/weekly-thresholds' && method === 'POST') {
    try {
      let body: Record<string, unknown>
      try {
        body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
      } catch {
        json(res, { error: 'Érvénytelen JSON törzs.' }, 400)
        return true
      }
      const config = writeThresholdConfig(body, Math.floor(Date.now() / 1000))
      json(res, config)
    } catch (err) {
      if (err instanceof WeeklyThresholdError) {
        json(res, { error: err.message }, 400)
        return true
      }
      logger.error({ err }, 'Weekly threshold config write failed')
      json(res, { error: 'A kuszob-beallitasok mentese sikertelen.' }, 500)
    }
    return true
  }

  // Model-fallback config (card 5d2002b5): the banner-fallback toggle + the
  // editable model CHAIN + the weekly-% tier thresholds, all in one panel. Same
  // Bearer gate as every /api/* route (enforced centrally in web.ts). GET also
  // returns the known-model SUGGESTIONS for the chain editor's datalist -- the
  // editor still accepts free text, so a future model needs no code change.
  if (path === '/api/costs/model-fallback' && method === 'GET') {
    json(res, { ...readModelFallbackConfig(), knownModels: knownModelSuggestions() })
    return true
  }

  // Read-only per-agent tier state for the dashboard (card 5d2002b5 redesign): each agent's durable
  // base, current model, effective tier, and the ramp target from its OWN base. Same Bearer gate.
  if (path === '/api/costs/model-fallback/agents' && method === 'GET') {
    try {
      json(res, readFleetTierState())
    } catch (err) {
      logger.error({ err }, 'Model-fallback agent state read failed')
      json(res, { error: 'Az ügynök modell-állapot lekérése sikertelen.' }, 500)
    }
    return true
  }

  if (path === '/api/costs/model-fallback' && method === 'POST') {
    try {
      let body: Record<string, unknown>
      try {
        body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
      } catch {
        json(res, { error: 'Érvénytelen JSON törzs.' }, 400)
        return true
      }
      const update = parseModelFallbackUpdate(body)
      const config = writeModelFallbackConfig(update)
      json(res, { ...config, knownModels: knownModelSuggestions() })
    } catch (err) {
      if (err instanceof ModelFallbackConfigError) {
        json(res, { error: err.message }, 400)
        return true
      }
      logger.error({ err }, 'Model-fallback config write failed')
      json(res, { error: 'A modell-fallback beállítások mentése sikertelen.' }, 500)
    }
    return true
  }

  if (path === '/api/costs/budgets' && method === 'GET') {
    try {
      const { config } = loadCostopsConfig()
      json(res, config.budgets)
    } catch (err) {
      logger.error({ err }, 'CostOps budgets failed')
      json(res, { error: 'Cost budgets failed' }, 500)
    }
    return true
  }

  return false
}
