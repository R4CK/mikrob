// GET /api/llm/chain (card 954a6a93): per-stage counts for the local -> freellm -> online LLM
// chain, routing reasons, Draft-Review verdict rates, and a cost estimate -- feeding the
// reorganized Local-LLM/FreeLLM dashboard pages (Pair-FE f1e33cfb).
//
// Contract ACCEPTed between Fron Ted (comment 37917) and backend2 (comment 37945) on card
// 954a6a93 before this file existed -- the response shape below is taken verbatim from that
// exchange, not re-derived. Every section carries its own "source" (section granularity, not
// per-field: comment 37945 point 2), because every field inside one section genuinely comes
// from the same table/file.
import { getDb, getLlmChainStageSummary, getLlmChainDraftReviewCounts } from '../../db.js'
import { getWindowCostEstimateUsd } from '../../costops/ledger.js'
import { readRecentDecisions, CARD_BUILD_ROUTE_LOG_FILE } from './local-llm.js'
import { readFreellmEnabled, FREELLM_TEST_CALLER_IDS } from './freellm-status.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const WINDOW_SECONDS: Record<string, number> = { '24h': 24 * 3600, '7d': 7 * 24 * 3600 }

// card-build-route.log has never held more than a few thousand lines (measured 2026-11-23:
// 1328 total, ever) -- large enough to cover any 7d window without truncation, small enough
// that reading+filtering it is cheap.
const ROUTE_LOG_READ_LIMIT = 100_000

export async function tryHandleLlmChain(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (path !== '/api/llm/chain' || method !== 'GET') return false

  const windowRaw = url.searchParams.get('window') ?? '24h'
  const windowSeconds = WINDOW_SECONDS[windowRaw]
  if (windowSeconds === undefined) {
    json(res, { error: 'window must be "24h" or "7d"' }, 400)
    return true
  }

  const includeTestRaw = url.searchParams.get('includeTest')
  if (includeTestRaw !== null && includeTestRaw !== 'true' && includeTestRaw !== 'false') {
    json(res, { error: 'includeTest must be "true" or "false"' }, 400)
    return true
  }
  const testTrafficIncluded = includeTestRaw === 'true'
  const excludeAgents = testTrafficIncluded ? [] : FREELLM_TEST_CALLER_IDS

  const nowS = Math.floor(Date.now() / 1000)
  const sinceS = nowS - windowSeconds
  const sinceMs = sinceS * 1000

  const stageRows = getLlmChainStageSummary(sinceS, excludeAgents)
  // 'online' is never appended to llm_ledger (only offloaded calls are) -- an honest zero, not a
  // fabricated figure, per the FE contract's 3-stage shape (comment 37917 point 1).
  const stages = [
    ...stageRows.map((r) => ({
      stage: r.provider, calls: r.calls, ok: r.ok, failReasons: r.failReasons,
      avgLatencyMs: r.avgLatencyMs, source: 'llm_ledger',
    })),
    { stage: 'online' as const, calls: 0, ok: 0, failReasons: [] as Array<{ reason: string; count: number }>, avgLatencyMs: null, source: 'llm_ledger' },
  ]

  const decisions = readRecentDecisions(CARD_BUILD_ROUTE_LOG_FILE, ROUTE_LOG_READ_LIMIT)
  const inWindow = decisions.rows.filter((d) => d.ts >= sinceMs)
  const reasonCounts = new Map<string, number>()
  let routingLocal = 0
  let routingOnline = 0
  for (const d of inWindow) {
    if (d.verdict === 'LOCAL') routingLocal++
    else routingOnline++
    reasonCounts.set(d.reason, (reasonCounts.get(d.reason) ?? 0) + 1)
  }
  const routing = {
    local: routingLocal,
    online: routingOnline,
    reasons: [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })),
    source: 'card_build_route_log',
  }

  const draftCounts = getLlmChainDraftReviewCounts(sinceS, excludeAgents)
  const draftReviewAvailable = draftCounts.accepted + draftCounts.rejected > 0
  const draftReview = {
    available: draftReviewAvailable,
    // RESZBEN/FELESLEGES stay structurally 0: llm_ledger.draft_accepted is a boolean column, it
    // can only ever express accepted/not-accepted (comment 37945 point 3, db.ts's own doc comment
    // on getLlmChainDraftReviewCounts).
    verdicts: draftReviewAvailable
      ? { ELFOGADVA: draftCounts.accepted, RESZBEN: 0, ELUTASITVA: draftCounts.rejected, FELESLEGES: 0 }
      : null,
    source: 'llm_ledger',
  }

  const switches = {
    freellmEnabled: readFreellmEnabled(),
    // Card 6d8ef952 (freellm-first route) is on develop and unconditional -- offload-dispatch.sh's
    // try_freellm_first_for_leaf runs whenever FREELLM_CALL is executable and freellm is not
    // blocked/cooling down, with no separate runtime on/off switch of its own. Static true, not a
    // speculative toggle for a control that does not exist.
    freellmFirstLive: true,
    source: 'config',
  }

  const cost = {
    usd: getWindowCostEstimateUsd(getDb(), sinceS),
    isEstimate: true as const,
    source: 'token_usage',
  }

  json(res, {
    window: windowRaw,
    generatedAt: new Date(nowS * 1000).toISOString(),
    testTrafficIncluded,
    stages,
    routing,
    draftReview,
    switches,
    cost,
  })
  return true
}
