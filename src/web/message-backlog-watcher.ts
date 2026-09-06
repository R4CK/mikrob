// Message-backlog watcher (card 1e7ba5c1).
//
// WHAT THIS IS, AND WHAT IT IS NOT. Round 1 of this card claimed "the backlog endpoint exists and
// NOTHING watches it". Cybered refuted that with measurement and was right: message-router.ts already
// emits `[session-stuck]` into the same inbox -- 174 times in 7 days -- and it carries strictly MORE
// than this file can, because it reads the PANE and so can say busy-vs-idle where the queue alone
// cannot. Round 1's own REVIEW quoted the router's comment as ending at "the queue side alone cannot
// tell them apart"; the line actually continues "; the pane can", and the emitter sits ~100 lines
// above it. The search that missed it covered the scheduled tasks, the heartbeat and fleet-nudger.sh
// -- not the in-process watchers, which is where the consumer actually lives.
//
// THE RESIDUAL GAP THAT REMAINS REAL (MikroB's scoping decision, msg 22523). The router's
// `agentStuckSince` map lives in MEMORY, so a dashboard restart zeroes it; the messages'
// `created_at` does not. A backlog that predates a restart can therefore fall out of `[session-stuck]`
// entirely -- nobody re-arms the clock for a queue that was already old. That is this watcher's whole
// job, so it is deliberately a SUPPLEMENT: it stays quiet for any agent the router has alerted on
// recently (STUCK_DEDUP_WINDOW_MS) and speaks only where that alert has been silent. A second alert
// saying less than the first, into an inbox already 32% machine traffic, would only teach people to
// skip both.
import {
  getPendingBacklogByAgent,
  recentStuckAlertContents,
  createAgentMessage,
  type AgentBacklog,
} from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { isAgentRunning } from './agent-process.js'
import { logger } from '../logger.js'

export const BACKLOG_WATCH_INTERVAL_MS = 5 * 60 * 1000

/** Oldest undelivered message older than this makes an agent worth reporting. */
export const BACKLOG_AGE_ALERT_SECONDS = Number(process.env.MARVEEN_BACKLOG_ALERT_SECONDS) > 0
  ? Number(process.env.MARVEEN_BACKLOG_ALERT_SECONDS)
  : 30 * 60

/** Minimum gap between two alerts about the SAME agent.
 *
 *  Round 1's comment here claimed a standing backlog is "a fact, not a repeating event" while the
 *  code re-announced it every hour -- the comment argued for behaviour the code did not have
 *  (Cybered F6). Stated honestly: this is a RATE LIMIT, not a one-shot. A standing backlog does get
 *  re-announced, deliberately, because it is still true and the first notice may have been missed in
 *  a busy inbox; what bounds the volume is this window plus the `[session-stuck]` dedup above, not a
 *  claim that we only speak once. */
export const BACKLOG_ALERT_COOLDOWN_MS = 60 * 60 * 1000

/** How far back a router `[session-stuck]` alert about an agent keeps this watcher quiet. */
export const STUCK_DEDUP_WINDOW_MS = 60 * 60 * 1000

export interface BacklogAlert {
  readonly agent: string
  readonly pending: number
  readonly oldestAgeSeconds: number
  /** Whether the agent has a live tmux session. Decides the ADVICE: a parked agent has no pane to
   *  look at, so telling the reader to check one sends them somewhere that does not exist. */
  readonly sessionAlive: boolean
  /** Card 2fa2ce04 item 1: the main agent's OWN backlog is never SENT (F2 -- delivering the notice
   *  would enqueue into the very queue it describes), but that used to mean nobody was told at all.
   *  A `logOnly` alert is still logged (so a human or monitoring tool reading logs sees it) and still
   *  starts the cooldown, it just never reaches `deps.send`. Absent/false for every other agent. */
  readonly logOnly?: boolean
}

export interface BacklogPolicyOptions {
  readonly nowMs: number
  readonly lastAlertAt: ReadonlyMap<string, number>
  /** Agents the router has alerted on recently -- this watcher defers to it (F1). */
  readonly alreadyAlerted?: ReadonlySet<string>
  readonly isSessionAlive?: (agent: string) => boolean
  readonly mainAgentId?: string
  readonly ageThresholdSeconds?: number
  readonly cooldownMs?: number
}

/** Pull the agent name out of the router's own alert text.
 *
 *  Coupled to formatStuckSessionAlert's wording on purpose. The test does NOT re-type that wording:
 *  it feeds this the REAL formatter's output, so a reworded alert fails the test instead of silently
 *  disabling the dedup and doubling the traffic. */
const STUCK_AGENT_RE = /^\[session-stuck\] Agent '([^']+)'/

