/**
 * /api/settings/integrations/* — integration credential management.
 *
 * SECURITY: trust boundary. Every route requires the /api/* Bearer gate
 * enforced upstream in src/web.ts. Keys are stored encrypted via the vault;
 * only a masked value is ever returned over the wire (never the raw key).
 *
 * Contract (GEMINI-2 card, FE-facing):
 *   GET  /api/settings/integrations/gemini → { configured: bool, masked: string|null }
 *   PUT  /api/settings/integrations/gemini  body: { apiKey: string }
 *                                          → { ok: true, masked: string }
 *   DELETE /api/settings/integrations/gemini → { ok: true }
 */

import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { getSecret, setSecret, deleteSecret } from '../vault.js'
import type { RouteContext } from './types.js'

const GEMINI_VAULT_ID = 'integration.gemini.apiKey'
const GEMINI_VAULT_LABEL = 'Gemini API Key'

/** Show last 4 chars, mask the rest — never expose the raw key. */
function maskKey(raw: string): string {
  if (raw.length <= 4) return '••••'
  return '•'.repeat(Math.min(raw.length - 4, 16)) + raw.slice(-4)
}

export async function tryHandleIntegrations(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // ── Gemini API key ─────────────────────────────────────────────────────────

  if (path === '/api/settings/integrations/gemini') {
    if (method === 'GET') {
      const raw = getSecret(GEMINI_VAULT_ID)
      json(res, {
        configured: raw !== null,
        masked: raw !== null ? maskKey(raw) : null,
      })
      return true
    }

    if (method === 'PUT') {
      try {
        const body = await readBody(req)
        const { apiKey } = JSON.parse(body.toString()) as { apiKey?: unknown }
        if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
          json(res, { error: 'apiKey is required and must be a non-empty string' }, 400)
          return true
        }
        const trimmed = apiKey.trim()
        setSecret(GEMINI_VAULT_ID, GEMINI_VAULT_LABEL, trimmed)
        logger.info({ vaultId: GEMINI_VAULT_ID }, 'Gemini API key stored')
        json(res, { ok: true, masked: maskKey(trimmed) })
      } catch (err) {
        logger.error({ err }, 'Failed to store Gemini API key')
        json(res, { error: 'Failed to save API key' }, 500)
      }
      return true
    }

    if (method === 'DELETE') {
      const existed = deleteSecret(GEMINI_VAULT_ID)
      if (existed) logger.info({ vaultId: GEMINI_VAULT_ID }, 'Gemini API key removed')
      json(res, { ok: true })
      return true
    }
  }

  return false
}
