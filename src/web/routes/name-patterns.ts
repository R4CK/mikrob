// GET/POST/DELETE /api/security/name-patterns -- operator CRUD for the outgoing-copy gate's
// name/phrase rules (card 98dbbcc9). Storage, validation and the 0600 discipline live in
// web/outgoing-name-patterns.ts; this module owns the HTTP concerns only.
//
// Auth: nothing is allowlisted in requiresAuth(), so every path here is Bearer/session gated
// by default. Principals are narrowed further on purpose -- these rules decide what the fleet
// is allowed to SAY, so a federation peer or a paired device must not be able to read the
// list (it names a private person) or edit it (it is a security control).
//
// Content discipline: the patterns go to the authenticated operator's screen and nowhere
// else. The audit row and the logger get COUNTS. This is the one endpoint in the codebase
// where "log the new value" would itself be the leak.

import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { logConfigChange } from '../../db.js'
import {
  addPattern,
  removePattern,
  readPatterns,
  fileModeOk,
  rulesFileExists,
  defaultDeps,
  NamePatternError,
  type NamePatternDeps,
} from '../outgoing-name-patterns.js'
import type { RouteContext } from './types.js'

const PATH = '/api/security/name-patterns'
const BODY_MAX_BYTES = 8 * 1024
const ADMIN_KINDS = ['token', 'session'] as const

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

async function body(req: RouteContext['req']): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await readBody(req, { maxBytes: BODY_MAX_BYTES })).toString().trim()
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return null
  }
}

export async function tryHandleNamePatterns(
  ctx: RouteContext,
  deps: NamePatternDeps = defaultDeps(),
): Promise<boolean> {
  const { req, res, path, method, auth } = ctx
  if (path !== PATH) return false
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') return false

  if (auth === undefined || !ADMIN_KINDS.includes(auth.kind as (typeof ADMIN_KINDS)[number])) {
    json(res, { error: 'Forbidden for this credential type' }, 403)
    return true
  }

  if (method === 'GET') {
    const { state, patterns } = readPatterns(deps)
    json(res, {
      patterns,
      state,
      file_exists: rulesFileExists(deps),
      file_mode_ok: fileModeOk(deps),
      read_only: deps.isWorktree(),
    })
    return true
  }

  const parsed = await body(req)
  if (parsed === null) {
    json(res, { error: 'Invalid JSON' }, 400)
    return true
  }

  try {
    if (method === 'POST') {
      const value = str(parsed.value).trim()
      const mode = str(parsed.mode) || 'literal'
      if (!value) {
        json(res, { error: 'Üres minta nem vehető fel.' }, 400)
        return true
      }
      if (mode !== 'literal' && mode !== 'regex') {
        json(res, { error: "A mód csak 'literal' vagy 'regex' lehet." }, 400)
        return true
      }
      const { count } = addPattern(deps, value, mode)
      // Count and mode only. The pattern itself is the sensitive half and must not reach
      // the config-change trail, which is readable on the Napló page.
      logConfigChange('security.name_patterns', count - 1, count, auth.kind)
      logger.info({ count, mode }, 'outgoing-copy-gate name pattern added')
      json(res, { ok: true, count }, 201)
      return true
    }

    const pattern = str(parsed.pattern)
    if (!pattern) {
      json(res, { error: 'Hiányzik a törlendő minta.' }, 400)
      return true
    }
    const { count, removed } = removePattern(deps, pattern)
    if (!removed) {
      json(res, { error: 'Ez a minta nincs a listán (közben módosulhatott). Frissítsd a listát.' }, 404)
      return true
    }
    logConfigChange('security.name_patterns', count + 1, count, auth.kind)
    logger.info({ count }, 'outgoing-copy-gate name pattern removed')
    json(res, { ok: true, count })
    return true
  } catch (err) {
    if (err instanceof NamePatternError) {
      // The validator's message describes what the operator just typed, so it is safe to
      // return to that same authenticated operator -- and it is NOT logged.
      json(res, { error: err.message }, 400)
      return true
    }
    logger.error({ err: (err as Error).message }, 'name pattern update failed')
    json(res, { error: 'A minta mentése nem sikerült.' }, 500)
    return true
  }
}