export function agentsAlreadyAlerted(contents: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const c of contents) {
    const m = STUCK_AGENT_RE.exec(c)
    if (m?.[1]) out.add(m[1])
  }
  return out
}

/**
 * Pure decision: which agents are worth reporting on this tick?
 *
 * Kept separate from the tick so the policy is unit-testable without a database or a clock.
 */
export function backlogAlerts(rows: readonly AgentBacklog[], opts: BacklogPolicyOptions): BacklogAlert[] {
  const {
    nowMs,
    lastAlertAt,
    alreadyAlerted,
    isSessionAlive,
    mainAgentId = MAIN_AGENT_ID,
    ageThresholdSeconds = BACKLOG_AGE_ALERT_SECONDS,
    cooldownMs = BACKLOG_ALERT_COOLDOWN_MS,
  } = opts

  const out: BacklogAlert[] = []
  for (const r of rows) {
    if (r.oldestAgeSeconds < ageThresholdSeconds) continue
    const last = lastAlertAt.get(r.agent)
    if (last !== undefined && nowMs - last < cooldownMs) continue

    // F2 (blocker), residual closed by card 2fa2ce04 item 1. The alert is DELIVERED to the main
    // agent, so SENDING about the main agent puts the notice into the very queue it is describing --
    // the watcher would then measure its own output. Replayed over 7 real days, 11 of 57 alerts were
    // exactly this, and by the eighth hourly repeat 7 of the 11 pending rows would have been the
    // watcher's own. That reasoning rules out SENDING, not OBSERVING: before this card nothing
    // watched the main agent's own backlog at all (neither this file nor the router's [session-stuck],
    // which addresses its alerts TO the main agent and so has the identical F2 problem for the
    // reverse direction) -- a real case measured 4 messages sitting unnoticed for 453 minutes. The
    // router's own [session-stuck] dedup (F1, below) does not apply here either: that mechanism
    // answers "did the router already describe THIS agent as stuck", which is not the question for
    // the main agent, so it is deliberately skipped for this branch.
    if (r.agent === mainAgentId) {
      out.push({
        agent: r.agent,
        pending: r.pending,
        oldestAgeSeconds: r.oldestAgeSeconds,
        sessionAlive: isSessionAlive ? isSessionAlive(r.agent) : true,
        logOnly: true,
      })
      continue
    }
    // F1. The router already said it, with pane state attached. Nothing to add.
    if (alreadyAlerted?.has(r.agent)) continue
    out.push({
      agent: r.agent,
      pending: r.pending,
      oldestAgeSeconds: r.oldestAgeSeconds,
      sessionAlive: isSessionAlive ? isSessionAlive(r.agent) : true,
    })
  }
  return out
}

/** Human-facing line for one alert. Numbers and the agent id only -- the backlog holds other agents'
 *  message bodies, and quoting them would put arbitrary agent-controlled text into the main agent's
 *  trusted framing. */
export function formatBacklogAlert(a: BacklogAlert): string {
  const mins = Math.round(a.oldestAgeSeconds / 60)
  const head =
    `[uzenet-backlog] A(z) ${a.agent} ugynoknek ${a.pending} kezbesitetlen uzenete all, ` +
    `a legregebbi ${mins} perce, es a routertol NEM ment rola [session-stuck] riasztas ` +
    `az elmult oraban -- tipikusan egy dashboard-ujraindtast tulelt regi sor.`
  // F4: a parked agent has no pane. Sending the reader to look at one wastes the trip and makes the
  // alert read as wrong. The router already treats this as a separate branch at its own call site.
  return a.sessionAlive
    ? `${head} A session EL: nezd meg a panelt -- ha dolgozik, hagyd; ha all, inditsd ujra.`
    : `${head} A session PARKOLT (nincs panel): vagy inditsd el az ugynokot es hagyd lefutni a sort, ` +
      `vagy zard le a mar ertelmetlen sorokat -- kulonben a router a hataridonel eldobja oket.`
}

const lastAlertAt = new Map<string, number>()

/** Card 2fa2ce04 item 2: when THIS process started. `recentStuckAlertContents` reads `agent_messages`
 *  by `created_at`, which SURVIVES a dashboard restart -- unlike the router's own `agentStuckSince`
 *  map (memory, zeroed on restart). Without a floor at process start, a `[session-stuck]` row written
 *  by the PREVIOUS process minutes before it died can still fall inside STUCK_DEDUP_WINDOW_MS after
 *  the new process comes up, so this watcher reads "the router already covered it" for an agent the
 *  new router has not evaluated even once yet -- and the router itself needs a fresh escalation
 *  window before it would speak again. Two emitters, both silent, for up to STUCK_DEDUP_WINDOW_MS:
 *  exactly the restart-spanning gap this watcher exists to close, reopened by its own dedup. */
