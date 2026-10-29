// freellm keys proxy (card 08d1aa90): write-only key surface for the dashboard,
// proxying to the local freellmapi /api/keys behind its own session auth.
// The dashboard never stores or logs the plaintext key: GET only ever returns
// what freellmapi itself already masks (provider/platform + last 4 chars).
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  freellmapiRequest,
  FreellmapiUnavailableError,
  FreellmapiUpstreamError,
} from '../freellmapi-client.js'
import type { RouteContext } from './types.js'

// Same 5 providers the FE offers (web/app-freellm.js FREELLM_PROVIDERS) -- the
// FE's list is not a security control (RedHat/WhiteHat B4, card 08d1aa90),
// so the server enforces its own copy, fail-closed on anything else.
const ALLOWED_PROVIDERS = new Set(['groq', 'cerebras', 'google_ai_studio', 'openrouter', 'mistral'])
const MAX_KEY_LENGTH = 512

interface UpstreamKeyRow {
  id: number
  platform: string
  maskedKey?: string
  // freellmapi's SQLite driver returns this as a "YYYY-MM-DD HH:MM:SS" string
  // (UTC), not a unix epoch -- confirmed against the live service (card
  // 08d1aa90 integration check), never assumed from the route's own contract.
  createdAt?: string | number
}

