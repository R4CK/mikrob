// Card 900178fa: structurally send a bare `/clear` into an agent's own tmux pane when the kanban
// dispatch mechanism switches them from one card to a DIFFERENT one, so context does not
// accumulate across cards (root CLAUDE.md rule 14 -- previously agent-discipline only).
//
// SCOPE (plan-grilled before writing this): wired ONLY into the normal MikroB/auto-dispatch path
// (fireKanbanDispatch's non-self-advance branch). The self-advance path is NOT wired here: by the
// time a self-advance move fires, the agent's PREVIOUS card has already left in_progress (moved to
// waiting+REVIEW before the agent picks up the next one), so "does this agent hold another
// in_progress card" is always false there -- it cannot tell a genuine switch from a same-card
// reopen after a gate FAIL. That needs a different signal (e.g. a persisted last-active-card
// marker) and is deliberately left to a follow-up card rather than guessed at here.
//
// DELIVERY MECHANISM: reuses sendPromptToSession (agent-process.ts), the SAME primitive the
// message-router already uses for every ordinary dispatch message -- not a new raw tmux call.
// `onBusyTimeout: 'abort'` matches how the inbox-nudge watcher treats another OPTIONAL prompt: if
// the pane will not idle, skip rather than risk splicing a bare `/clear` into a busy pane. A missed
// /clear costs a little stale context; a mis-timed one risks corrupting whatever the agent is mid-
// typing -- the asymmetry is deliberate.
import { getInProgressCardsForAssignee } from '../db.js'
import { agentSessionName, sendPromptToSession } from './agent-process.js'
import { readAgentRemoteHost } from './agent-config.js'
import { logger } from '../logger.js'

/**
 * True when dispatching `newCardId` to `assignee` is a genuine card SWITCH -- the assignee
 * currently holds a DIFFERENT in_progress card. False for a first pickup (no other in_progress
 * card) or a re-dispatch of the SAME card (e.g. reopened after a gate FAIL) -- rule 14's own
 * exception: multiple gate-rounds on one card must not /clear.
 */
export function isGenuineCardSwitch(assignee: string, newCardId: string): boolean {
  return getInProgressCardsForAssignee(assignee).some((c) => c.id !== newCardId)
}

/**
 * Fires the /clear if (and only if) this dispatch is a genuine switch. Never throws -- a failure
 * here must not affect the kanban move that triggered it, matching fireKanbanDispatch's own
 * existing "errors never block the card move" contract.
 */
export async function clearBeforeDispatchIfSwitching(assignee: string, newCardId: string): Promise<void> {
  if (!isGenuineCardSwitch(assignee, newCardId)) return
  try {
    const host = readAgentRemoteHost(assignee)
    await sendPromptToSession(agentSessionName(assignee), '/clear', host, { onBusyTimeout: 'abort' })
  } catch (err) {
    logger.warn({ err, assignee, newCardId }, 'kanban-dispatch-clear-guard: /clear send failed (dispatch continues)')
  }
}
