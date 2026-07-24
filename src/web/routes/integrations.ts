/**
 * /api/settings/integrations/* — integration credential management.
 *
 * SECURITY: trust boundary. Every route requires the /api/* Bearer gate
 * enforced upstream in src/web.ts. Keys are stored encrypted via the vault;
 * only a masked value is ever returned over the wire (never the raw key).
 *
 * Contract (GEMINI-1/GEMINI-2 cards, FE-facing):
 *   GET  /api/settings/integrations/gemini → { configured: bool, masked: string|null }
 *   PUT  /api/settings/integrations/gemini  body: { apiKey: string }
 *                                          → PUT probe-validates the key against the
 *                                            live Gemini API BEFORE storing it (card
 *                                            GEMINI-1, fail-closed) → { ok: true, masked: string }
 *   DELETE /api/settings/integrations/gemini → { ok: true }
 */

import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { getSecret, setSecret, deleteSecret } from '../vault.js'
import { validateGeminiKey, type GeminiValidateError } from '../gemini-validate.js'
import type { RouteContext } from './types.js'

const GEMINI_VAULT_ID = 'integration.gemini.apiKey'
const GEMINI_VAULT_LABEL = 'Gemini API Key'

/** rule-12: speaks TO the user (what's wrong + what to do), never a raw code/stack; the
 *  key itself never appears in any of these strings. */
const VALIDATION_FEEDBACK: Record<GeminiValidateError, { status: number; error: string }> = {
  invalid: {
    status: 400,
    error:
      'A megadott Gemini API kulcsot a Gemini elutasította (érvénytelen vagy nincs jogosultsága). Ellenőrizd a kulcsot és próbáld újra.',
  },
  unexpected: {
    status: 502,
    error: 'A Gemini API nem várt választ adott a kulcs ellenőrzésekor. Próbáld újra később.',
  },
  network: {
    status: 504,
    error:
      'Nem sikerült elérni a Gemini API-t a kulcs ellenőrzéséhez (hálózati hiba vagy időtúllépés). Ellenőrizd a kapcsolatot és próbáld újra.',
  },
}

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

        // GEMINI-1: probe-validate against the LIVE Gemini API before persisting.
        // Fail-closed -- an invalid/typo'd/revoked key is never written to the vault.
        // Note: the key is intentionally never included in this log line (leak-safe).
        const validation = await validateGeminiKey(trimmed)
        if (!validation.ok) {
          const code = validation.error ?? 'unexpected'
          const feedback = VALIDATION_FEEDBACK[code]
          logger.warn({ vaultId: GEMINI_VAULT_ID, reason: code }, 'Gemini API key validation failed')
          json(res, { error: feedback.error }, feedback.status)
          return true
        }

        setSecret(GEMINI_VAULT_ID, GEMINI_VAULT_LABEL, trimmed)
        logger.info({ vaultId: GEMINI_VAULT_ID }, 'Gemini API key stored')
        json(res, { ok: true, masked: maskKey(trimmed) })
      } catch (err) {
        logger.error({ err }, 'Failed to store Gemini API key')
        json(res, { error: 'Nem sikerült elmenteni a Gemini API kulcsot. Próbáld újra.' }, 500)
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
