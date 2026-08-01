// Pure decision logic for the kanban -> agent dispatch (option D).
//
// When a kanban card is moved to `in_progress`, the dashboard wakes the
// assigned agent by enqueuing an inter-agent message (createAgentMessage ->
// the existing message-router, which gives us retry / dedup / trust-wrapping /
// busy-receiver handling for free). This module decides WHO, if anyone, should
// be woken. Kept pure so the decision tree is unit-tested without tmux/db.
//
// Rules (mirroring the assignee semantics from PR #251):
//   - empty / unknown assignee        -> null  (no dispatch)
//   - the human owner (OWNER_NAME)     -> null  (humans never get a prompt)
//   - the bot / main agent             -> MAIN_AGENT_ID (main channels session)
//   - a sub-agent, ONLY if its session is running -> that agent's id
//     (a non-running sub-agent is a silent no-op; the card just stays in
//      in_progress rather than queuing a message for a session that isn't up)

export interface DispatchResolveOpts {
  ownerName: string
  botName: string
  mainAgentId: string
  agentNames: string[]
  isRunning: (name: string) => boolean
}

export function resolveKanbanDispatchTarget(
  assignee: string | null | undefined,
  opts: DispatchResolveOpts,
): string | null {
  const a = (assignee ?? '').trim()
  if (!a) return null
  const lower = a.toLowerCase()

  // Human owner never triggers an agent.
  if (a === opts.ownerName) return null

  // Bot / main agent (matched by display name or canonical id) -> main session.
  if (lower === opts.botName.toLowerCase() || lower === opts.mainAgentId.toLowerCase()) {
    return opts.mainAgentId
  }

  // Sub-agent: case-insensitive name match, dispatched only if it is running.
  const match = opts.agentNames.find((n) => n.toLowerCase() === lower)
  if (match && opts.isRunning(match)) return match

  return null
}

/**
 * True when the agent that moved a card to `in_progress` IS its own assignee -- i.e. a self-advance
 * (rule 11: an agent taking its next card without waiting for MikroB), not a fresh dispatch.
 *
 * In that case the kanban->agent dispatch message is a DELAYED ECHO of the agent's own decision: it
 * queues while the agent works, and is delivered once the card is already waiting+REVIEW, where it
 * reads as a phantom re-dispatch. Backend diagnosed exactly this with second-matching DB evidence
 * (card 7a033f8d), and it is the root of the "STALE DISPATCH" noise every self-advancing agent saw.
 *
 * FAIL-SAFE: an empty/unknown actor (a move with no recorded actor) returns false, so the normal
 * dispatch still fires -- suppression only ever triggers on an explicit actor==assignee match.
 */
export function isSelfAdvanceMove(
  assignee: string | null | undefined,
  actor: string | null | undefined,
): boolean {
  const a = (assignee ?? '').trim().toLowerCase()
  const b = (actor ?? '').trim().toLowerCase()
  return a !== '' && b !== '' && a === b
}
