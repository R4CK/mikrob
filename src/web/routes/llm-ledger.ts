import {
  getLlmLedgerSummary, getAgentLlmBudget, setAgentLlmBudget,
} from '../../db.js'
import { getSettingDefinition } from '../../config-registry.js'
import { json, readBody, RequestBodyTooLargeError } from '../http-helpers.js'
import { isKnownAgent } from '../agent-config.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

// card 1a3c6459 (F2 on e96d56c5): a budget PUT body is one small integer field, never a bulk
// payload -- the route only ever needs a few dozen bytes, not the 20MB default.
const BUDGET_BODY_MAX_BYTES = 4 * 1024
// card 1a3c6459 (F2): the roster check below already refuses an unknown agent id, but it stats
// agents/<name> to do it -- cap the length BEFORE that stat, so a pathological id (WhiteHat2
// measured 20,000 chars) never reaches the filesystem call.
const MAX_AGENT_ID_CHARS = 64

// Card e96d56c5 (F4): per-call LLM ledger summary + per-agent budget.
export async function tryHandleLlmLedger(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/llm-ledger/summary' && method === 'GET') {
    const daysRaw = url.searchParams.get('days')
    const days = daysRaw ? parseInt(daysRaw, 10) : 7
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      json(res, { error: 'days must be an integer between 1 and 365' }, 400)
      return true
    }
    json(res, getLlmLedgerSummary(days))
    return true
  }

  const budgetMatch = path.match(/^\/api\/llm-ledger\/budget\/([a-z0-9-]+)$/)
  if (budgetMatch && method === 'GET') {
    // card 1a3c6459 (F2 on e96d56c5): WhiteHat2 measured 3000 distinct ghost agent ids accepted
    // (no roster check at all). GET is read-only and stays open to any authenticated caller
    // (WhiteHat2's own direction restricts the WRITE below, not this read), but an unknown id is
    // still a 404, not a budget row for an agent that does not exist.
    if (budgetMatch[1].length > MAX_AGENT_ID_CHARS || !isKnownAgent(budgetMatch[1])) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }
    json(res, getAgentLlmBudget(budgetMatch[1]))
    return true
  }

  if (budgetMatch && method === 'PUT') {
    if (budgetMatch[1].length > MAX_AGENT_ID_CHARS || !isKnownAgent(budgetMatch[1])) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }

    // F1 (WhiteHat2, card e96d56c5 gate): "let PUT through only for human session or device
    // principals (agents may GET)" -- a shared fleet token (auth.kind 'token') or a federation
    // peer must not be able to lower (or forge-raise) another agent's budget. ctx.auth.agent
    // (X-Agent-Id on a 'token' caller) is explicitly "attribute, never authorize" per
    // RouteContext's own doc comment -- it was never a credential this write could lean on.
    const auth = ctx.auth
    if (auth?.kind !== 'session' && auth?.kind !== 'device') {
      logger.warn({ authKind: auth?.kind ?? 'none', agentId: budgetMatch[1] },
        'LLM ledger budget PUT refused: requires a session or device principal (card 1a3c6459 F1)')
      json(res, { error: 'Setting an LLM budget requires a dashboard session or device credential, not a shared fleet token' }, 403)
      return true
    }

    let body: Buffer
    try {
      body = await readBody(ctx.req, { maxBytes: BUDGET_BODY_MAX_BYTES })
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: `Request body too large (max ${err.limit} bytes)` }, 413)
        return true
      }
      throw err
    }
    let parsed: unknown
    try { parsed = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const dailyBudget = (parsed as { daily_budget?: unknown })?.daily_budget

    // F1: the old check (typeof number + Number.isInteger + >= 0) let 1e300, 1e15 and
    // 9007199254740993 (silently rounded) through -- Number.isInteger is true for any whole-
    // valued double, however large. Number.isFinite rejects NaN/Infinity (Number.isInteger
    // already did, kept here for the explicit intent), and the upper bound now comes from the
    // SAME platform setting (LLM_LEDGER_DEFAULT_DAILY_BUDGET, rule 14 two-tier settings) the
    // default itself reads -- never a second, drifting hardcoded ceiling.
    const def = getSettingDefinition('LLM_LEDGER_DEFAULT_DAILY_BUDGET')
    const max = def?.max ?? 10_000_000
    const min = def?.min ?? 0
    if (
      typeof dailyBudget !== 'number' || !Number.isFinite(dailyBudget) || !Number.isInteger(dailyBudget)
      || dailyBudget < min || dailyBudget > max
    ) {
      json(res, { error: `daily_budget must be an integer between ${min} and ${max}` }, 400)
      return true
    }

    // F1: updated_by is now the AUTHENTICATED principal, never the body's "actor" field (WhiteHat2
    // measured a forged "peti (forged)" stored verbatim). The body no longer has a say in who gets
    // credited/blamed for the change.
    const updatedBy = auth.kind === 'session' ? (auth.user ?? null) : (auth.device ?? null)
    setAgentLlmBudget(budgetMatch[1], dailyBudget, updatedBy)
    logger.info({ agentId: budgetMatch[1], dailyBudget, updatedBy }, 'Per-agent LLM daily budget updated')
    json(res, { ok: true, agent_id: budgetMatch[1], daily_budget: dailyBudget })
    return true
  }

  return false
}
