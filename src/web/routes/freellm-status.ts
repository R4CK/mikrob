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
import { getDb } from '../../db.js'
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

// Counters come from the kanban_comments trail offload-dispatch.sh already writes (author
// "local-llm", card 4eb3743e's freellm_draft_comment_body / fail_body headers) -- no new log
// format, same "read what already exists" principle as card-build-route-24h-measure.sh.
const FREELLM_DRAFT_HEADER = '[LOCAL-LLM DRAFT | freellm'
function freellmCounters24h(): { calls: number; drafts: number; lastError: string | null } {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600
  const rows = db
    .prepare(
      `SELECT content, created_at FROM kanban_comments
       WHERE author = 'local-llm' AND content LIKE ? AND created_at >= ?
       ORDER BY created_at ASC`,
    )
    .all(`${FREELLM_DRAFT_HEADER}%`, cutoff) as Array<{ content: string; created_at: number }>

  let calls = 0
  let drafts = 0
  let lastError: string | null = null
  for (const row of rows) {
    calls += 1
    if (row.content.startsWith(`${FREELLM_DRAFT_HEADER} FAILED]`)) {
      lastError = row.content
    } else {
      drafts += 1
    }
  }
  return { calls, drafts, lastError }
}

export async function tryHandleFreellmStatus(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
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
