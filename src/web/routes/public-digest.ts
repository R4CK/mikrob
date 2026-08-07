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
/** Exported for routes/version.ts (card 1bf4f8a4) -- the sidebar's real-semver need is the same
 *  "read package.json's version, once, cheaply" as this digest's, so it reuses this rather than a
 *  second copy of the same read+cache. */
export function readVersion(): string {
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
 * TTL for the agent-count scan (card 5d8612b6).
 *
 * isAgentRunning() spawns a SYNCHRONOUS tmux subprocess per agent, on the Node event loop.
 * Uncached, one unauth request costs N spawns (~80ms blocking at N=15), so ~11 req/s stalls
 * the whole dashboard -- and the fleet runs on this same API. Remote agents are worse: their
 * captureTmux goes over SSH with an 8s timeout, so a single unreachable host can block the
 * loop for seconds. Fleet health does not change by the millisecond, so a short TTL removes
 * the entire amplification (N spawns per TTL window, not per request) with no staleness that
 * matters for a health digest.
 */
const AGENT_COUNT_TTL_MS = 10_000

let agentCountCache: { running: number; total: number; expiresAt: number } | null = null

/** Cached agent counts. `now` is the injected clock, so the TTL is testable without fake timers. */
function agentCounts(now: number): { running: number; total: number } {
  const cached = agentCountCache
  if (cached !== null && now < cached.expiresAt) {
    return { running: cached.running, total: cached.total }
  }
  const agents = listAgentNames()
  // +1 accounts for the main agent, which is not in listAgentNames().
  const running = agents.filter((n) => isAgentRunning(n)).length + 1
  const total = agents.length + 1
  agentCountCache = { running, total, expiresAt: now + AGENT_COUNT_TTL_MS }
  return { running, total }
}

/**
 * Build the safe public digest. Pure of HTTP; returns ONLY the whitelisted non-sensitive
 * aggregate fields, so a test can assert no identifying data can leak. `now` is injected.
 */
export function buildPublicDigest(now: number): PublicDigest {
  return {
    ok: true,
    agents: agentCounts(now),
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
