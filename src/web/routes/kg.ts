// MT-04 (card 34c2d2a2): GET /api/kg/search and GET /api/kg/for-card/:cardId. Both sit behind
// KG_ENABLED (platform kill switch, config-registry.ts) -- off (the default) means these two
// routes 404, same posture the MODULTERV's "kapcsoló mögött, alapból OFF" rule asks for, and the
// same no-op-until-flagged pattern src/web/kg-capture-hook.ts already uses for MT-05's write side.

import { getEffectiveSettingValue } from '../../settings-store.js'
import { json } from '../http-helpers.js'
import { openKgDb, kgDbPath } from '../../kg/store.js'
import { hybridKgSearch, KgSearchError } from '../../kg/search.js'
import { buildForCardPackage } from '../../kg/for-card.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

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

/** Test-only: drop the cached handle so a test can point a fresh one at a disposable file. */
export function resetKgRouteDbSingletonForTest(): void {
  if (kgDbSingleton) {
    kgDbSingleton.close()
    kgDbSingleton = null
  }
}

export async function tryHandleKg(ctx: RouteContext): Promise<boolean> {
  const { path, method, url, res } = ctx

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
    const kRaw = url.searchParams.get('k')
    const k = kRaw !== null ? parseInt(kRaw, 10) : numberSetting('KG_TOPK', 3)
    if (!q && paths.length === 0) {
      json(res, { error: 'q_or_path_required' }, 400)
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
        k: Number.isFinite(k) && k > 0 ? k : numberSetting('KG_TOPK', 3),
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
    const kRaw = url.searchParams.get('k')
    const k = kRaw !== null ? parseInt(kRaw, 10) : numberSetting('KG_TOPK', 3)
    const pkg = await buildForCardPackage(kgDb(), cardId, {
      k: Number.isFinite(k) && k > 0 ? k : numberSetting('KG_TOPK', 3),
      minScore: numberSetting('KG_MIN_SCORE', 0.35),
      expandHops: numberSetting('KG_EXPAND_HOPS', 1),
      maxChars: numberSetting('KG_INJECT_MAX_CHARS', 3000),
    })
    json(res, pkg)
    return true
  }

  return false
}
