import { appendDailyLog, getDailyLog, getDailyLogDates } from '../../db.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { detectHomoglyphs, formatHomoglyphWarning } from '../../homoglyph.js'
import { agentKeyToAgentId } from '../auth-device-keys.js'
import type { RouteContext } from './types.js'

export async function tryHandleDailyLog(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url, auth } = ctx
  // WhiteHat2 X1 (card debba303, same precedent as O1/overview.ts and card 517fdcc5/memories.ts):
  // a device agent-key caller's authenticated identity, when present, overrides whatever `?agent=`
  // claims -- a shared-token/session caller (no device identity) is unaffected and keeps reading
  // any `agent` it names, exactly as before.
  const authenticatedAgentId = auth?.kind === 'device' ? agentKeyToAgentId(auth.device) : null

  if (path === '/api/daily-log' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id?: string; content: string }
    if (!data.content?.trim()) { json(res, { error: 'Content required' }, 400); return true }
    appendDailyLog(data.agent_id || MAIN_AGENT_ID, data.content.trim())
    // Warn-only homoglyph check (GATEHOMOGLIFSWEEP816) -- see memories.ts.
    const homoglyphs = detectHomoglyphs(data.content)
    if (homoglyphs.length > 0) {
      const warning = formatHomoglyphWarning(homoglyphs)
      logger.warn({ agent: data.agent_id }, `daily-log entry saved with ${warning}`)
      json(res, { ok: true, homoglyph_warning: warning })
      return true
    }
    json(res, { ok: true })
    return true
  }

  if (path === '/api/daily-log' && method === 'GET') {
    const agent = authenticatedAgentId || url.searchParams.get('agent') || MAIN_AGENT_ID
    const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0]
    json(res, getDailyLog(agent, date))
    return true
  }

  if (path === '/api/daily-log/dates' && method === 'GET') {
    const agent = authenticatedAgentId || url.searchParams.get('agent') || MAIN_AGENT_ID
    json(res, getDailyLogDates(agent))
    return true
  }

  return false
}
