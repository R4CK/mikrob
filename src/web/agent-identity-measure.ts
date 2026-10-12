// Card 2520b85a (plan step 6: "mérés -- hány hívás jön még legacy tokennel"). This is the
// MEASUREMENT-ONLY slice of a larger per-agent-identity plan; see the plan-grilling comment on
// the card for the full breakdown. ENFORCEMENT (rejecting or rewriting a mismatched claim) is
// explicitly deferred to a future, separately-decided card: kanban.ts already carries a pinned
// trust-boundary decision (card 1cdac111, src/__tests__/kanban-comment-author-trust-boundary.test.ts)
// that a comment `author` is an unverified CLAIM, on purpose -- this module must never silently
// turn that into an enforced identity.
//
// Pure addition: every call here only emits a log line. It never throws, never blocks, never
// changes a response. Flag default is ON because it is observability, not behavior change --
// AGENT_IDENTITY_MEASURE=off reverts to zero added code path.

import { logger } from '../logger.js'
import { agentKeyToAgentId } from './auth-device-keys.js'
import type { RouteContext } from './routes/types.js'

export function isAgentIdentityMeasureEnabled(): boolean {
  return process.env.AGENT_IDENTITY_MEASURE !== 'off'
}

// L2 (WhiteHat2 16476): an unbounded claimed value in a log line is itself a cost (a 2MB claim
// becomes a 2MB log line) and the legacy-token line previously omitted it entirely, so the
// measurement could not say WHO still uses the shared token. Truncated here, in the one place
// every call site funnels through, rather than at each caller.
const CLAIMED_LOG_MAX_CHARS = 64

function truncateClaimed(claimed: string): string {
  return claimed.length > CLAIMED_LOG_MAX_CHARS ? `${claimed.slice(0, CLAIMED_LOG_MAX_CHARS)}…` : claimed
}

/** `claimedValue` is whatever the request body put in the author/actor/from field for this
 *  endpoint -- may be absent, non-string, or empty; all are treated as "nothing to compare". */
export function measureAgentIdentityClaim(ctx: RouteContext, endpoint: string, claimedValue: unknown): void {
  if (!isAgentIdentityMeasureEnabled()) return
  try {
    const auth = ctx.auth
    if (!auth) return
    // Comparison (below) runs on the untruncated value so a pathologically long claim can never
    // produce a false match/mismatch; only the LOGGED copy is bounded.
    const claimed = typeof claimedValue === 'string' ? claimedValue.trim() : ''
    const loggedClaim = truncateClaimed(claimed)
    if (auth.kind === 'token') {
      if (claimed) {
        logger.info({ endpoint, authKind: 'legacy-token', claimed: loggedClaim }, 'agent-identity-measure: legacy shared dashboard token')
      } else {
        logger.info({ endpoint, authKind: 'legacy-token' }, 'agent-identity-measure: legacy shared dashboard token')
      }
      return
    }
    if (auth.kind !== 'device') return
    const agentId = agentKeyToAgentId(auth.device)
    if (!agentId) return // a non-agent device key (phone/Bridge) is out of scope for this measurement
    if (!claimed) {
      logger.info({ endpoint, authKind: 'agent-key', agentId }, 'agent-identity-measure: per-agent key, no claim to compare')
      return
    }
    if (claimed.toLowerCase() !== agentId.toLowerCase()) {
      logger.warn({ endpoint, authKind: 'agent-key', agentId, claimed: loggedClaim }, 'agent-identity-measure: claim mismatches authenticated agent key')
      return
    }
    logger.info({ endpoint, authKind: 'agent-key', agentId }, 'agent-identity-measure: per-agent key, claim matches')
  } catch (err) {
    logger.warn({ err }, 'agent-identity-measure: measurement itself failed, ignored (fail-open, never blocks the request)')
  }
}