function parseUpstreamCreatedAt(value: string | number | undefined): number | null {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return null
  const ms = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

interface KeyStatus {
  set: boolean
  hint: string | null
  error: 'decrypt_failed' | null
}

// Normalizes freellmapi's own maskKey() output (server/src/lib/crypto.ts,
// measured against the installed service, card fd5fcc2c D1 finding) into a
// shape the FE can render without parsing a mask string:
//   len < 5   -> "****"             -> no hint
//   len 5-8   -> "****" + last2     -> hint = last2
//   len > 8   -> first4 + "..." + last4 -> hint = last4 (first4 dropped: the
//                card's own contract promises only the last 4 chars, never
//                any prefix of the real key)
//   decrypt failure -> the literal "[decrypt failed]" -- surfaced as an
//                explicit error, not silently rendered as "set"
function normalizeUpstreamMask(maskedKey: string | undefined): KeyStatus {
  if (!maskedKey) return { set: false, hint: null, error: null }
  if (maskedKey === '[decrypt failed]') return { set: true, hint: null, error: 'decrypt_failed' }
  // WhiteHat2 GO 25458 L1: cap the hint at 4 characters even if a future/hostile
  // upstream shape returns more -- the card's contract promises only the last 4,
  // never a longer tail (measured against today's real upstream: already exactly 4).
  const dotted = maskedKey.match(/\.\.\.(.+)$/)
  if (dotted) return { set: true, hint: dotted[1].slice(-4), error: null }
  const starred = maskedKey.match(/^\*+(.*)$/)
  if (starred) return { set: true, hint: starred[1].length > 0 ? starred[1].slice(-4) : null, error: null }
  // Unrecognized shape -- fail closed rather than guess at a hint.
  return { set: true, hint: null, error: null }
}

function freellmKeyUnavailable(res: import('node:http').ServerResponse): void {
  json(res, {
    error: 'freellm_upstream_unavailable',
    message: 'A freellmapi szolgáltatás jelenleg nem elérhető. Próbáld újra később.',
  }, 503)
}

export async function tryHandleFreellmKeys(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (!path.startsWith('/api/freellm/keys')) return false

  try {
    // POST /api/freellm/keys {provider, key}
    if (path === '/api/freellm/keys' && method === 'POST') {
      const raw = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(raw.toString())
      } catch {
        json(res, { error: 'body must be valid JSON' }, 400)
        return true
      }
      if (!body || typeof body !== 'object') { json(res, { error: 'body must be an object' }, 400); return true }
      const { provider, key } = body as Record<string, unknown>
      if (typeof provider !== 'string' || !ALLOWED_PROVIDERS.has(provider)) {
        json(res, { error: 'provider must be one of the supported providers' }, 400); return true
      }
      if (typeof key !== 'string' || !key.trim() || key.length > MAX_KEY_LENGTH) {
        json(res, { error: `key must be a non-empty string of at most ${MAX_KEY_LENGTH} characters` }, 400); return true
      }

      // RedHat NO-GO 25444 F1: freellmapi's /api/keys add is an unconditional INSERT,
      // not an upsert -- a second POST for the same provider left two rows instead
      // of replacing the first, so "rotating" a key did not retire the old one.
      // Enforce exactly one row per provider here: remove every existing row for
      // this provider BEFORE adding the new one.
      const existing = await freellmapiRequest('GET', '/api/keys')
      if (existing.status >= 400) { json(res, { error: 'freellm_upstream_error' }, 502); return true }
      const existingRows = Array.isArray(existing.data) ? (existing.data as UpstreamKeyRow[]) : []
      for (const row of existingRows.filter((r) => r.platform === provider)) {
        const del = await freellmapiRequest('DELETE', `/api/keys/${row.id}`)
        if (del.status >= 400) { json(res, { error: 'freellm_upstream_error' }, 502); return true }
      }

      const upstream = await freellmapiRequest('POST', '/api/keys', { platform: provider, key })
      if (upstream.status >= 400) {
        // WhiteHat2 GO 25458 L2: do not reflect the upstream's error text verbatim
        // (it echoed `upstream.data?.error?.message`, which could be anything the
        // upstream decides to put there, including a non-string value) -- log the
        // upstream detail server-side and answer with our own fixed message.
        logger.warn({ status: upstream.status, upstreamError: upstream.data?.error }, 'freellm-keys: upstream rejected the key')
        json(res, { error: 'freellm_upstream_rejected', message: 'A freellmapi elutasította a kulcsot.' }, upstream.status === 401 ? 502 : upstream.status)
        return true
      }
      const addedMaskedKey: unknown = upstream.data?.maskedKey
      json(res, {
        provider,
        setBy: 'admin',
        since: Math.floor(Date.now() / 1000),
        ...normalizeUpstreamMask(typeof addedMaskedKey === 'string' ? addedMaskedKey : undefined),
      }, 201)
      return true
    }

    // GET /api/freellm/keys
    if (path === '/api/freellm/keys' && method === 'GET') {
      const upstream = await freellmapiRequest('GET', '/api/keys')
      if (upstream.status >= 400) {
        json(res, { error: 'freellm_upstream_error' }, 502)
        return true
      }
      const rows = Array.isArray(upstream.data) ? (upstream.data as UpstreamKeyRow[]) : []
      json(res, rows.map((row) => ({
        provider: row.platform,
        setBy: 'admin',
        since: parseUpstreamCreatedAt(row.createdAt),
        ...normalizeUpstreamMask(row.maskedKey),
      })))
      return true
    }

    // DELETE /api/freellm/keys/:provider
    const delMatch = path.match(/^\/api\/freellm\/keys\/([^/]+)$/)
    if (delMatch && method === 'DELETE') {
      let provider: string
      try {
        provider = decodeURIComponent(delMatch[1])
      } catch {
        // RedHat NO-GO 25444 F3: a malformed percent-escape (e.g. "%E0%A4%A") makes
        // decodeURIComponent throw, which used to fall through to the generic 500
        // handler below -- this is a client input error, not a server fault.
        json(res, { error: 'invalid provider encoding' }, 400); return true
      }
      if (!ALLOWED_PROVIDERS.has(provider)) {
        json(res, { error: 'provider must be one of the supported providers' }, 400); return true
      }

      const list = await freellmapiRequest('GET', '/api/keys')
      if (list.status >= 400) { json(res, { error: 'freellm_upstream_error' }, 502); return true }
      const rows = Array.isArray(list.data) ? (list.data as UpstreamKeyRow[]) : []
      const matching = rows.filter((r) => r.platform === provider)
      if (matching.length === 0) { json(res, { error: `provider "${provider}" has no key set` }, 404); return true }

      // RedHat NO-GO 25444 F1: delete EVERY row for this provider, not just the
      // first match -- the prior unconditional-INSERT bug (same finding) could
      // have left more than one row, and "deleted: true" must mean no row remains.
      for (const row of matching) {
        const del = await freellmapiRequest('DELETE', `/api/keys/${row.id}`)
        if (del.status >= 400) { json(res, { error: 'freellm_upstream_error' }, 502); return true }
      }
      json(res, { provider, deleted: true })
      return true
    }
  } catch (err) {
    if (err instanceof FreellmapiUnavailableError) {
      freellmKeyUnavailable(res)
      return true
    }
    if (err instanceof FreellmapiUpstreamError) {
      logger.error({ status: err.status }, 'freellm-keys: upstream auth failure')
      json(res, { error: 'freellm_upstream_auth_failed' }, 502)
      return true
    }
    logger.error({ err }, 'freellm-keys: unexpected failure')
    json(res, { error: 'internal_error' }, 500)
    return true
  }

  return false
}
