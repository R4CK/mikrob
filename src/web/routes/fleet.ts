import { createHash } from 'node:crypto'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { exportFleet, importFleet, MIN_VAULT_PASSWORD_LEN, UserFacingError, type ExportedFleet } from '../fleet-transfer.js'
import { findConsumableApproval, consumeApproval, findPendingApproval } from '../../db.js'
import { createAndNotifyApproval } from './approvals.js'
import type { RouteContext } from './types.js'

// Card 68254bd7 (RedHat NO-GO 14837, MikroB decision 14841): the 'session'/'device' kind-check
// below is a USEFUL early filter but WhiteHat/RedHat both measured that it is not a closed gate
// on its own -- the shared fleet bearer can mint itself a session or device credential via three
// separate routes (bridge-enroll, break-glass password reset + login, deleting the last user to
// reopen the bootstrap exception), none of which this card's own scope covers (RedHat named them
// as a broader "shared bearer is the dashboard's root" issue, routed to MikroB for its own,
// separate decision). The kind-check therefore stays as an additional layer, never the only one:
// an APPLYING import additionally requires a human-resolved, content-bound approval -- the same
// approved/unconsumed/in-window/content_hash mechanism scripts/hooks/email-approval-gate.py
// already uses for outgoing email, applied here from TypeScript instead of a PreToolUse hook.
const FLEET_IMPORT_APPROVAL_CATEGORY = 'fleet_import_apply'
const FLEET_IMPORT_APPROVAL_WINDOW_S = Number(process.env.FLEET_IMPORT_APPROVAL_WINDOW_S) || 1800

// Card 68254bd7 delta-gate (RedHat NO-GO 14953, MikroB decision 14957): the approval mechanism
// below is NOT a human-enforced gate as it stands -- PATCH /api/approvals/:id has no auth-kind
// check at all, and resolved_by is self-reported, so the SAME shared fleet bearer the kind-check
// above blocks can mint its own "approved" row directly (or via the three routes already named in
// the comment above: bridge-enroll, break-glass password reset, deleting the last user). A hard,
// literal constant on purpose, NOT an environment variable -- an env-driven toggle on a privilege
// gate is exactly the class this fork's own DECISIONS.md already warns about elsewhere (any parent
// process could set it). Flip to false only in a reviewed commit, once card 3fb0ef97 (a
// non-forgeable approval channel) ships.
const FLEET_IMPORT_APPLY_FAIL_CLOSED = true

/**
 * F-A fix (card 657b32f2, RedHat delta-gate 14953): allowRiskyFields was NOT bound into the
 * approval's content_hash, so a caller could get an innocuous allowRiskyFields=false request
 * approved, then resend the IDENTICAL body with allowRiskyFields=true -- same rawBody hash, same
 * approval, but a riskier import than the owner actually saw. Exported pure function so it is
 * independently unit-testable without a live route/DB, even while FLEET_IMPORT_APPLY_FAIL_CLOSED
 * keeps the call site below unreachable.
 */
export function fleetImportContentHash(rawBody: string, allowRiskyFields: boolean): string {
  return createHash('sha256').update(rawBody).update(`\u0000allowRiskyFields=${allowRiskyFields}`).digest('hex')
}

/**
 * F-B fix (card 657b32f2, RedHat delta-gate 14953): the approval description named only the byte
 * count and the flag, so the human approver had no way to tell WHICH surfaces would change.
 * Per-agent/per-field enumeration would need to replicate importFleet's own parsing here -- out of
 * scope for this follow-up -- so this names the surface CLASSES instead, which is static and cheap.
 */
export function fleetImportApprovalDescription(bodyBytes: number, allowRiskyFields: boolean): string {
  const base = `Fleet import apply (${bodyBytes} bytes, allowRiskyFields=${allowRiskyFields}). ` +
    'Approving this authorizes importing verbatim fleet surfaces (CLAUDE.md/SOUL.md, agent skills, ' +
    'scheduled-task prompts, .mcp.json command/args/url) for every agent in the payload.'
  if (!allowRiskyFields) return base
  return `${base} INCLUDING risky fields: toolDeny, securityProfile, capabilities, customProvider, settings.hooks.`
}

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

    // Card 68254bd7 delta (RedHat NO-GO 14953, MikroB decision 14957): hard fail-closed, ahead of
    // EVERY check below (auth kind included) -- "mindig 403, approval-kérést sem nyit". The
    // kind-check and approval-opening code further down stay in place, UPDATED for when this flag
    // is removed (F-A/F-B above), but are intentionally unreachable until then.
    if (apply && FLEET_IMPORT_APPLY_FAIL_CLOSED) {
      logger.warn({ authKind: ctx.auth?.kind ?? 'none' }, 'Fleet import: apply=true hard-refused (fail-closed pending card 3fb0ef97 -- no approval opened)')
      json(res, {
        error: 'Fleet import (apply=true) is disabled until a non-forgeable approval channel ships (card 3fb0ef97). Use apply=false (dry-run) for now.',
      }, 403)
      return true
    }

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

    // Card 68254bd7 (MikroB decision 14841): apply=true additionally requires a human-RESOLVED
    // approval bound to this EXACT payload (content_hash = sha256 of the raw import body, same
    // binding style as EMAILKAPU901's envelope hash). No consumable approval yet -> open one (or
    // reuse an already-pending one for this same hash, so a caller retrying before the owner has
    // acted does not spam a fresh Telegram ping) and refuse the import for THIS call -- the
    // caller must resubmit the identical body after the owner approves, which is exactly the
    // pattern the email gate already trains agents on.
    if (apply) {
      const contentHash = fleetImportContentHash(rawBody, allowRiskyFields)
      const consumable = findConsumableApproval(FLEET_IMPORT_APPROVAL_CATEGORY, contentHash, FLEET_IMPORT_APPROVAL_WINDOW_S)
      const consumed = consumable ? consumeApproval(consumable.id) : false
      if (!consumed) {
        const existingPending = findPendingApproval(FLEET_IMPORT_APPROVAL_CATEGORY, contentHash)
        const approval = existingPending ?? createAndNotifyApproval({
          agent_id: ctx.auth?.kind === 'session' ? (ctx.auth.user ?? 'session') : 'device-key',
          category: FLEET_IMPORT_APPROVAL_CATEGORY,
          action_description: fleetImportApprovalDescription(rawBody.length, allowRiskyFields),
          content_hash: contentHash,
        })
        logger.warn(
          { authKind: ctx.auth?.kind, approvalId: approval.id, contentHash },
          'Fleet import: apply=true refused pending human approval',
        )
        json(res, {
          error: 'Fleet import (apply=true) requires a human-approved request. An approval has been opened; resubmit the identical body once it is approved.',
          approval_id: approval.id,
        }, 403)
        return true
      }
      logger.info({ approvalId: consumable!.id, contentHash }, 'Fleet import: apply=true approval consumed')
    }

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
