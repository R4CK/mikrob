import {
  getLlmLedgerSummary, getAgentLlmBudget, setAgentLlmBudget,
} from '../../db.js'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

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
    json(res, getAgentLlmBudget(budgetMatch[1]))
    return true
  }

  if (budgetMatch && method === 'PUT') {
    let body = ''
    for await (const chunk of ctx.req) body += chunk
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const dailyBudget = (parsed as { daily_budget?: unknown })?.daily_budget
    if (typeof dailyBudget !== 'number' || !Number.isInteger(dailyBudget) || dailyBudget < 0) {
      json(res, { error: 'daily_budget must be a non-negative integer' }, 400)
      return true
    }
    const actor = (parsed as { actor?: unknown })?.actor
    setAgentLlmBudget(budgetMatch[1], dailyBudget, typeof actor === 'string' ? actor : null)
    logger.info({ agentId: budgetMatch[1], dailyBudget }, 'Per-agent LLM daily budget updated')
    json(res, { ok: true, agent_id: budgetMatch[1], daily_budget: dailyBudget })
    return true
  }

  return false
}
