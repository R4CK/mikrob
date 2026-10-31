// MT-04 (card 34c2d2a2): GET /api/kg/search and GET /api/kg/for-card/:cardId. Both sit behind
// KG_ENABLED (platform kill switch, config-registry.ts) -- off (the default) means these two
// routes 404, same posture the MODULTERV's "kapcsoló mögött, alapból OFF" rule asks for, and the
// same no-op-until-flagged pattern src/web/kg-capture-hook.ts already uses for MT-05's write side.

import { getEffectiveSettingValue } from '../../settings-store.js'
import { getSettingDefinition } from '../../config-registry.js'
import { json } from '../http-helpers.js'
import { openKgDb, kgDbPath } from '../../kg/store.js'
import { hybridKgSearch, KgSearchError } from '../../kg/search.js'
import { buildForCardPackage } from '../../kg/for-card.js'
import { recordKgOffered } from '../../kg/usage.js'
import { OLLAMA_URL } from '../../config.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'
import type Database from 'better-sqlite3'

// WhiteHat NO-GO F2 MEDIUM (card 34c2d2a2, comment 24103): `k` had no upper bound (the KG_TOPK
// registry max only applied to the DEFAULT when the caller omitted `k`), and `q`/`path`/`types`
// had no length/count bound at all -- an oversized `k` scales both the SQL LIMIT and the embedding
// candidate set, and an oversized `q`/list grows every response linearly with no cap.
const MAX_Q_LEN = 2000
const MAX_LIST_PARAMS = 32

/** Clamps a caller-supplied `k` to the KG_TOPK registry's own [min,max] -- same bound the
 *  default already respects, now also enforced on an explicit value. Exported test-only so the
 *  clamp itself can be asserted directly, not just inferred from a 200 that didn't crash. */
