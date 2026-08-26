// Self-advance-clear watcher (card 5003f37e, the self-advance half of 900178fa).
//
// The auto-dispatch path (kanban-dispatch-clear-guard.ts) /clears an agent's pane BEFORE
// delivering a new task message, checked live: the caller (MikroB/the API) and the target (the
// dispatched agent) are different processes, so the target's pane really can be idle at that
// moment. Self-advance has no such gap -- the agent that just moved its OWN card to in_progress IS
// the pane in question, and it is, by construction, busy right then (it just issued the API call
// that led here). A synchronous idle-wait inside that same request would almost always time out and
// silently never send anything (see the schema comment on agent_pending_clear in db.ts).
//
// So fireKanbanDispatch's self-advance branch only RECORDS the debt (setPendingSelfAdvanceClear).
// This watcher is the independent process that can actually observe the agent idle: it runs on its
// own interval, and for every agent with an outstanding debt, sends `/clear` the moment that
// agent's pane is genuinely idle -- the SAME live-idle-check + onBusyTimeout:'abort' fail-safe the
// auto-dispatch path already uses, from a vantage point where the check can be true.
//
// A missed tick just leaves the debt outstanding for the next one (or forever, if the agent never
// idles) -- the same accepted risk the inbox-nudge watcher takes for an optional prompt: a skipped
// /clear costs stale context, never a lost task.
import { getPendingSelfAdvanceClears, clearPendingSelfAdvanceClear } from '../db.js'
import { agentSessionName, isSessionReadyForPrompt, sendPromptToSession, sessionExistsOnHost } from './agent-process.js'
import { readAgentRemoteHost } from './agent-config.js'
import { logger } from '../logger.js'

export const SELF_ADVANCE_CLEAR_INTERVAL_MS = 20_000

async function deliverOne(pending: { agent_id: string; card_id: string }): Promise<void> {
  const { agent_id: agentId, card_id: cardId } = pending
  const host = readAgentRemoteHost(agentId)
  const session = agentSessionName(agentId)
  if (!sessionExistsOnHost(host, session)) return
  if (!(await isSessionReadyForPrompt(session, host))) return
  let result: 'sent' | 'aborted-busy' | 'skipped-locked'
  try {
    result = await sendPromptToSession(session, '/clear', host, { onBusyTimeout: 'abort' })
  } catch (err) {
    logger.warn({ err, agentId, cardId }, 'self-advance-clear-watcher: /clear send threw')
    return
  }
  if (result !== 'sent') return
  // Conditional on cardId: a newer genuine switch may have overwritten the debt between the read
  // above and this delete, in which case that newer debt must survive this delivery.
  clearPendingSelfAdvanceClear(agentId, cardId)
  logger.info({ agentId, cardId }, 'self-advance-clear-watcher: /clear delivered on genuine self-advance switch')
}

async function tick(): Promise<void> {
  // Fenced like inbox-nudge-watcher's tick: this is a setInterval callback (fired via a void
  // wrapper), and an escaped rejection would otherwise reach the uncaughtException handler.
  try {
    const pending = getPendingSelfAdvanceClears()
    for (const p of pending) {
      await deliverOne(p)
    }
  } catch (err) {
    logger.warn({ err }, 'self-advance-clear-watcher: tick error')
  }
}

export function startSelfAdvanceClearWatcher(): NodeJS.Timeout {
  return setInterval(() => { void tick() }, SELF_ADVANCE_CLEAR_INTERVAL_MS)
}
