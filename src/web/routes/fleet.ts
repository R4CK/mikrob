import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { exportFleet, importFleet, MIN_VAULT_PASSWORD_LEN, UserFacingError, type ExportedFleet } from '../fleet-transfer.js'
import type { RouteContext } from './types.js'

export async function tryHandleFleet(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path !== '/api/fleet/export' && path !== '/api/fleet/import') return false

  // H1: vault password via header, not query string (avoids access-log / proxy-log / browser-history leakage)
  const vaultPassword = req.headers['x-vault-password'] as string | undefined

  if (path === '/api/fleet/export' && method === 'GET') {
    if (vaultPassword !== undefined && vaultPassword.length < MIN_VAULT_PASSWORD_LEN) {
      json(res, { error: `X-Vault-Password must be at least ${MIN_VAULT_PASSWORD_LEN} characters.` }, 400)
      return true
    }
    try {
      const exported: ExportedFleet = exportFleet({ vaultPassword: vaultPassword || undefined })
      const buf = Buffer.from(exported.data)
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="fleet-export-${exported.exportedAt.slice(0, 10)}.json"`,
        'Content-Length': buf.byteLength,
      })
      res.end(buf)
    } catch (err: any) {
      if (err instanceof UserFacingError) {
        json(res, { error: err.message }, 400)
      } else {
        logger.error({ err: err.message }, 'Fleet export failed')
        json(res, { error: `Export hiba: ${err.message}` }, 500)
      }
    }
    return true
  }

  if (path === '/api/fleet/import' && method === 'POST') {
    const apply = ctx.url.searchParams.get('apply') === 'true'
    // Card 68254bd7: the explicit, logged opt-in for risky fields (toolDeny/securityProfile/
    // capabilities/customProvider/settings.hooks) -- default false, same `=== 'true'` posture as
    // `apply` above (an unknown/garbage value never accidentally opts in).
    const allowRiskyFields = ctx.url.searchParams.get('allowRiskyFields') === 'true'

    // Card 68254bd7 (MikroB follow-up, msg 10134): an APPLYING import must come from a human --
    // a browser session or a device key -- never the shared fleet dashboard bearer every agent
    // holds. MEASURED: the central auth gate (web.ts resolveAuth) already resolves this per
    // request into ctx.auth.kind, so the route CAN distinguish without any new mechanism. This does
    // not close an existing privilege (same-UID agents can already rewrite each other's settings.json
    // on disk, card 8eca67f0) -- it closes the NETWORK-reachable, unlogged path to the same effect,
    // which a compromised agent could use without first getting filesystem access. Dry-run
    // (apply=false) stays open to any authenticated caller -- it writes nothing.
    if (apply && ctx.auth?.kind !== 'session' && ctx.auth?.kind !== 'device') {
      logger.warn({ authKind: ctx.auth?.kind ?? 'none' }, 'Fleet import: apply=true rejected for non-human credential')
      json(res, { error: 'Fleet import (apply=true) requires a browser session or a device key, not the shared agent token.' }, 403)
      return true
    }

    // M1: check vault password length for import side too
    if (vaultPassword !== undefined && vaultPassword.length < MIN_VAULT_PASSWORD_LEN) {
      json(res, { error: `X-Vault-Password must be at least ${MIN_VAULT_PASSWORD_LEN} characters.` }, 400)
      return true
    }

    let rawBody: string
    try {
      const buf = await readBody(req)
      rawBody = buf.toString()
    } catch (err: any) {
      json(res, { error: `Kérés olvasási hiba: ${err.message}` }, 400)
      return true
    }

    // Card 68254bd7 (MikroB follow-up, msg 10134): every import attempt logs who, what shape, and
    // for which target -- independent of apply vs dry-run, and independent of the allowRiskyFields
    // audit line already in fleet-transfer.ts (that one is specific to the opt-in; this one is
    // "an import happened at all").
    logger.info(
      { authKind: ctx.auth?.kind ?? 'none', user: ctx.auth?.kind === 'session' ? ctx.auth.user : undefined, apply, allowRiskyFields, bodyBytes: rawBody.length },
      'Fleet import: request received',
    )

    // importFleet handles JSON parse (and encrypted blob detection) internally
    try {
      const result = importFleet(rawBody, { vaultPassword: vaultPassword || undefined, apply, allowRiskyFields })
      if ('dryRun' in result && result.errors.length > 0) {
        json(res, result, 400)
      } else {
        if (apply) {
          logger.info(
            { authKind: ctx.auth?.kind, user: ctx.auth?.kind === 'session' ? ctx.auth.user : undefined, imported: 'imported' in result ? result.imported : undefined },
            'Fleet import: applied',
          )
        }
        json(res, result, 200)
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Fleet import failed')
      json(res, { error: `Import hiba: ${err.message}` }, 500)
    }
    return true
  }

  return false
}
