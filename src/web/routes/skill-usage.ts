import {
  logSkillUsage,
  getSkillUsageRows,
  getSkillUsageStats,
  SKILL_USAGE_COVERAGE,
} from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleSkillUsage(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/skill-usage -- record a skill usage event (from PostToolUse hook)
  if (path === '/api/skill-usage' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      agent_id: string
      skill_name: string
      trigger_type: 'tool_call' | 'skill_read'
      session_id?: string | null
    }
    if (!data.agent_id || !data.skill_name || !data.trigger_type) {
      json(res, { error: 'agent_id, skill_name and trigger_type required' }, 400)
      return true
    }
    if (data.trigger_type !== 'tool_call' && data.trigger_type !== 'skill_read') {
      json(res, { error: 'trigger_type must be tool_call or skill_read' }, 400)
      return true
    }
    logSkillUsage(data.agent_id, data.skill_name, data.trigger_type, data.session_id)
    json(res, { ok: true })
    return true
  }

  // GET /api/skill-usage/stats -- aggregated counts per skill (for dream-engine health)
  //
  // RETURNS { coverage, stats }, NOT A BARE ARRAY (card a10ecfe3). The sole consumer of this
  // endpoint is a PROMPT -- the dream-engine's skill-fleet-health bucket -- and the question it asks
  // is "which skills are antiquated". A bare array invites exactly one reading: a skill missing from
  // it is unused. That reading is wrong here and the resulting suggestion is destructive; see
  // SKILL_USAGE_COVERAGE for the measurement (152 skills on disk, 12 observed). Shipping the caveat
  // INSIDE the payload is the only placement a prompt-shaped consumer cannot skip -- a comment in
  // this file, or prose in a runbook, is not read by the thing making the call.
  if (path === '/api/skill-usage/stats' && method === 'GET') {
    const since = url.searchParams.get('since') ? parseInt(url.searchParams.get('since')!) : undefined
    const stats = getSkillUsageStats(since)
    json(res, {
      coverage: { ...SKILL_USAGE_COVERAGE, distinctSkillsObserved: stats.length },
      stats,
    })
    return true
  }

  // GET /api/skill-usage -- recent usage rows (with optional filters)
  if (path === '/api/skill-usage' && method === 'GET') {
    const since = url.searchParams.get('since') ? parseInt(url.searchParams.get('since')!) : undefined
    const agentId = url.searchParams.get('agent_id') ?? undefined
    const skillName = url.searchParams.get('skill_name') ?? undefined
    const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!) : 500
    json(res, getSkillUsageRows({ since, agentId, skillName, limit }))
    return true
  }

  return false
}
