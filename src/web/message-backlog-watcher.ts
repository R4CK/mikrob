// Message-backlog watcher (card 1e7ba5c1).
//
// THE GAP THIS CLOSES. getPendingBacklogByAgent() exists, and db.ts's own comment says why it was
// written: "an 18-row backlog went unseen on 2026-07-27 and got mistaken for data loss". It is
// served at GET /api/messages/backlog. NOTHING CONSUMES IT -- checked across the scheduled tasks,
// the heartbeat and fleet-nudger.sh, whose own "backlog" wording is about KANBAN cards, not
// messages. So the measurement exists and no one is looking at it, which is the same shape as the
// incident it was built for.
//
// Measured while writing this (2026-09-04): backend was holding 27 undelivered messages, the oldest
// 325 minutes, with its session RUNNING. Nothing anywhere said so.
//
// WHY A WATCHER AND NOT A FASTER ROUTER. The delay is not queue congestion: over 623 deliveries in
// 24 hours the global median was 6 seconds, and the latency is entirely recipient-specific (mikrob
// 4s over 312 messages, backend 1979s over 51). message-router.ts holds a message until
// isSessionReadyForPrompt, and its own comment says a session mid-turn is not-ready "for the same
// reason a wedged one is, so the queue side alone cannot tell them apart". An agent legitimately
// working for two hours SHOULD accumulate a queue -- so there is no error to raise, and that is
// exactly why nobody sees it. This watcher does not try to make delivery faster; it makes the
// waiting VISIBLE. Changing the readiness design is a separate card.
import { getPendingBacklogByAgent, createAgentMessage, type AgentBacklog } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'

export const BACKLOG_WATCH_INTERVAL_MS = 5 * 60 * 1000

/** Oldest undelivered message older than this makes an agent worth reporting. */
export const BACKLOG_AGE_ALERT_SECONDS = Number(process.env.MARVEEN_BACKLOG_ALERT_SECONDS) > 0
  ? Number(process.env.MARVEEN_BACKLOG_ALERT_SECONDS)
  : 30 * 60

/** Minimum gap between two alerts about the SAME agent. A standing backlog is a standing fact, not
 *  a repeating event: re-announcing it every tick is how a signal stops being read. */
export const BACKLOG_ALERT_COOLDOWN_MS = 60 * 60 * 1000

export interface BacklogAlert {
  readonly agent: string
  readonly pending: number
  readonly oldestAgeSeconds: number
}

/**
 * Pure decision: which agents are worth reporting on this tick?
 *
 * Kept separate from the tick so the policy is unit-testable without a database or a clock -- the
 * same split the other watchers in this directory use.
 *
 * @param rows          backlog snapshot (as getPendingBacklogByAgent returns it)
 * @param lastAlertAt   agent -> last alert time (ms); mutated by the caller, read-only here
 * @param nowMs         current clock
 */
export function backlogAlerts(
  rows: readonly AgentBacklog[],
  lastAlertAt: ReadonlyMap<string, number>,
  nowMs: number,
  ageThresholdSeconds: number = BACKLOG_AGE_ALERT_SECONDS,
  cooldownMs: number = BACKLOG_ALERT_COOLDOWN_MS,
): BacklogAlert[] {
  const out: BacklogAlert[] = []
  for (const r of rows) {
    if (r.oldestAgeSeconds < ageThresholdSeconds) continue
    const last = lastAlertAt.get(r.agent)
    if (last !== undefined && nowMs - last < cooldownMs) continue
    out.push({ agent: r.agent, pending: r.pending, oldestAgeSeconds: r.oldestAgeSeconds })
  }
  return out
}

/** Human-facing line for one alert. Numbers only -- nothing here is agent-controlled text. */
export function formatBacklogAlert(a: BacklogAlert): string {
  const mins = Math.round(a.oldestAgeSeconds / 60)
  return (
    `[uzenet-backlog] A(z) ${a.agent} ugynoknek ${a.pending} kezbesitetlen uzenete all, ` +
    `a legregebbi ${mins} perce. A router addig var, amig a cel-session kesz fogadni -- ` +
    `egy hosszan dolgozo ugynoknel ez NORMALIS, egy beragadtnal viszont nem, es a sor felol ` +
    `a ketto megkulonboztethetetlen. Nezd meg a panelt: ha dolgozik, hagyd; ha all, inditsd ujra.`
  )
}

const lastAlertAt = new Map<string, number>()

/** One tick. Exported for the test; the interval below is what production runs. */
export function sweepMessageBacklog(nowMs: number = Date.now()): BacklogAlert[] {
  let rows: AgentBacklog[]
  try {
    rows = getPendingBacklogByAgent()
  } catch (err) {
    logger.warn({ err }, 'message-backlog watch: could not read the backlog')
    return []
  }
  const alerts = backlogAlerts(rows, lastAlertAt, nowMs)
  for (const a of alerts) {
    lastAlertAt.set(a.agent, nowMs)
    // Logged ALWAYS, and sent second. The inbox notice is the useful half, but it is also the half
    // that can fail -- and an alert about undelivered messages that is itself an undelivered message
    // would be a control that disappears exactly when it matters. The log line is the one that
    // cannot queue behind anything.
    logger.warn({ agent: a.agent, pending: a.pending, oldestAgeSeconds: a.oldestAgeSeconds },
      'message-backlog watch: an agent has been holding undelivered messages')
    try {
      createAgentMessage('system', MAIN_AGENT_ID, formatBacklogAlert(a))
    } catch (err) {
      logger.warn({ err, agent: a.agent }, 'message-backlog watch: inbox notice failed')
    }
  }
  return alerts
}

export function startMessageBacklogWatcher(): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      sweepMessageBacklog()
    } catch (err) {
      logger.warn({ err }, 'message-backlog watch tick failed')
    }
  }, BACKLOG_WATCH_INTERVAL_MS)
  timer.unref?.()
  return timer
}