export function resolveK(kRaw: string | null): number {
  const fallback = numberSetting('KG_TOPK', 3)
  if (kRaw === null) return fallback
  const n = parseInt(kRaw, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  const def = getSettingDefinition('KG_TOPK')
  const max = def?.max ?? 8
  return Math.min(n, max)
}

// Accepts both the config-registry canonical boolean form ("1", set via the dashboard Settings
// API/setOverride) and the pre-existing shell convention store/kg-check-landing.sh already reads
// straight off the env ("on") -- that script predates this card's config-registry entry and reads
// KG_ENABLED directly from the process environment, never through settings-store, so a plain .env
// line of either form must gate both consumers the same way.
const TRUE_VALUES = new Set(['1', 'true', 'on'])

function kgEnabled(): boolean {
  try {
    return TRUE_VALUES.has(String(getEffectiveSettingValue('KG_ENABLED')).toLowerCase())
  } catch {
    return false
  }
}

function numberSetting(key: string, fallback: number): number {
  try {
    const v = Number(getEffectiveSettingValue(key))
    return Number.isFinite(v) ? v : fallback
  } catch {
    return fallback
  }
}

let kgDbSingleton: ReturnType<typeof openKgDb> | null = null
function kgDb(): ReturnType<typeof openKgDb> {
  if (!kgDbSingleton) kgDbSingleton = openKgDb(kgDbPath())
  return kgDbSingleton
}

// Card 9b13108b: the Megoldás-tár page (web/app-kg.js, kgLoadStats) already calls this
// endpoint and reads the response defensively field-by-field -- its own header comment marks
// the shape as a forward-compatible proposal pending BE confirmation, so this implementation
// is that confirmation: counts grouped by type (excluding archived, which is a terminal,
// deliberately-retired status, same reasoning store.ts's PROTECTED_STATUSES applies), a
// used/offered usage rate from kg_usage (MT-08), and pending/done/total from the backfill queue
// (MT-06, kg_capture_queue).
interface KgStatsPayload {
  ollama_available: boolean
  nodes: Record<string, number>
  usage: { rate: number } | null
  backfill: { pending: number; done: number; total: number }
}

function computeKgStats(db: Database.Database): Omit<KgStatsPayload, 'ollama_available'> {
  const nodeRows = db
    .prepare(`SELECT type, COUNT(*) AS n FROM kg_nodes WHERE status != 'archived' GROUP BY type`)
    .all() as { type: string; n: number }[]
  const nodes: Record<string, number> = {}
  for (const row of nodeRows) nodes[row.type] = row.n

  const offered = (db.prepare(`SELECT COUNT(*) AS n FROM kg_usage WHERE event = 'offered'`).get() as { n: number }).n
  const used = (db.prepare(`SELECT COUNT(*) AS n FROM kg_usage WHERE event = 'used'`).get() as { n: number }).n
  const usage = offered > 0 ? { rate: used / offered } : null

  const queueRows = db
    .prepare(`SELECT state, COUNT(*) AS n FROM kg_capture_queue GROUP BY state`)
    .all() as { state: string; n: number }[]
  let pending = 0
  let total = 0
  let done = 0
  for (const row of queueRows) {
    total += row.n
    if (row.state === 'pending') pending = row.n
    if (row.state === 'done') done = row.n
  }

  return { nodes, usage, backfill: { pending, done, total } }
}

async function checkOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

export async function tryHandleKg(ctx: RouteContext): Promise<boolean> {
  const { path, method, url, res } = ctx

  if (path === '/api/kg/stats' && method === 'GET') {
    if (!kgEnabled()) {
      json(res, { error: 'kg_disabled' }, 404)
      return true
    }
    const ollama_available = await checkOllamaAvailable()
    const { nodes, usage, backfill } = computeKgStats(kgDb())
    json(res, { ollama_available, nodes, usage, backfill })
    return true
  }

  if (path === '/api/kg/search' && method === 'GET') {
    if (!kgEnabled()) {
      json(res, { error: 'kg_disabled' }, 404)
      return true
    }
    const q = url.searchParams.get('q') ?? undefined
    const project = url.searchParams.get('project') ?? undefined
    const cardId = url.searchParams.get('card_id') ?? undefined
    const paths = url.searchParams.getAll('path')
    const types = url.searchParams.getAll('types')
    const strict = url.searchParams.get('strict') === '1'
    const k = resolveK(url.searchParams.get('k'))
    if (!q && paths.length === 0) {
      json(res, { error: 'q_or_path_required' }, 400)
      return true
    }
    if (q && q.length > MAX_Q_LEN) {
      json(res, { error: 'q_too_long' }, 400)
      return true
    }
    if (paths.length > MAX_LIST_PARAMS || types.length > MAX_LIST_PARAMS) {
      json(res, { error: 'too_many_values' }, 400)
      return true
    }
    if (project && project.length > MAX_Q_LEN) {
      json(res, { error: 'project_too_long' }, 400)
      return true
    }
    try {
      const { results, meta } = await hybridKgSearch(kgDb(), {
        q,
        project,
        cardId,
        paths: paths.length > 0 ? paths : undefined,
        types: types.length > 0 ? types : undefined,
        strict,
        k,
        minScore: numberSetting('KG_MIN_SCORE', 0.35),
        expandHops: numberSetting('KG_EXPAND_HOPS', 1),
        snippetMaxLines: numberSetting('KG_SNIPPET_MAX_LINES', 60),
      })
      res.setHeader('X-KG-Search', `relaxed=${meta.relaxed}; hits=${meta.hits}; scope=${meta.scope}`)
      json(res, { results, meta })
    } catch (err) {
      if (err instanceof KgSearchError) {
        json(res, { error: err.code }, 400)
        return true
      }
      logger.warn({ err }, 'kg-search: unexpected error')
      json(res, { error: 'kg_search_failed' }, 500)
    }
    return true
  }

  const forCardMatch = path.match(/^\/api\/kg\/for-card\/([^/]+)$/)
  if (forCardMatch && method === 'GET') {
    if (!kgEnabled()) {
      json(res, { error: 'kg_disabled' }, 404)
      return true
    }
    const cardId = forCardMatch[1]!
    const k = resolveK(url.searchParams.get('k'))
    const pkg = await buildForCardPackage(kgDb(), cardId, {
      k,
      minScore: numberSetting('KG_MIN_SCORE', 0.35),
      expandHops: numberSetting('KG_EXPAND_HOPS', 1),
      maxChars: numberSetting('KG_INJECT_MAX_CHARS', 3000),
    })
    // MT-08 (card 1a350f22): every node actually served here is "offered" to this card, so a
    // later `Megoldás-tár:` REVIEW line can be checked against it (anti-inflation gate in
    // kg/usage.ts). Best-effort: a usage-write failure must never break the package response
    // itself -- the agent still gets its for-card answer either way.
    try {
      const offeredIds = [...pkg.solutions, ...pkg.known_pitfalls, ...pkg.decisions].map((e) => e.card_id)
      if (offeredIds.length > 0) {
        const agent = ctx.auth?.kind === 'token' ? ctx.auth.agent ?? 'unknown' : 'unknown'
        recordKgOffered(kgDb(), cardId, offeredIds, agent)
      }
    } catch (err) {
      logger.warn({ err }, 'kg-for-card: recordKgOffered failed, package still served')
    }
    json(res, pkg)
    return true
  }

  return false
}
