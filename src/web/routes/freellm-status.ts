// freellm status route (card a8e34618): the dashboard FreeAPI LLM page calls GET/PUT
// /api/freellm/status, but that route never existed -- a Pair-FE/Pair-BE gap (web/app-freellm.js
// was built against a contract the backend never got). Contract taken from the REAL, already-
// shipped FE code (web/app-freellm.js), not the card description's loose "POST" wording:
//   GET  /api/freellm/status -> { enabled, calls, drafts, lastError }
//   PUT  /api/freellm/status { enabled: boolean } -> same shape (writes the switch file)
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readBody, json } from '../http-helpers.js'
import { STORE_DIR } from '../../config.js'
import { getFreellmCallRows, getFreellmCallCounts, getLatestFreellmFailure } from '../../db.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

export const FREELLM_ENABLED_PATH = join(STORE_DIR, 'freellm-enabled.json')

// Same strict parse as freellm-call.sh's own switch check (card 4eb3743e F4): `d.get('enabled')
// is True`, not a truthy/string compare -- {"enabled":"true"} or {"enabled":1} must read as OFF.
// Missing/unreadable/malformed file = OFF, fail-closed like every other switch in this codebase.
function readFreellmEnabled(): boolean {
  if (!existsSync(FREELLM_ENABLED_PATH)) return false
  try {
    const raw = readFileSync(FREELLM_ENABLED_PATH, 'utf-8')
    const d: unknown = JSON.parse(raw)
    return typeof d === 'object' && d !== null && (d as Record<string, unknown>).enabled === true
  } catch {
    return false
  }
}

// atomicWriteFileSync renames a tmp file over the target -- rename(2) never follows a symlink at
// the destination (it replaces the directory entry itself), so this is already symlink-safe
// without an extra lstat check. Mode 0600, regular-file content only (one JSON object, no
// surprise fields): the switch file carries nothing but the single boolean the bash side reads.
function writeFreellmEnabled(enabled: boolean): void {
  atomicWriteFileSync(FREELLM_ENABLED_PATH, JSON.stringify({ enabled }) + '\n', { mode: 0o600 })
}

// Card 685f25cb: counters now come from llm_ledger (provider='freellm'), one row per REAL call --
// success and failure both -- appended by freellm-call.sh's own _freellm_ledger_log on every exit
// path (card e96d56c5 F4). The earlier version counted only kanban_comments rows left by the
// local-llm offload path, which miscounted/missed calls that never produced a draft comment at
// all (MikroB root-cause measurement, card 685f25cb, 2026-11-20).
function freellmCounters24h(): { calls: number; drafts: number; lastError: string | null } {
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600
  const counts = getFreellmCallCounts(cutoff)
  const latestFailure = getLatestFreellmFailure(cutoff)
  return {
    calls: counts.total,
    drafts: counts.ok,
    lastError: latestFailure ? `FreeLLM call failed: ${latestFailure.fail_reason ?? 'unknown'}` : null,
  }
}

// Normalizes llm_ledger's fail_reason strings (set by freellm-call.sh's own exit handling) into
// the outcome vocabulary card 685f25cb asks for. fail_reason is never prompt/response content --
// it is one of a fixed, short set of labels freellm-call.sh itself writes (auth_401, auth_403,
// quota_429, http_<code>, http_<code> with an empty code for a stalled/timed-out attempt).
function freellmOutcome(ok: boolean, failReason: string | null): string {
  if (ok) return 'ok'
  if (!failReason) return 'fail'
  if (failReason.startsWith('auth_')) return 'auth'
  if (failReason === 'quota_429') return '429'
  if (failReason === 'http_') return 'stalled'
  return 'fail'
}

const FREELLM_CALLS_DEFAULT_WINDOW_S = 7 * 24 * 3600
const FREELLM_CALLS_MAX_LIMIT = 500
const FREELLM_CALLS_DEFAULT_LIMIT = 50

async function handleFreellmCalls(ctx: RouteContext): Promise<void> {
  const { res, url } = ctx
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw !== null ? parseInt(limitRaw, 10) : FREELLM_CALLS_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > FREELLM_CALLS_MAX_LIMIT) {
    json(res, { error: `limit must be an integer between 1 and ${FREELLM_CALLS_MAX_LIMIT}` }, 400)
    return
  }
  const sinceRaw = url.searchParams.get('since')
  const now = Math.floor(Date.now() / 1000)
  let sinceS: number
  if (sinceRaw !== null) {
    const parsed = parseInt(sinceRaw, 10)
    if (!Number.isInteger(parsed) || parsed < 0) {
      json(res, { error: 'since must be a non-negative unix timestamp (seconds)' }, 400)
      return
    }
    sinceS = parsed
  } else {
    sinceS = now - FREELLM_CALLS_DEFAULT_WINDOW_S
  }

  const rows = getFreellmCallRows({ sinceS, limit })
  json(res, {
    calls: rows.map((r) => ({
      ts: r.ts,
      agent: r.agent_id,
      card: r.card_id,
      model: r.model,
      outcome: freellmOutcome(r.ok, r.fail_reason),
      fail_reason: r.fail_reason,
      duration_ms: r.latency_ms,
    })),
    counts_24h: getFreellmCallCounts(now - 24 * 3600),
    counts_7d: getFreellmCallCounts(now - 7 * 24 * 3600),
  })
}

export async function tryHandleFreellmStatus(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/freellm/calls' && method === 'GET') {
    try {
      await handleFreellmCalls(ctx)
    } catch (err) {
      logger.error({ err }, 'freellm-calls: unexpected failure')
      json(res, { error: 'internal_error' }, 500)
    }
    return true
  }

  if (path !== '/api/freellm/status') return false

  try {
    if (method === 'GET') {
      const { calls, drafts, lastError } = freellmCounters24h()
      json(res, { enabled: readFreellmEnabled(), calls, drafts, lastError })
      return true
    }

    if (method === 'PUT') {
      const raw = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(raw.toString())
      } catch {
        json(res, { error: 'body must be valid JSON' }, 400)
        return true
      }
      if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).enabled !== 'boolean') {
        json(res, { error: 'body must be {"enabled": boolean}' }, 400)
        return true
      }
      const enabled = (body as { enabled: boolean }).enabled
      writeFreellmEnabled(enabled)
      const { calls, drafts, lastError } = freellmCounters24h()
      json(res, { enabled, calls, drafts, lastError })
      return true
    }
  } catch (err) {
    logger.error({ err }, 'freellm-status: unexpected failure')
    json(res, { error: 'internal_error' }, 500)
    return true
  }

  return false
}
