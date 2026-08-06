// GET /api/public-digest -- a DELIBERATELY MINIMAL, UNAUTH, read-only fleet health digest
// (card 5a57ba16 / F2, parent 99d42bb6). The rest of /api/* is Bearer-gated precisely so a
// LAN/public-exposed instance does not leak fleet TOPOLOGY (web.ts). This endpoint is the ONE
// intentional public read, so it exposes ONLY non-identifying AGGREGATE status:
//   - agent COUNTS (running / total) -- never names, ids, roles, or reports-to structure;
//   - the product version (already public in package.json / the landing chrome);
//   - a timestamp.
// It NEVER returns agent names/ids, filesystem paths, tokens/secrets, PII, memory or kanban
// content, channel identities, or any per-agent detail. A count is not topology. Fail-closed:
// any error yields a minimal { ok: false } with nothing else.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, BOT_NAME } from '../../config.js'
import { listAgentNames } from '../agent-config.js'
import { isAgentRunning } from '../agent-process.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

let cachedVersion: string | null = null
function readVersion(): string {
  if (cachedVersion !== null) return cachedVersion
  try {
    const p = join(PROJECT_ROOT, 'package.json')
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, 'utf-8')) as { version?: unknown }
      cachedVersion = typeof pkg.version === 'string' ? pkg.version : ''
    } else {
      cachedVersion = ''
    }
  } catch {
    cachedVersion = ''
  }
  return cachedVersion
}

export interface PublicDigest {
  readonly ok: true
  /** COUNTS ONLY -- never names/ids (no topology leak). */
  readonly agents: { readonly running: number; readonly total: number }
  /** The product/system display name (already public chrome). */
  readonly name: string
  /** Product version (already public in package.json). */
  readonly version: string
  readonly checkedAt: number
}

/**
 * Build the safe public digest. Pure of HTTP; returns ONLY the whitelisted non-sensitive
 * aggregate fields, so a test can assert no identifying data can leak. `now` is injected.
 */
export function buildPublicDigest(now: number): PublicDigest {
  const agents = listAgentNames()
  // +1 accounts for the main agent, which is not in listAgentNames().
  const running = agents.filter((n) => isAgentRunning(n)).length + 1
  const total = agents.length + 1
  return {
    ok: true,
    agents: { running, total },
    name: BOT_NAME,
    version: readVersion(),
    checkedAt: now,
  }
}

/**
 * GET /api/public-digest (UNAUTH). See the module header for the trust-boundary contract. Fail-closed:
 * any error yields a minimal { ok: false }, never a partial leak.
 */
export async function tryHandlePublicDigest(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path !== '/api/public-digest' || method !== 'GET') return false
  try {
    json(res, buildPublicDigest(Date.now()))
  } catch {
    json(res, { ok: false })
  }
  return true
}