const PROCESS_STARTED_AT_MS = Date.now()

export interface BacklogSweepDeps {
  readonly now: () => number
  readonly listBacklog: () => AgentBacklog[]
  readonly recentStuckAlerts: (sinceEpochSeconds: number) => string[]
  readonly isSessionAlive: (agent: string) => boolean
  readonly send: (to: string, text: string) => void
  readonly warn: (obj: Record<string, unknown>, msg: string) => void
  readonly mainAgentId: string
  /** Defaults to this module's own load time (= process start, for all practical purposes -- this
   *  file is loaded once at boot). Overridable so a test can simulate "process started N ms ago"
   *  without actually spawning a new process. */
  readonly processStartedAtMs?: number
}

const productionDeps: BacklogSweepDeps = {
  now: () => Date.now(),
  listBacklog: getPendingBacklogByAgent,
  recentStuckAlerts: recentStuckAlertContents,
  isSessionAlive: isAgentRunning,
  send: (to, text) => { createAgentMessage('system', to, text) },
  warn: (obj, msg) => { logger.warn(obj, msg) },
  mainAgentId: MAIN_AGENT_ID,
  processStartedAtMs: PROCESS_STARTED_AT_MS,
}

/** One tick. Exported with an injectable dep set so the ordering, the failure branches and the
 *  main-agent refusal are testable -- round 1 left all of that unpinned (Cybered F5). */
export function sweepMessageBacklog(deps: BacklogSweepDeps = productionDeps): BacklogAlert[] {
  const nowMs = deps.now()

  let rows: AgentBacklog[]
  try {
    rows = deps.listBacklog()
  } catch (err) {
    deps.warn({ err }, 'message-backlog watch: could not read the backlog')
    return []
  }

  // Failing OPEN here is deliberate: if we cannot tell whether the router already alerted, the worst
  // case is one duplicate notice, whereas failing closed would silence the only alert that covers the
  // restart-spanning gap this watcher exists for.
  let alreadyAlerted = new Set<string>()
  try {
    // Item 2: floored at THIS process's start, so a [session-stuck] row from a process that already
    // died cannot suppress this one's first evaluation of an agent. See PROCESS_STARTED_AT_MS above.
    const windowStartMs = Math.max(nowMs - STUCK_DEDUP_WINDOW_MS, deps.processStartedAtMs ?? 0)
    const since = Math.floor(windowStartMs / 1000)
    alreadyAlerted = agentsAlreadyAlerted(deps.recentStuckAlerts(since))
  } catch (err) {
    deps.warn({ err }, 'message-backlog watch: could not read recent session-stuck alerts; not deduping this tick')
  }

  const alerts = backlogAlerts(rows, {
    nowMs,
    lastAlertAt,
    alreadyAlerted,
    isSessionAlive: (a) => { try { return deps.isSessionAlive(a) } catch { return true } },
    mainAgentId: deps.mainAgentId,
  })

  const sent: BacklogAlert[] = []
  for (const a of alerts) {
    // Logged ALWAYS, and FIRST. The inbox notice is the useful half but also the half that can fail,
    // and an alert about undelivered messages that is itself an undelivered message would vanish
    // exactly when it matters. The log line cannot queue behind anything.
    deps.warn(
      { agent: a.agent, pending: a.pending, oldestAgeSeconds: a.oldestAgeSeconds, sessionAlive: a.sessionAlive },
      'message-backlog watch: an agent has been holding undelivered messages',
    )
    // Item 1: the main agent's own backlog is logged, never sent (F2) -- the cooldown still starts,
    // so the log itself does not repeat every 5-minute tick for a backlog that has not changed.
    if (a.logOnly) {
      lastAlertAt.set(a.agent, nowMs)
      sent.push(a)
      continue
    }
    try {
      deps.send(deps.mainAgentId, formatBacklogAlert(a))
    } catch (err) {
      // F3: do NOT start the cooldown on a failed send. A write that fails because the database is
      // locked or full is exactly the state in which a queue backs up -- burning the hour there would
      // lose the alert and mute the agent until the next window.
      deps.warn({ err, agent: a.agent }, 'message-backlog watch: inbox notice failed; cooldown NOT started')
      continue
    }
    lastAlertAt.set(a.agent, nowMs)
    sent.push(a)
  }
  return sent
}

/** Test seam: the module-level cooldown map is process state, so a test that drives two ticks needs
 *  to be able to start from a known point. */
export function resetBacklogCooldownsForTest(): void {
  lastAlertAt.clear()
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
