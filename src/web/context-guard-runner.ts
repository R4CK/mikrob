import { statSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { hardRestartMarveenChannels, lastMainRespawnAt, MARVEEN_POST_RESPAWN_GRACE_MS, markAgentRestartPending } from './channel-monitor.js'
import { shouldDeferForRecentRespawn } from './stuck-tool-call-watcher.js'
import { listAgentNames, listAllAgentNames, agentConfigRoot, readAgentModel, readAgentRemoteHost, readAgentWorksourceChannel } from './agent-config.js'
import { resolveAgentConfigDirForRead } from './claude-plans.js'
import { mainAgentConfigDir } from './main-transcript-root.js'
import {
  agentRunState,
  agentSessionName,
  restartAgentProcess,
  capturePane,
  isSessionReadyForPrompt,
  noteSaturationBannerUntrusted,
  clearSaturationBannerOverride,
} from './agent-process.js'
import { sendSystemDirective } from './system-directive.js'
import { notifyChannel } from '../notify.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { detectPaneState, paneShowsContextSaturation, paneShowsContextSaturationHardError } from '../pane-state.js'
import { readContextTokensFromProjectDir, readActiveModelFromProjectDir, readTranscriptMtimeFromProjectDir, readTranscriptTailFromProjectDir } from './active-model.js'
import { readContextGuardConfig } from './context-guard-store.js'
import { setDeliveryHoldProbe, type DeliveryHold } from './delivery-hold.js'
import {
  readPendingResumes,
  writePendingResumes,
  restorableResumeStates,
  PENDING_RESUME_TTL_MS,
  type PendingResume,
  type PendingResumeMap,
} from './context-guard-resume-store.js'
import { localMidnightMs } from '../auto-restart.js'
import { ownerQuestionHolds } from './open-question.js'
import { recordRescueFailure, clearRescueFailures } from './rescue-failure-tracker.js'
import { createAgentMessage, countRestartQueueState, getInProgressCardIdForAgent, getKanbanCard } from '../db.js'
import { sweepAgentDirTripwire } from './agent-dir-tripwire.js'
import {
  decideGuard,
  contextLimitForModel,
  calibrateLimit,
  handoffStaleMinutes,
  applyDailyHandoffSkipSweep,
  forgetNewCardDispatchRecord,
  newCardDispatchDue,
  DAILY_HANDOFF_REASON_PREFIX,
  NEW_CARD_DISPATCH_REASON_PREFIX,
  HANDOFF_RESEND_REASON_PREFIX,
  IDLE_FLUSH_REASON_PREFIX,
  INITIAL_GUARD_STATE,
  READY_TIMEOUT_MS,
  RESUME_GIVE_UP_REASON,
  BUSY_OVERDUE_REASON_PREFIX,
  STALE_REFRESH_REASON_PREFIX,
  SATURATION_CREDIBLE_MIN_PCT,
  saturationBannerCredible,
  usageLimitEvidenceFromTranscript,
  usageLimitVerdict,
  USAGE_LIMIT_MAX_PARK_MS,
  buildRestartLogEntry,
  type GuardState,
  type HandoffStaleness,
  type GuardInputs,
} from '../context-guard.js'
import { whileNotFrozen } from './fleet-freeze.js'

// Fleet context guard (kanban #81): acts BEFORE a session drowns in its own
// context. Sweep every agent (main included) every five minutes; at actPct ask the
// agent to write HANDOFF.md, then fresh-restart it and inject a resume prompt
// pointing at the handoff. The always-on saturation net additionally rescues a
// pane already showing "100% context used" -- unreachable by prompt dispatch,
// so nothing else can recover it (samu stall, 2026-07-18). See
// src/context-guard.ts for the why and the pure state machine; this module is
// only the I/O, mirroring auto-restart-runner.
//
// Remote-host agents are skipped: their transcripts live on the remote machine,
// so the context size cannot be measured here (v1 limitation, logged once).

const INITIAL_DELAY_MS = 270_000
const INTERVAL_MS = 300_000

// How long the dispatch gate honours one sweep's "this banner is not
// credible" verdict. Expressed in SWEEPS, not minutes, so it cannot silently
// drift under the refresh rate if INTERVAL_MS ever changes: the entry has to
// outlive one missed or slow sweep, AND it has to lapse on its own if this
// runner stops (webOnly mode, guard disabled, crash) so the gate falls back to
// today's "refuse and wait for the rescue" rather than staying open.
const SATURATION_OVERRIDE_TTL_MS = 3 * INTERVAL_MS

// agent name -> guard state. In-memory: a dashboard restart re-arms every
// agent at 'idle', which is safe -- the worst case is a repeated handoff
// request, and cooldown prevents restart loops within a run.
//
// ONE exception: 'await-ready' is NOT safe to lose. It is the
// only record that a fresh session is still owed its resume prompt, and
// nothing else will ever send it -- the agent just sits at an empty prompt.
// That obligation is mirrored to store/context-guard-pending-resume.json
// (context-guard-resume-store.ts) and re-armed by restorePendingResumes() when
// the runner starts.
const guardStates = new Map<string, GuardState>()

// Agents with a resume send in flight, for contextGuardDeliveryHold below (delivery-hold.ts):
// the one stretch between the sweep's own inject-resume send and its outcome that no guard
// phase covers, so the router must not deliver a message into it. Set/cleared only around the
// sweep's own send (this fork has no separate immediate-delivery loop, unlike upstream's
// resumeLoops/resumeTargetRunning -- not ported here, out of scope for this round).
const resumeSending = new Set<string>()

// Write-through mirror of the persisted resume obligations. Held in memory so
// the per-sweep "drop if present" checks cost no I/O; the file is written only
// when an entry is actually added or removed.
let pendingResumes: PendingResumeMap = {}

function persistPendingResumes(): void {
  try { writePendingResumes(pendingResumes) }
  catch (err) { logger.warn({ err }, 'context-guard: pending-resume persist failed') }
}

function recordPendingResume(name: string, entry: PendingResume): void {
  pendingResumes = { ...pendingResumes, [name]: entry }
  persistPendingResumes()
}

function dropPendingResume(name: string, why: string): void {
  if (!(name in pendingResumes)) return
  const rest = { ...pendingResumes }
  delete rest[name]
  pendingResumes = rest
  persistPendingResumes()
  logger.info({ name, why }, 'context-guard: pending resume cleared')
}

/**
 * Re-arm every resume obligation a previous dashboard process left behind.
 * Live entries (younger than PENDING_RESUME_TTL_MS) put the agent back in
 * 'await-ready', so the first sweep delivers the resume prompt exactly as the
 * old process would have; expired ones are dropped with a WARN, because a
 * resume that never arrived is a fact the operator should be able to find.
 * Returns the re-armed agent names. Exported for the regression test.
 */
export function restorePendingResumes(nowMs: number): string[] {
  pendingResumes = readPendingResumes()
  const { live, expired } = restorableResumeStates(pendingResumes, nowMs)
  let clamped = false
  for (const [name, st] of live) {
    if (!guardStates.has(name)) guardStates.set(name, st)
    // Clamp a future restartedAtMs ONCE, here, with the same rule
    // restorableResumeStates applied to the deadline, and persist it. Clamping
    // per sweep instead would slide the TTL edge forward on every sweep while
    // the clock stays behind the stamp, so the in-memory park would outlive the
    // deadline this restore just set.
    const entry = pendingResumes[name]
    if (entry && entry.restartedAtMs > nowMs) {
      pendingResumes = { ...pendingResumes, [name]: { ...entry, restartedAtMs: nowMs } }
      clamped = true
    }
  }
  if (clamped && expired.length === 0) persistPendingResumes()
  if (expired.length > 0) {
    for (const name of expired) {
      logger.warn(
        { name, restartedAtMs: pendingResumes[name]?.restartedAtMs, reason: pendingResumes[name]?.reason },
        'context-guard: pending resume EXPIRED across a dashboard restart -- the fresh session never got its resume prompt',
      )
      const rest = { ...pendingResumes }
      delete rest[name]
      pendingResumes = rest
    }
    persistPendingResumes()
  }
  if (live.size > 0) {
    logger.info({ agents: [...live.keys()] }, 'context-guard: re-armed pending resume(s) from a previous dashboard run')
  }
  return [...live.keys()]
}

// agent name -> when the daily-handoff tier last fired (ms). Seeded on first
// sight WITHOUT firing, so a slot that already passed before the dashboard
// started does not trigger a handoff cycle at boot -- the same seed rule, for
// the same reason, as the nightly auto-restart's lastRestart map. In-memory
// like that one: a dashboard restart re-seeds and at worst skips one slot,
// which is the safe direction (a missed daily handoff costs one day of
// context; a spurious one ends a live conversation).
const lastDailyHandoff = new Map<string, number>()
// Agents whose last due daily slot was skipped for an open inbound question;
// their next due slot fires regardless (see dailyHandoffSkipSweep). In-memory
// like lastDailyHandoff: a dashboard restart forgets it, which can allow one
// more skip in a row.
const dailySkipped = new Set<string>()

/** Does the owner's open question hold this agent back (the /clear gate's rule)? undefined = unreadable. */
function dailyQuestionOpen(name: string): boolean | undefined {
  try { return ownerQuestionHolds(name) }
  catch { return undefined }
}

// New-card-dispatch tier (card f5f78e13): last in_progress card id seen per
// agent, so newCardDispatchDue can tell "still the same card" from "a
// different one was just dispatched". In-memory like the maps above: a
// dashboard restart forgets it and treats the next sweep as first sight,
// which never fires (the safe direction, same reasoning as lastDailyHandoff).
const lastDispatchedCard = new Map<string, string>()
const remoteSkipLogged = new Set<string>()
// Agents currently in the banner-vs-measurement mismatch state. The
// condition holds on EVERY sweep while a mis-tagged agent keeps running, so
// the WARN below is emitted on the state CHANGE only -- per-sweep it would be
// ~1150 lines a day into a log nobody then reads. Same idiom as
// remoteSkipLogged above.
const bannerMismatchLogged = new Set<string>()
// Usage-limit parking state per agent: 'limited' while
// parked, or 'expired:<sinceMs>' once an episode outlived
// USAGE_LIMIT_MAX_PARK_MS. A limited session stays limited for hours and the
// sweep sees it every five minutes, so the log lines are emitted on the state
// change only, like bannerMismatchLogged above.
const usageLimitLogged = new Map<string, string>()

// Per-agent observed-context high-water mark, persisted across dashboard
// restarts. calibrateLimit alone is memoryless: the moment the guard
// restarts an agent, the fresh session's observation shrinks back below the
// tier step-up point, the denominator falls back to the base guess, and a
// miscalibrated agent gets restarted at the same false "over-full" reading
// every cycle -- the evidence that would have corrected the limit is
// destroyed by the very restart it triggered. Persisting the per-(agent,
// model) maximum breaks that loop: once a session has proven the window is
// bigger, the proof survives restarts. Keyed by model so a real model
// downgrade (e.g. fable-5 -> haiku) does not inherit a 1M denominator.
const HIGHWATER_PATH = join(PROJECT_ROOT, 'store', 'context-guard-highwater.json')
type HighwaterMap = Record<string, { model: string; tokens: number }>

function readHighwater(): HighwaterMap {
  try {
    const parsed = JSON.parse(readFileSync(HIGHWATER_PATH, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed as HighwaterMap : {}
  } catch { return {} }
}

let highwater: HighwaterMap | null = null

// `learn` false reads the stored mark without raising it: a status read must
// not change the thing it reports on, so only the guard's sweep writes.
function observedHighwater(name: string, model: string, observedNow: number, learn: boolean): number {
  if (highwater === null) highwater = readHighwater()
  const entry = highwater[name]
  const prior = entry && entry.model === model ? entry.tokens : 0
  if (learn && observedNow > prior) {
    highwater[name] = { model, tokens: observedNow }
    try { writeFileSync(HIGHWATER_PATH, JSON.stringify(highwater, null, 2)) }
    catch (err) { logger.warn({ err }, 'context-guard: highwater persist failed') }
  }
  return Math.max(observedNow, prior)
}

function sessionFor(name: string): string {
  return name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
}

function handoffPathFor(name: string): string {
  return join(agentConfigRoot(name), 'HANDOFF.md')
}

// Structured, per-resume restart log (card d66b7681, MikroB GO msg 18804 condition 2). A plain
// JSONL append, same shape as channel-event-log.ts -- one line per resume injection, nothing to
// read atomically, so appendFileSync is enough (no concurrent-writer risk worse than an interleaved
// line, which a line-oriented JSONL reader tolerates).
const RESTART_LOG_PATH = process.env.CONTEXT_GUARD_RESTART_LOG_PATH ?? join(PROJECT_ROOT, 'store', 'context-guard-restart-log.jsonl')

function appendRestartLogEntry(name: string, hadHandoff: boolean, staleMinutes: HandoffStaleness): void {
  try {
    const entry = buildRestartLogEntry(name, hadHandoff, staleMinutes, Date.now())
    appendFileSync(RESTART_LOG_PATH, JSON.stringify(entry) + '\n')
  } catch (err) {
    // Observability, not a control path: losing this line must never block or retry the resume
    // injection itself, only be noted.
    logger.warn({ err, name }, 'context-guard: failed to append restart-log entry')
  }
}

function handoffMtime(name: string): number | null {
  try { return statSync(handoffPathFor(name)).mtimeMs } catch { return null }
}

export function handoffPrompt(pctRound: number, handoffPath: string): string {
  return (
    `[CONTEXT-GUARD] A munkakontextusod ~${pctRound}%-on van -- kritikus. ` +
    `NE folytasd a feladatot. EGYETLEN dolgod ebben a körben: írj HANDOFF.md-t a /handoff skill struktúrája szerint ide: ${handoffPath} ` +
    `(purpose: a folyamatban lévő feladat folytatása friss kontextusban; Goal / Current Progress / What Worked / What Didn't Work / Next Steps szekciók, ` +
    `konkrét fájl-útvonalakkal és kanban kártya-azonosítókkal). Ha nincs aktív feladatod, írd bele hogy nincs. ` +
    `Utána ÁLLJ MEG -- a rendszer friss kontextussal újraindít és a HANDOFF.md-ből folytatod.`
  )
}

/**
 * Handoff request for the idle-flush tier.
 *
 * Separate wording from handoffPrompt on purpose. That one tells an agent its
 * context is critical and to drop what it is doing, which is true at 90% of the
 * window and false here: this tier only ever fires on a session that has been
 * quiet for the configured idle period, so there is nothing in flight to drop.
 * Reusing the alarming text would push an idle agent into treating a routine
 * housekeeping restart as an emergency.
 */
export function idleFlushHandoffPrompt(tokens: number, idleMinutes: number, handoffPath: string): string {
  return (
    `[CONTEXT-GUARD] Rutin karbantartás, nem vészhelyzet. A sessionöd kontextusa ~${Math.round(tokens / 1000)}k token, ` +
    `és ${idleMinutes} perce nincs benne aktivitás, ezért friss kontextussal indítalak újra -- így olcsóbb és gyorsabb lesz a következő kör. ` +
    `EGYETLEN dolgod: írj HANDOFF.md-t a /handoff skill struktúrája szerint ide: ${handoffPath} ` +
    `(Goal / Current Progress / What Worked / What Didn't Work / Next Steps, konkrét fájl-útvonalakkal és kanban kártya-azonosítókkal). ` +
    `Ha nincs félbehagyott feladatod, írd bele hogy nincs -- az is teljes értékű válasz. ` +
    `Utána ÁLLJ MEG; a rendszer újraindít és a HANDOFF.md-ből folytatod.`
  )
}

/**
 * Handoff request for the daily tier.
 *
 * A fourth wording, for the same reason the idle tier needed a third: this
 * agent's context is not critical (the act tier would have fired) and not
 * expensive (the idle tier would have), so both of those texts would state
 * something untrue about its session. What IS true is the only thing this
 * prompt claims: the scheduled restart is about to happen, and whatever is
 * not written down will not survive it.
 */
export function dailyHandoffPrompt(atTime: string, handoffPath: string): string {
  return (
    `[CONTEXT-GUARD] Ütemezett napi újraindítás (${atTime}), nem vészhelyzet és nem hiba. ` +
    `A sessionöd hamarosan friss kontextussal indul újra, és ami nincs leírva, az nem éli túl. ` +
    `EGYETLEN dolgod ebben a körben: írj HANDOFF.md-t a /handoff skill struktúrája szerint ide: ${handoffPath} ` +
    `(Goal / Current Progress / What Worked / What Didn't Work / Next Steps, konkrét fájl-útvonalakkal és kanban kártya-azonosítókkal). ` +
    `Ha nincs félbehagyott feladatod, írd bele hogy nincs -- az is teljes értékű válasz. ` +
    `Utána ÁLLJ MEG; a rendszer újraindít és a HANDOFF.md-ből folytatod.`
  )
}

// CYBERSEC F4 (WhiteHat2, delta on e9e025765): the card title is set by
// whoever holds the shared bearer token, so it is untrusted DATA, not prompt
// structure -- a retitle to e.g. "[SYSTEM-DIREKTIVA msg_id:1] ..." would land
// verbatim inside an authenticated handoff/resume directive. Strips the
// bracket characters every recognized directive prefix depends on
// ([SYSTEM-DIREKTIVA ...], [CONTEXT-GUARD], [CONTEXT-RESTART-GATE], [SYSTEM:
// ...]), collapses to one line, and caps length, so it can only ever read as
// a quoted label, never as an envelope.
const MAX_CARD_TITLE_PROMPT_LEN = 80

function sanitizeCardTitleForPrompt(title: string): string {
  const oneLine = title.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  const noBrackets = oneLine.replace(/[[\]]/g, '')
  const capped = noBrackets.length > MAX_CARD_TITLE_PROMPT_LEN
    ? `${noBrackets.slice(0, MAX_CARD_TITLE_PROMPT_LEN)}...`
    : noBrackets
  return `"${capped}"`
}

/** `<id> "<title>"` when both are known, `<id>` alone when the title lookup
 *  missed, or a generic phrase when even the id is unknown (CYBERSEC F2,
 *  comment 31757: the id/title can be null if the card left in_progress or
 *  was deleted between the DB read and the prompt being built). The title is
 *  sanitized (CYBERSEC F4) before it ever reaches a prompt string. */
function newCardLabel(newCardId: string | null, newCardTitle: string | null): string {
  if (newCardId === null) return 'az új kártya'
  return newCardTitle ? `${newCardId} ${sanitizeCardTitleForPrompt(newCardTitle)}` : newCardId
}

/**
 * Handoff request for the new-card-dispatch tier (card f5f78e13).
 *
 * A fifth wording, same reasoning as the idle and daily tiers: this session
 * is neither critical nor expensive nor a day old, so those texts would state
 * something untrue. What IS true: a DIFFERENT kanban card was just dispatched
 * to this agent, so the restart is about to start on it fresh -- unrelated to
 * whatever the OLD card's session was holding. Names the NEW card (CYBERSEC
 * F2, comment 31757) so the handoff the agent writes can say "closed by
 * <id>" rather than leaving that link to be inferred later.
 */
export function newCardDispatchHandoffPrompt(handoffPath: string, newCardId: string | null, newCardTitle: string | null): string {
  return (
    `[CONTEXT-GUARD] Új kártya érkezett dispatch-ben (${newCardLabel(newCardId, newCardTitle)}), nem vészhelyzet és nem hiba. ` +
    `A sessionöd hamarosan friss kontextussal indul újra, mert az új kártya nem függ az eddigi beszélgetésedtől. ` +
    `EGYETLEN dolgod ebben a körben: írj HANDOFF.md-t a /handoff skill struktúrája szerint ide: ${handoffPath} ` +
    `(Goal / Current Progress / What Worked / What Didn't Work / Next Steps, konkrét fájl-útvonalakkal és kanban kártya-azonosítókkal) ` +
    `a JELENLEGI (régi) kártyádról, amit ez a dispatch lezár. ` +
    `Ha nincs félbehagyott feladatod, írd bele hogy nincs -- az is teljes értékű válasz. ` +
    `Utána ÁLLJ MEG; a rendszer újraindít, és a dispatch-üzenet magával hozza az új kártya tartalmát.`
  )
}

/**
 * A handoff refresh request: the agent DID write a handoff, then kept working,
 * so the artifact no longer covers the session. Distinct wording from both
 * other requests -- "write a handoff" would read as a bug ("I already did"),
 * and the critical-context alarm may be false here.
 */
export function staleRefreshHandoffPrompt(staleMinutes: number, handoffPath: string): string {
  return (
    `[CONTEXT-GUARD] A HANDOFF.md-d megvan, de az írása óta ~${staleMinutes} perc érdemi munka történt, ` +
    `tehát a mostani állapotot MÁR NEM fedi (döntések, verdiktek, üzenetváltások hiányoznak belőle). ` +
    `EGYETLEN dolgod ebben a körben: frissítsd a HANDOFF.md-t itt: ${handoffPath} úgy, hogy a legutóbbi munkát is tartalmazza ` +
    `(mi dőlt el, mi került leadásra, mi a következő lépés). Utána ÁLLJ MEG -- a rendszer friss kontextussal újraindít és ebből folytatod.`
  )
}

/**
 * The queue sentence of the restart notice. The notice used to tell the main
 * agent that messages sent to the old session "may have been lost -- check and
 * resend them", without measuring anything. Resending is usually wrong: pending
 * rows are delivered into the fresh session once it is ready, and the resume
 * prompt tells the fresh session to re-read the restart window itself, so a
 * resend lands as a duplicate in the very session that was just restarted to
 * get its context down. The sentence now carries the counts instead; the rows
 * the router will not retry are the failed ones. Exported so a test pins it.
 */
export function restartNoticeQueueText(queue: { pending: number; failed: number } | null): string {
  if (queue === null) {
    return ' A sor allapotat NEM tudtam megmerni -- ellenorizd kezzel, mielott barmit ujrakuldenel.'
  }
  return ` A sor a restart pillanataban: ${queue.pending} pending, ${queue.failed} failed (utolso ora).` +
    (queue.failed > 0
      ? ` A ${queue.failed} failed sort a router mar NEM probalja ujra -- ezeket nezd meg (a 'result' mezo mondja meg, miert buktak).`
      : '') +
    (queue.pending > 0
      ? ` A ${queue.pending} pending sort a router a friss sessionbe kezbesiti, amint az kesz -- NE kuldd ujra, mert duplikalodik.`
      : '') +
    ' A regi sessionbe az utolso percekben kezbesitett uzeneteket a resume prompt alapjan a friss session maga olvassa vissza -- ezeket se kuldd ujra.' +
    // Both promises need the resume to happen; a ready-timeout gives it up, and then nothing re-reads.
    ' Mindez akkor all, ha a friss session elindul es megkapja a resume promptot; ha nem, a sort es ezeket az uzeneteket kezzel nezd meg.'
}

/** Counts the queue for the restart notice; a failed count yields null, not a guess. */
export function restartQueueAtRestart(name: string): { pending: number; failed: number } | null {
  try {
    return countRestartQueueState(name, Math.floor(Date.now() / 1000) - 3600)
  } catch (err) {
    logger.warn({ err, name }, 'context-guard: queue count for the restart notice failed')
    return null
  }
}

/**
 * The safety-rule tail every resume prompt shares, regardless of why the
 * restart happened: re-read the inter-agent queue for anything lost in the
 * restart window, never touch the live prod checkout, and report in on the
 * right channel. Extracted so a tier-specific resume prompt (see
 * newCardDispatchResumePrompt below) states its own reason up front without
 * dropping or re-typing any of these -- CYBERSEC F2, comment 31757, asked
 * for a tier-specific wording, not a tier-specific safety contract.
 */
function resumePromptSafetyTail(name: string): string {
  return (
    // ORSICTX912: msg 23670 was delivered SEVEN SECONDS after the guard kill
    // started, into the dying session -- the queue marked it delivered, the
    // fresh session had no reason to look, and completed_at is unused (0/37
    // measured), so the loss is invisible from the queue. The re-read must
    // ride in the resume prompt (the fresh session's only context), and the
    // ack-to-sender is the OBSERVABLE trace: without it, verifying this very
    // instruction would run into the same blindness it exists to fix.
    `RESTART-ABLAK: az előző session utolsó ~15 percében kézbesített inter-agent üzenet elveszhetett. ` +
    `Olvasd vissza a saját sorodat erre az ablakra (GET /api/messages?agent=${name}, created_at szerint szűrve), ` +
    `és minden ott talált, még el nem intézett kérést kezelj újként. KÖTELEZŐ MEGFIGYELHETŐ NYOM: minden ` +
    `visszaolvasott tételről küldj rövid nyugtát a feladónak ("[RESTART-ABLAK] <id> felvéve a friss sessionben"), ` +
    `akkor is, ha nincs belőle teendő -- e nélkül a visszaolvasás a sorból láthatatlan. ` +
    // RESPAWNZAJ822/PRODFAAG822: a fresh session acting on a resume goal is
    // exactly the actor that branch-switched and committed on the live prod
    // tree (2026-08-22 10:10, PR #1036 duplicate). The constraint must ride in
    // the resume prompt itself -- it is the ONLY context the fresh session has.
    `KORLÁT: a futó prod fán (a repo fő checkoutján) NE válts ágat, NE commitolj és NE nyiss belőle PR-t ` +
    `-- ha repo-munka kell, használj worktree-t (git worktree add). ` +
    // The main agent's channel is the OWNER's channel (Telegram), and session
    // meta must never go there (standing owner preference; a 3am status
    // notice measured on 2026-08-05, review msg 14197). Sub-agents' channel
    // is the inter-agent queue, where the notice belongs. This prompt is the
    // fresh session's ONLY rule set, so the split must live here.
    (name === MAIN_AGENT_ID
      ? `Zárásul egyetlen transzkript-sorban rögzítsd, hogy friss kontextussal folytatod -- a csatornádra (a gazda Telegramjára) session-meta NEM mehet ki.`
      : `Röviden jelezz a csatornádon, hogy friss kontextussal folytatod.`)
  )
}

export function resumePrompt(
  name: string,
  handoffPath: string,
  hadHandoff: boolean,
  staleMinutes: HandoffStaleness = null,
): string {
  const base =
    // Wording covers both tiers that lead here: "grew too large" is true at the
    // act threshold and true of an idle-flush, where the context was heavy but
    // the window was nowhere near full. "megtelt" would be false in that case.
    `[CONTEXT-GUARD] Friss kontextussal indultál, mert az előző session kontextusa túl nagyra nőtt (auto-handoff). `
  const source = !hadHandoff
    ? `HANDOFF.md nem készült el időben, ezért az élő forrásokból dolgozz. `
    : staleMinutes === 'unknown'
      // A missing measurement must not impersonate a fresh one: say that the
      // freshness was unverifiable, so the agent cross-checks instead of
      // trusting the artifact blindly.
      ? `Első lépés: olvasd be ${handoffPath} -- ez az előző session átadója, de a FRISSESSÉGÉT NEM TUDTAM MEGMÉRNI. ` +
        `Kezeld óvatosan: vesd össze a kanban-kommentekkel és az inter-agent üzenetekkel, mielőtt a Next Steps-e szerint cselekednél. `
      : typeof staleMinutes === 'number'
      // A stale handoff presented as current re-opens already-decided
      // questions; say the gap out loud and route the agent to the live
      // sources FIRST for the uncovered window.
      ? `Első lépés: olvasd be ${handoffPath} -- ez az előző session átadója, DE ELAVULT: az utolsó ~${staleMinutes} perc munkája NINCS benne. ` +
        `A hiányzó szakaszt az élő forrásokból pótold (kanban-kommentek, inter-agent üzenetek, hot memóriák), MIELŐTT a handoff Next Steps-e szerint cselekednél. ` +
        // card d66b7681 (MikroB GO, msg 18804, condition 1): a backend3 restart
        // (~30 perc elavult handoff) dupla landolással végződött -- a puszta
        // FIGYELEM-sor nem volt elég konkrét ahhoz, hogy megállítsa. Ez a sor
        // egy MÉRHETŐ, KONKRÉT elsőlépés, nem csak egy újabb figyelmeztetés.
        `KÖTELEZŐ ELSŐ LÉPÉS, MIELŐTT BÁRMILYEN land/push/PUT done (vagy más visszafordíthatatlan lépés) megtörténne: ` +
        `futtasd \`git ls-remote\` + \`git cat-file -e\` MINDEN sha-ra, amit a handoff megnevez (már landolt / pusholt állapotnak állít), ` +
        `és olvasd újra az ott megnevezett MINDEN kártya aktuális kanban-státuszát (GET /api/kanban/<id>) -- ne a handoff szava szerint, a MÉRÉS szerint dönts arról, hogy valami már megtörtént-e. `
      : `Első lépés: olvasd be ${handoffPath} -- ez az előző session átadója. `
  return (
    base + source +
    `Utána ellenőrizd a kanban tábládat (in_progress kártyák, assignee=${name}) és a hot memóriáidat, ` +
    `és FOLYTASD a megkezdett munkát magadtól. Ne kezdd elölről ami a handoff szerint már kész. ` +
    resumePromptSafetyTail(name)
  )
}

/**
 * Resume prompt for the new-card-dispatch tier (card f5f78e13).
 *
 * Its own wording, not resumePrompt's (CYBERSEC F2, comment 31757): "az
 * előző session kontextusa túl nagyra nőtt" is FALSE for this tier -- the
 * session was healthy, it is simply starting a different card now. Names
 * the new card (id/title) so the agent does not have to infer which card
 * the restart was FOR from a HANDOFF.md that describes the OLD one.
 */
export function newCardDispatchResumePrompt(
  name: string,
  handoffPath: string,
  hadHandoff: boolean,
  newCardId: string | null,
  newCardTitle: string | null,
): string {
  const label = newCardLabel(newCardId, newCardTitle)
  const base = `[CONTEXT-GUARD] Friss kontextussal indultál, mert egy ÚJ kártyát kaptál dispatch-ben: ${label}. `
  const source = !hadHandoff
    ? `A régi kártyádról nem készült el időben a HANDOFF.md; ha félbehagyott munkád volt rajta, az élő forrásokból (kanban-kommentek, git) derítsd ki. `
    : `Első lépés: olvasd be ${handoffPath} -- ez az ELŐZŐ kártyádról készült átadó, amit ez a dispatch lezárt. `
  return (
    base + source +
    `A dispatch-üzenet magával hozta az új kártya (${label}) tartalmát -- ellenőrizd a saját sorodat ` +
    `(GET /api/messages?agent=${name}) és a kártyát magát, majd FOLYTASD AZON a munkát, ne az előzőn. ` +
    resumePromptSafetyTail(name)
  )
}

// Exported for src/__tests__/main-config-dir-wiring.test.ts (QA2 L1, 25ea084c): the delegation to
// mainAgentConfigDir() must be pinned on the REAL function, not a fully-mocked module, or a silent
// revert to the pre-TOKENVAK915 unconditional `undefined` passes every existing test unnoticed.
export function configDirFor(name: string): string | undefined {
  // resolveAgentConfigDirForRead, not readAgentClaudeConfigDir (card 272361eb, B-wave): an agent
  // whose config dir was auto-provisioned by the launcher has no field to read, so the old call
  // returned null and this runner then measured the HOST default -- another agent's absence read
  // as this one's context size.
  // TOKENVAK915: the main agent's OWN isolated config root used to be skipped entirely
  // (unconditional `undefined`) -- see main-transcript-root.ts for why and the fix.
  return name === MAIN_AGENT_ID ? mainAgentConfigDir(agentConfigRoot(name)) : (resolveAgentConfigDirForRead(name) ?? undefined)
}

/** Operator notice for a resume give-up. Exported so the wording is pinned by a test. */
export function resumeGiveUpNotice(name: string, handoffPath: string): string {
  return `[CONTEXT-GUARD] A(z) "${name}" agent restartja utan a session ${READY_TIMEOUT_MS / 60_000} percen belul nem lett kesz, ` +
    'ezert a folytatasi (resume) prompt NEM ment ki. Az agent vagy nem fut, vagy nem fogad promptot, vagy a handoff nelkul indult el. ' +
    `Nezd meg a pane-t; ha all, add be neki kezzel a handoffot: ${handoffPath}`
}

/**
 * The resume give-up is decided as action 'none', and the none-branch logs
 * nothing, so the restarted agent could sit without its handoff pointer while
 * nobody knew the resume path had failed. Warn, and tell a human through the
 * same sinks as the rescue-failure alert: the main agent's own inbox is not a
 * sink for an alert about the main agent.
 */
export async function reportResumeGiveUp(name: string): Promise<void> {
  logger.warn({ name }, 'context-guard: resume give-up -- the restarted session never became ready, resume prompt not sent')
  const text = resumeGiveUpNotice(name, handoffPathFor(name))
  try {
    if (name === MAIN_AGENT_ID) await notifyChannel(text)
    else createAgentMessage(name, MAIN_AGENT_ID, text, 'context-guard resume give-up notice')
  } catch (err) {
    logger.error({ err, name }, 'context-guard: FAILED TO RAISE the resume give-up notice')
  }
}

/** Raw observed context size (tokens) for the idle-flush tier's absolute threshold. */
async function measureContextTokens(name: string): Promise<number | null> {
  const tokens = await readContextTokensFromProjectDir(agentConfigRoot(name), configDirFor(name))
  return tokens !== null && tokens > 0 ? tokens : null
}

/**
 * How long the session's transcript has been untouched (ms), or null when
 * unmeasurable. A negative reading (transcript mtime in the future, e.g. after
 * a clock change) is treated as "just now" rather than as a large idle time --
 * a wrong clock must not be able to trigger a flush.
 */
function measureIdleMs(name: string, nowMs: number): number | null {
  const mtime = readTranscriptMtimeFromProjectDir(agentConfigRoot(name), configDirFor(name))
  if (mtime === null) return null
  return Math.max(0, nowMs - mtime)
}

// Koteg 24 (card 57044a66): async signature + agentConfigRoot() kept per the standing
// fork-upstream/acknowledged-conflicts.ts pin on this exact point -- this fork's
// readContextTokensFromProjectDir is async (upstream's is sync), so upstream's sync
// measurePct would silently return a Promise where a number|null is expected. `opts`
// (upstream's new learn-suppression flag) is adopted; it is already referenced below.
export async function measurePct(name: string, cfgLimit: number | null, opts: { learn?: boolean } = {}): Promise<number | null> {
  const workingDir = agentConfigRoot(name)
  const configDir = configDirFor(name)
  const tokens = await readContextTokensFromProjectDir(workingDir, configDir)
  if (tokens === null || tokens <= 0) return null
  let limit: number
  if (cfgLimit) {
    limit = cfgLimit
  } else {
    const model = (name === MAIN_AGENT_ID
      ? await readActiveModelFromProjectDir(PROJECT_ROOT)
      : readAgentModel(name)) ?? ''
    // Calibrate against the persisted per-(agent, model) maximum, not just
    // the live reading: a fresh post-restart session must not un-learn a
    // window the previous session already proved (see HighwaterMap above).
    limit = calibrateLimit(observedHighwater(name, model, tokens, opts.learn !== false), contextLimitForModel(model))
  }
  return tokens / limit
}

/**
 * Card d2c3a940: a parked agent restarted with --continue resumes a near-full prior session, and
 * the first dispatch message pushed it over the ceiling before context-compact-monitor.sh's own
 * 15-minute sweep (which does not even include every agent) got around to it -- measured on
 * jogász, 2026-10-11 12:06, "Context limit reached" on the very first turn after a manual start.
 *
 * Single-agent wrapper around the SAME calibrated measurePct this guard's own periodic sweep uses
 * (readContextGuardConfig's limitTokens override, or contextLimitForModel + the persisted
 * per-(agent, model) highwater calibration) -- not a second, independent percentage computation.
 * Exported so the start route can ask "is THIS agent already near the ceiling" synchronously,
 * right after launch and before any queued message is allowed to reach the pane.
 */
export async function measureContextPctForAgent(name: string): Promise<number | null> {
  const cfg = readContextGuardConfig(name)
  if (!cfg.enabled) return null
  return measurePct(name, cfg.limitTokens)
}

async function performRestart(name: string): Promise<void> {
  if (name === MAIN_AGENT_ID) {
    // Platform-correct main-session restart. This was a hardcoded
    // `/bin/launchctl kickstart`, which exists only on macOS: on Linux every
    // rescue died instantly with `spawnSync /bin/launchctl ENOENT`, caught by
    // checkAgent's catch and buried in a single WARN. Measured on 2026-07-26:
    // the main agent sat at 100% context from 09:47, the saturation net -- the
    // only mechanism that can rescue a pane prompt dispatch refuses -- fired
    // four times and failed every time, and main was unreachable for ~2h until
    // a hand restart.
    //
    // hardRestartMarveenChannels() is the existing helper the channel-monitor
    // down-cascade already uses: it keeps the launchd path for macOS installs
    // (and warns + falls back to a pane respawn if the plist is absent), uses
    // respawn-pane-FRESH on Linux -- fresh is exactly what the guard wants --
    // and writes the shared respawn stamp so the other respawners defer to us.
    const res = hardRestartMarveenChannels()
    if (!res.ok) throw new Error(res.error ?? 'main channels hard restart failed')
  } else {
    // DANICTXHUROK906: claim the reconcile grace window BEFORE the stop, so
    // reconcileDesiredAgents() does not see the agent "down" mid-restart and
    // re-launch it non-fresh (--continue), which would defeat the whole point
    // of a context-guard restart -- dropping the saturated context.
    markAgentRestartPending(name)
    // The result was discarded here until 2026-09-01. startAgentProcess has an
    // early "Agent is already running" return, and a supervisor that started
    // the agent inside our stop window (restart-lock.ts) trips it -- so the
    // rescue reported success while the pane still held the saturated session
    // it was supposed to drop. Measured twice on levente, 2026-08-31 19:10 and
    // 19:41; the second restart WAS the first one's unnoticed failure.
    const res = await restartAgentProcess(name, { fresh: true })
    if (!res.ok) throw new Error(res.error ?? 'agent restart failed')
  }
}

/** Is this agent fed through the worksource queue (it redelivers unacknowledged items)? */
function onWorksource(name: string): boolean {
  try { return readAgentWorksourceChannel(name) } catch { return false }
}

/**
 * The "what may have been lost" sentence of the restart notice. The generic
 * line tells the supervisor that prompts sent to the old session may be gone
 * and to send them again. For an idle-flush restart of
 * an agent on the worksource queue that is false twice over: it had nothing in
 * flight, and the queue redelivers whatever it had not acknowledged. The
 * supervisor following the generic line sent three needless status messages
 * (~3.1M input tokens, measured 2026-09-29), so that case gets its own text.
 * Every other case, and any agent NOT on worksource, gets the queue at restart
 * time instead (restartNoticeQueueText): a resend advice would duplicate rows
 * the router still delivers.
 */
export function restartLossLine(
  idleFlush: boolean,
  worksource: boolean,
  idleMinutes: number,
  queue: { pending: number; failed: number } | null,
): string {
  if (worksource && idleFlush) {
    return (
      `. Tetlen volt (>= ${idleMinutes} perc), folyamatban levo munka nem volt; a nyugtazatlan tetelek a sorbol ujrakezbesulnek; ` +
      'a resume magatol megy -- NE kuldj allapot-uzenetet es NE kuldj ujra semmit.'
    )
  }
  return '.' + restartNoticeQueueText(queue)
}

async function checkAgent(name: string, nowMs: number): Promise<void> {
  const cfg = readContextGuardConfig(name)
  const state = guardStates.get(name) ?? INITIAL_GUARD_STATE

  // Fully disarmed only when EVERY tier and the always-on saturation net are
  // off; the net alone keeps the sweep alive so a 100%-context pane (which
  // dispatch refuses to prompt) still gets rescued.
  //
  // Every tier that can act has to appear in this list. This is the THIRD
  // copy of the same condition (decideGuard's short-circuit and its
  // await-handoff stand-down are the other two), and the daily tier was
  // missing from exactly this one: an operator who turned the saturation net
  // off and the daily tier on would have been skipped here, before
  // decideGuard ever saw the agent, with no log line to say so.
  if (!cfg.enabled && !cfg.saturationRestart && !cfg.idleFlushEnabled && !cfg.dailyHandoffEnabled) {
    guardStates.delete(name)
    dropPendingResume(name, 'guard disabled')
    return
  }

  // v1: local agents only -- a remote host's transcripts are unreadable here.
  if (name !== MAIN_AGENT_ID && readAgentRemoteHost(name)) {
    if (!remoteSkipLogged.has(name)) {
      remoteSkipLogged.add(name)
      logger.info({ name }, 'context-guard: remote-host agent, skipping (transcripts not local)')
    }
    return
  }

  const session = sessionFor(name)
  const running = name === MAIN_AGENT_ID
    ? capturePane(session) !== null
    : agentRunState(name) === 'running'

  // Only pay for the tmux/transcript probes a decision can actually use.
  const needPct = state.phase === 'idle' || state.phase === 'await-handoff'
  const pane = running && needPct ? capturePane(session) : null
  const sessionReady = running && state.phase === 'await-ready'
    ? await isSessionReadyForPrompt(session)
    : false
  // One classification, two distinct signals: 'idle' (safe to restart) and
  // 'busy' (positively mid-turn -- restarts defer). A pane that is neither
  // (error banner, modal, unknown surface) is treated as NOT busy, so a
  // wedged pane still gets the restart that is its only way out.
  const paneState = pane !== null ? detectPaneState(pane) : 'unknown'

  // Usage limit: every tier parks while the session is
  // CURRENTLY refused, and that includes await-ready -- a resume prompt typed
  // into a limited session is lost. Decided from the transcript, never from
  // the pane banner, which stays up long after the limit lifts (see
  // USAGE_LIMIT_REASON_PREFIX). Cooldown decides nothing, so it reads nothing.
  //
  // Nor does an agent whose only armed mechanism is the saturation net, outside
  // the two handoff phases: the net is never parked, and the idle phase has no
  // other tier the verdict could hold back, so the tail read (up to
  // TRANSCRIPT_TAIL_BYTES per agent per sweep) would buy nothing. The handoff
  // phases still read it: a sequence can outlive a config change that disarmed
  // its tier, and await-ready parks the resume for any agent.
  const onlyNetArmed = !cfg.enabled && !cfg.idleFlushEnabled && !cfg.dailyHandoffEnabled
  const usageCanMatter = !onlyNetArmed || state.phase === 'await-handoff' || state.phase === 'await-ready'
  let usage: ReturnType<typeof usageLimitVerdict> | null = null
  if (running && state.phase !== 'cooldown' && usageCanMatter) {
    // workingDirFor was upstream's name for this fork's agentConfigRoot (silent auto-merge
    // leftover, Koteg 22: the call site changed cleanly but the helper's own definition did
    // not carry over, since this fork already has an equivalent under a different name).
    const tail = readTranscriptTailFromProjectDir(agentConfigRoot(name), configDirFor(name))
    if (tail === null) {
      // Absent or unreadable: read as "not limited", i.e. the old behaviour.
      logger.debug({ name, phase: state.phase }, 'context-guard: transcript tail unreadable or absent -- usage-limit check sees no refusal')
    }
    // In await-ready only the NEW session's refusals count (see the
    // sessionStartMs note at usageLimitVerdict).
    const sessionStartMs = state.phase === 'await-ready' ? pendingResumes[name]?.restartedAtMs ?? null : null
    usage = usageLimitVerdict(usageLimitEvidenceFromTranscript(tail ?? ''), nowMs, sessionStartMs)
  }
  if (usage !== null) {
    const prev = usageLimitLogged.get(name)
    if (usage.limited) {
      if (prev !== 'limited') {
        usageLimitLogged.set(name, 'limited')
        logger.info(
          { name, session, phase: state.phase, sinceMs: usage.evidence.sinceMs, resetsAtMs: usage.evidence.resetsAtMs, refusal: usage.evidence.text },
          'context-guard: session is usage-limited (newest transcript turn refused) -- handoff, flush, daily, restart and resume parked until it lifts',
        )
      }
    } else if (usage.reason === 'park-expired' && usage.evidence !== null) {
      const key = `expired:${usage.evidence.sinceMs}`
      if (prev !== key) {
        usageLimitLogged.set(name, key)
        logger.warn(
          { name, session, phase: state.phase, sinceMs: usage.evidence.sinceMs, maxParkMs: USAGE_LIMIT_MAX_PARK_MS, refusal: usage.evidence.text },
          'context-guard: usage-limit parking exceeded its time bound -- no longer trusting the refusal, normal guard logic resumes',
        )
      }
    } else if (prev !== undefined) {
      usageLimitLogged.delete(name)
      logger.info({ name, session, phase: state.phase, reason: usage.reason }, 'context-guard: usage limit lifted -- normal guard logic resumes')
    }
  }

  // The pane banner and the calibrated measurement are TWO signals about one
  // fact, and this sweep is the only place that holds both. Reconciling them
  // HERE leaves decideGuard's contract intact ("paneSaturated means the pane
  // really is saturated") and lets all three consumers of the signal -- the net
  // below, agent-process.ts's dispatch gate and schedule-runner.ts's forceSend
  // deferral -- act on ONE verdict.
  const paneSaturatedRaw = pane !== null ? paneShowsContextSaturation(pane) : false
  // Only a PERCENTAGE claim can be contradicted by a measurement; an
  // error-shaped banner is painted after a turn actually failed at the real
  // limit and is final (see saturationBannerCredible). So the error case needs
  // no probe at all -- which also keeps the promise above this function: the
  // transcript probe is paid for only where a decision can use it. That matters
  // beyond CPU here, because measurePct persists a per-agent high-water mark to
  // store/context-guard-highwater.json; with cfg.enabled false and no banner up
  // we write exactly as little as before this change.
  const bannerIsHardError = pane !== null && paneShowsContextSaturationHardError(pane)
  const needCredibilityProbe = paneSaturatedRaw && !bannerIsHardError
  // UPSTREAM-SYNC BATCH 4 (card 0b550d89): missing `await` here, found while resolving the
  // unrelated conflict below that reuses this value -- the measurement helper above is async
  // (Promise<number | null>), and saturationBannerCredible()'s third parameter is typed
  // `number | null`, so this silently assigned a Promise object wherever `measuredPct` is
  // later compared or rounded (lines below, and the reused `pct` field in the inputs
  // object). Clean auto-merge from this batch's upstream commits, never flagged by git.
  const measuredPct = running && needPct && (cfg.enabled || needCredibilityProbe)
    ? await measurePct(name, cfg.limitTokens)
    : null
  const paneSaturatedTrusted = saturationBannerCredible(paneSaturatedRaw, bannerIsHardError, measuredPct)
  if (paneSaturatedRaw && !paneSaturatedTrusted) {
    noteSaturationBannerUntrusted(session, nowMs + SATURATION_OVERRIDE_TTL_MS)
    if (!bannerMismatchLogged.has(name)) {
      bannerMismatchLogged.add(name)
      logger.warn(
        {
          name,
          session,
          pct: measuredPct !== null ? Math.round(measuredPct * 100) : null,
          thresholdPct: Math.round(SATURATION_CREDIBLE_MIN_PCT * 100),
          limitTokens: cfg.limitTokens,
          // The actionable field: this is what says WHAT to fix. Same branch as
          // measurePct's, and it only runs on this rare state change.
          model: (name === MAIN_AGENT_ID
            ? readActiveModelFromProjectDir(PROJECT_ROOT, undefined, configDirFor(name))
            : readAgentModel(name)) ?? null,
        },
        // Fleet-side checks should match on the fields above (name, model, pct,
        // thresholdPct), never on this wording: the message is prose and may be
        // reworded, the fields are the contract.
        'context-guard: pane claims context saturation but the measured context contradicts it -- NOT restarting, and dispatch may keep prompting. Usual cause: the agent model id reaches the CLI without the `[1m]` marker, so the CLI sizes its status line to 200k.',
      )
    }
  } else if (pane !== null) {
    // Only a sweep that actually LOOKED at the pane may revoke the override.
    // paneSaturatedRaw is also false when we never captured (the await-ready and
    // cooldown phases leave pane === null), and "we did not look" is not
    // evidence that the banner is gone. The TTL still expires it fail-closed.
    clearSaturationBannerOverride(session)
    if (bannerMismatchLogged.delete(name)) {
      logger.info({ name, session }, 'context-guard: banner and measurement agree again -- the saturation net is live for this agent')
    }
  }

  // Read once, used both to compute newCardDispatchDue below and to advance
  // lastDispatchedCard at decision time -- a second query at decision time
  // could legitimately return a THIRD card id if one arrived between the two
  // reads, which would record the wrong "last seen" value.
  const dispatchedCardIdForGuard = cfg.newCardHandoffEnabled ? getInProgressCardIdForAgent(name) : null
  // Only looked up when there is an id to look up: same cost reasoning as
  // contextTokens being gated on idleFlushEnabled. Carried into GuardInputs
  // (and from there into GuardState) so the handoff/resume prompts can name
  // the new card instead of leaving the agent to infer it (CYBERSEC F2,
  // comment 31757).
  const dispatchedCardTitleForGuard = dispatchedCardIdForGuard !== null
    ? getKanbanCard(dispatchedCardIdForGuard)?.title ?? null
    : null

  const inputs: GuardInputs = {
    nowMs,
    running,
    // The proactive tiers own this field, and it stays gated on cfg.enabled
    // exactly as before: the await-handoff `pct >= hardPct` arm and the
    // stale-refresh condition are NOT behind cfg.enabled, so populating it for
    // an unconfigured agent would arm tiers that are quiet there today. The
    // credibility check above therefore reads measuredPct directly.
    //
    // UPSTREAM-SYNC BATCH 4 (card 0b550d89): the fork's side of this conflict called the
    // measurement helper a SECOND time with the same (name, cfg.limitTokens) args measuredPct
    // (above, line ~404) already computed once this tick -- predates that extraction, not a
    // deliberate fork decision. Adopted upstream's reuse to avoid the redundant async call.
    pct: cfg.enabled ? measuredPct : null,
    paneIdle: paneState === 'idle',
    paneBusy: paneState === 'busy',
    sessionReady,
    handoffMtime: needPct ? handoffMtime(name) : null,
    // Already reconciled with the measurement above, so decideGuard itself
    // needs no change and every existing net regression test still applies.
    paneSaturated: paneSaturatedTrusted,
    // Context-size probe, paid for only when the idle-flush tier is armed.
    // Note the condition is cfg.idleFlushEnabled, NOT cfg.enabled: the two
    // tiers are independently switchable, so an agent running the idle tier
    // alone must still get its measurements. AWAITED -- measureContextTokens
    // is async; upstream's version of this hunk dropped the await (would
    // assign the Promise itself, not the resolved number), kept as the fork
    // had it (card 72f5f13b merge resolution).
    contextTokens: running && needPct && cfg.idleFlushEnabled ? await measureContextTokens(name) : null,
    // idleMs is NOT gated on the idle-flush tier: the handoff-staleness check
    // (handoffStaleMinutes) needs the transcript mtime on every decision path
    // that can restart, and the probe is a single stat().
    idleMs: running && needPct ? measureIdleMs(name, nowMs) : null,
    // Seed-on-first-ARMED-sight, forget-while-disarmed on every sweep, and the
    // open-question skip: dailyHandoffSkipSweep decides all three,
    // applyDailyHandoffSkipSweep applies the record and the skip flag.
    dailyHandoffDue: applyDailyHandoffSkipSweep(lastDailyHandoff, dailySkipped, name, cfg, running && state.phase === 'idle', localMidnightMs(nowMs), nowMs, () => dailyQuestionOpen(name), () => logger.info({ name }, 'context-guard: daily handoff skipped today -- open inbound question (the next slot fires regardless)')),
    // Only queried when the tier is armed: an idle DB read on every sweep for
    // every agent, for a tier most installs leave off, is a cost nobody asked
    // for (same reasoning as contextTokens being gated on idleFlushEnabled).
    newCardDispatchDue: forgetNewCardDispatchRecord(cfg.newCardHandoffEnabled, dispatchedCardIdForGuard)
      ? (lastDispatchedCard.delete(name), false)
      : newCardDispatchDue(cfg.newCardHandoffEnabled, dispatchedCardIdForGuard, lastDispatchedCard.get(name)),
    newCardId: dispatchedCardIdForGuard,
    newCardTitle: dispatchedCardTitleForGuard,
    usageLimited: usage?.limited === true,
    // Same edge as restorableResumeStates, so the in-memory park and the
    // persisted obligation end together. No clamp here: restartedAtMs was
    // clamped once when it was recorded (Date.now()) or restored
    // (restorePendingResumes), and a per-sweep Math.min(.., nowMs) would slide
    // the edge along with a clock that stepped backwards.
    pendingResumeExpiresAtMs: pendingResumes[name]
      ? pendingResumes[name].restartedAtMs + PENDING_RESUME_TTL_MS
      : null,
  }

  const decision = decideGuard(state, inputs, cfg)

  // Mark the slot served at DECISION time, not after the prompt lands. If the
  // directive fails to send, the machine is already in await-handoff and its
  // timeout force-restarts the agent anyway -- the slot really was consumed.
  // Marking it later would let a send failure re-fire the tier every sweep
  // until midnight.
  if (decision.reason.startsWith(DAILY_HANDOFF_REASON_PREFIX)) {
    lastDailyHandoff.set(name, nowMs)
    dailySkipped.delete(name)
  }

  // Same decision-time marking, same reason: advance the record only once
  // decideGuard has actually acted on the card change, so a sweep where a
  // higher-ranked tier or phase pre-empted this branch leaves it due again on
  // the next sweep instead of silently consuming the signal.
  if (decision.reason === NEW_CARD_DISPATCH_REASON_PREFIX && dispatchedCardIdForGuard !== null) {
    lastDispatchedCard.set(name, dispatchedCardIdForGuard)
  }

  // Post-respawn grace for the main session. Making the Linux restart path work
  // (above) also makes it repeatable: measured on 2026-07-26, the saturation net
  // fresh-restarted main five times in one morning, so the agent lost its
  // conversation roughly every half hour. Two causes of a redundant restart,
  // both covered by the same stamp: a session that is still BOOTING can read as
  // saturated/idle again on the next sweep, and ANOTHER respawner (the
  // channel-monitor down-cascade, the auto-restart runner, channel-watchdog.sh)
  // may have just restarted main for its own reasons.
  //
  // Same mechanism every other respawner already shares -- lastMainRespawnAt()
  // plus MARVEEN_POST_RESPAWN_GRACE_MS -- so there is no new tunable and no new
  // number; see the identical gate in stuck-tool-call-watcher.ts. Main only: the
  // stamp describes the main channels session, and a sub-agent restart is
  // cheap and independently coordinated.
  //
  // The state must NOT advance here. decideGuard() has already produced
  // nextState = await-ready; committing that while skipping the restart would
  // leave the machine believing main was restarted, and the next sweep would
  // inject a "continue from your handoff" resume prompt into the SAME saturated
  // pane -- the guard would consume its own recovery and never retry. Keeping
  // the previous state means the next sweep re-decides, and the restart happens
  // once the grace has elapsed.
  if (decision.action === 'restart' && name === MAIN_AGENT_ID) {
    const lastRespawn = lastMainRespawnAt()
    if (shouldDeferForRecentRespawn(lastRespawn, nowMs)) {
      logger.info(
        { name, sinceRespawnMs: lastRespawn ? nowMs - lastRespawn : null, graceMs: MARVEEN_POST_RESPAWN_GRACE_MS },
        'context-guard: recent main respawn within grace, deferring restart (avoid restart loop / boot churn)',
      )
      guardStates.set(name, state)
      return
    }
  }

  guardStates.set(name, decision.nextState)
  // Leaving await-ready WITHOUT delivering (ready timeout, guard disabled
  // mid-wait) ends the obligation too; delivery clears it in inject-resume.
  if (state.phase === 'await-ready' && decision.nextState.phase !== 'await-ready' && decision.action !== 'inject-resume') {
    dropPendingResume(name, decision.reason)
  }
  if (decision.action === 'none') {
    if (decision.reason === RESUME_GIVE_UP_REASON) await reportResumeGiveUp(name)
    if (decision.reason.startsWith(BUSY_OVERDUE_REASON_PREFIX)) logger.warn({ name, reason: decision.reason }, 'context-guard: pane still busy far past the handoff deadline -- restart stays deferred')
    // Idle-flush non-decisions carry the measurement that blocked them
    // ("quiet for only 4m of 20m"), which is the only way to see the tier
    // failing to reach its threshold. It matters because the idle clock is the
    // transcript mtime and a SCHEDULED wake resets it: an agent whose schedule
    // period is shorter than idleMinutes can never accumulate enough quiet, and
    // without this line that reads as "the tier is fine, nothing to flush".
    if (decision.reason.startsWith(IDLE_FLUSH_REASON_PREFIX)) {
      logger.debug(
        { name, reason: decision.reason, contextTokens: inputs.contextTokens, idleMs: inputs.idleMs },
        'context-guard: idle-flush not acting',
      )
    }
    return
  }

  const pctRound = inputs.pct !== null ? Math.round(inputs.pct * 100) : null
  logger.info({ name, action: decision.action, reason: decision.reason, pct: pctRound, bannerRaw: paneSaturatedRaw, bannerTrusted: paneSaturatedTrusted, measuredPct: measuredPct !== null ? Math.round(measuredPct * 100) : null }, 'context-guard: acting')

  // A re-send after a usage limit is worded exactly like the request the limit
  // refused, so the prompt is picked by the ORIGINAL reason. decision.reason is
  // still what the daily-slot bookkeeping above saw, so a re-sent daily request
  // does not count as a new slot. decideGuard emits it at most once per
  // parking episode, so this line is once per episode too.
  const resend = decision.reason.startsWith(HANDOFF_RESEND_REASON_PREFIX)
  const promptReason = resend ? (state.handoffRequestReason ?? '') : decision.reason
  if (resend) {
    logger.info(
      { name, session, originalReason: state.handoffRequestReason ?? null, deadlineMs: decision.nextState.deadlineMs },
      'context-guard: usage limit lifted during await-handoff with no handoff written -- re-sending the refused handoff request, timeout window restarted',
    )
  }

  try {
    switch (decision.action) {
      case 'request-handoff':
        // Through the authenticated-directive primitive, not bare
        // sendPromptToSession -- this text asks the agent to drop work and
        // STOP, which without a queue anchor is indistinguishable from a
        // prompt injection.
        await sendSystemDirective(
          name,
          session,
          promptReason.startsWith(STALE_REFRESH_REASON_PREFIX)
            // The handoff exists but went stale while we waited for an idle
            // pane; ask for a refresh, not a first write.
            ? staleRefreshHandoffPrompt(((sm) => typeof sm === 'number' ? sm : 0)(handoffStaleMinutes(inputs)), handoffPathFor(name))
            : promptReason.startsWith(IDLE_FLUSH_REASON_PREFIX)
              // pct is null whenever the idle tier runs without the proactive
              // tiers, so the alarming percentage-based prompt would read "~0%
              // -- critical". The idle tier states the token count it measured.
              ? idleFlushHandoffPrompt(inputs.contextTokens ?? 0, cfg.idleMinutes, handoffPathFor(name))
              : promptReason.startsWith(DAILY_HANDOFF_REASON_PREFIX)
                // Same trap as the idle tier: pct is null for a daily-only
                // agent, so the percentage prompt would announce "~0% --
                // critical" at 04:00 to a session that is perfectly healthy.
                ? dailyHandoffPrompt(cfg.dailyHandoffTime ?? '', handoffPathFor(name))
                : promptReason === NEW_CARD_DISPATCH_REASON_PREFIX
                  // Same trap again: pct may be null or low for a session
                  // that is perfectly healthy and simply about to start a
                  // different card.
                  ? newCardDispatchHandoffPrompt(handoffPathFor(name), inputs.newCardId, inputs.newCardTitle)
                  : handoffPrompt(pctRound ?? 0, handoffPathFor(name)),
        )
        break
      case 'restart': {
        // A forced restart must never be silent: the supervisor has to know
        // that prompts delivered to the OLD session (queued steering input,
        // parked text, the handoff request itself) may have died with it
        // (2026-07-27: two dispatched instructions lost this way). Snapshot
        // the pane first for post-mortem, then restart, then report on the
        // inter-agent queue -- the channel supervisors actually read.
        let snapshotPath: string | null = null
        try {
          const finalPane = pane ?? capturePane(session)
          if (finalPane) {
            snapshotPath = join(PROJECT_ROOT, 'store', `context-guard-last-pane-${name}.txt`)
            writeFileSync(snapshotPath, finalPane)
          }
        } catch (err) {
          logger.warn({ err, name }, 'context-guard: pre-restart pane snapshot failed')
        }
        try {
          await performRestart(name)
          // The streak is over: only a rescue that actually ran clears it.
          clearRescueFailures(name)
          // Persisted only AFTER the restart succeeded, so a
          // failed rescue (rolled back below) never leaves an obligation that
          // would send "continue from your handoff" into the OLD pane.
          recordPendingResume(name, {
            restartedAtMs: Date.now(),
            handoffStaleMinutes: decision.nextState.handoffStaleMinutes,
            reason: decision.reason,
          })
        } catch (err) {
          // guardStates was advanced to the post-restart phase BEFORE this
          // switch, so a failed rescue would otherwise be filed as a completed
          // one: the guard would wait for a session it never started, inject a
          // resume prompt into the old saturated pane, and then sit out its
          // cooldown. Roll the state back so the next sweep re-measures and
          // retries, and never claim the restart on the message queue.
          guardStates.set(name, INITIAL_GUARD_STATE)
          const { count, alert: shouldAlert } = recordRescueFailure(name, nowMs)
          logger.error({ err, name, reason: decision.reason, consecutiveFailures: count }, 'context-guard: rescue restart FAILED -- state rolled back for retry')
          // Honest and silent is still silent. A saturated pane cannot be
          // prompted (dispatch refuses it), so an agent whose rescue keeps
          // failing is unreachable, and the only thing that knows is this log
          // line. Escalate on the third consecutive failure, then hourly.
          if (shouldAlert) {
            try {
              // The alert sink must never be the patient's own inbox. For the
              // MAIN agent a queue message would be addressed to the very agent
              // whose rescue keeps failing -- main-agent delivery is pull-based,
              // and a saturated main does not pull, so the alert would sit
              // "pending" exactly when it matters (measured 2026-09-08: main
              // saturated twice that day). Route the main-agent case to the
              // operator notification channel instead.
              if (name === MAIN_AGENT_ID) {
                await notifyChannel(
                  `[CONTEXT-GUARD] ${count}. EGYMAST KOVETO bukott mentes a FO-AGENSNEL (${name}). ` +
                  `Ok: ${decision.reason}` + (pctRound !== null ? ` (kontextus ~${pctRound}%)` : '') +
                  `. Utolso hiba: ${err instanceof Error ? err.message : String(err)}. ` +
                  'A guard kb. 10 percenkent ujraprobalja; ez a riasztas orankent ismetlodik, amig tart.',
                )
              } else {
              const msg = createAgentMessage(
                name,
                MAIN_AGENT_ID,
                `[CONTEXT-GUARD] ${count}. EGYMAST KOVETO bukott mentes a(z) "${name}" agensnel. ` +
                `Ok: ${decision.reason}` + (pctRound !== null ? ` (kontextus ~${pctRound}%)` : '') +
                `. Utolso hiba: ${err instanceof Error ? err.message : String(err)}. ` +
                'A szaturalt pane-t NEM lehet prompttal elerni (a dispatch visszautasitja), tehat ' +
                'ez az agens addig elerhetetlen, amig a restart nem sikerul. A guard kb. 10 percenkent ' +
                'ujraprobalja magatol, es ez a riasztas orankent ismetlodik, amig tart. Amit nezz meg: ' +
                `fut-e a tmux session (agent-${name}), mit mutat a store/context-guard-last-pane-${name}.txt, ` +
                "es a dashboard.log 'rescue restart FAILED' / 'lost the start race' sorai.",
                'context-guard rescue failure alert',
              )
              if (!msg?.id) throw new Error('createAgentMessage returned no id')
              }
            } catch (alertErr) {
              // The alert is the last channel out of a silent failure; losing it
              // without a trace would restore exactly the silence it exists for.
              logger.error({ err: alertErr, name, consecutiveFailures: count }, 'context-guard: FAILED TO RAISE the rescue-failure alert')
            }
          }
          break
        }
        try {
          createAgentMessage(
            name,
            MAIN_AGENT_ID,
            `[CONTEXT-GUARD] Ujrainditottam a(z) "${name}" agentet -- ok: ${decision.reason}` +
            (pctRound !== null ? ` (kontextus ~${pctRound}%)` : '') +
            // The idle-flush origin comes from the SEQUENCE state: decision.reason
            // here is the restart's own ("handoff written"), never idle-flush.
            restartLossLine(state.idleFlushSequence === true, onWorksource(name), cfg.idleMinutes, restartQueueAtRestart(name)) +
            (typeof decision.nextState.handoffStaleMinutes === 'number'
              // The queue line alone invites the wrong conclusion when the
              // real gap is the ARTIFACT: say explicitly
              // that the handoff does not cover the tail of the session.
              ? ` FIGYELEM: a HANDOFF.md ELAVULT -- az utolso ~${decision.nextState.handoffStaleMinutes} perc munkaja nincs benne, a friss session ezt a szakaszt az elo forrasokbol kapja meg.`
              : decision.nextState.handoffStaleMinutes === 'unknown'
                // The supervisor's manual state-handoff decision runs on this
                // line (2026-08-17: a hand-measured mtime saved a payment-PR
                // verdict); a silent unknown would read as "all fine" to the
                // one reader who could compensate.
                ? ` FIGYELEM: a HANDOFF.md letezik, de a FRISSESSEGET NEM TUDTAM MERNI (transcript-ora olvashatatlan) -- ha a session-ben friss dontes szuletett, kezi allapot-ellenorzes ajanlott (mtime vs. utolso munka).`
                : '') +
            (snapshotPath ? ` Pane-snapshot a restart elotti allapotrol: ${snapshotPath}` : ''),
            'context-guard restart notice',
          )
        } catch (err) {
          logger.warn({ err, name }, 'context-guard: restart notice message failed')
        }
        break
      }
      case 'inject-resume': {
        const hadHandoff = inputs.handoffMtime !== null || handoffMtime(name) !== null
        // Staleness was measured at RESTART time and rode here in the state;
        // measuring now would be meaningless (the old session is gone).
        // GUARDHITELES903: anchored like the handoff request -- the resume
        // prompt steers a fresh session's entire first turn.
        let outcome: Awaited<ReturnType<typeof sendSystemDirective>>
        resumeSending.add(name)
        try {
          outcome = await sendSystemDirective(
            name,
            session,
            state.handoffRequestReason?.startsWith(NEW_CARD_DISPATCH_REASON_PREFIX)
              // This tier's own wording (CYBERSEC F2, comment 31757):
              // resumePrompt's "context grew too large" is false here.
              ? newCardDispatchResumePrompt(name, handoffPathFor(name), hadHandoff, state.newCardId ?? null, state.newCardTitle ?? null)
              : resumePrompt(name, handoffPathFor(name), hadHandoff, state.handoffStaleMinutes),
          )
        } catch (err) {
          // Not retried: a throw from the tmux layer can come after part of
          // the text already landed, and a second copy is worse than none.
          dropPendingResume(name, 'resume delivery threw')
          throw err
        } finally {
          resumeSending.delete(name)
        }
        if (outcome === 'sent') {
          dropPendingResume(name, 'resume delivered')
          appendRestartLogEntry(name, hadHandoff, state.handoffStaleMinutes)
        } else {
          // Nothing was injected ('aborted-busy' / 'skipped-locked'): keep
          // the obligation and stay in await-ready, so the next sweep retries
          // until the phase deadline instead of silently cooling down.
          guardStates.set(name, state)
          logger.warn({ name, outcome }, 'context-guard: resume prompt NOT injected -- retrying on the next sweep')
        }
        break
      }
    }
  } catch (err) {
    logger.warn({ err, name, action: decision.action }, 'context-guard: action failed')
  }
}

/** Live status for the dashboard/API. */
export async function getContextGuardStatus(): Promise<Array<{
  agent: string
  phase: string
  pct: number | null
  enabled: boolean
  saturationRestart: boolean
  cooldownUntilMs?: number
}>> {
  const names = [MAIN_AGENT_ID, ...listAgentNames()]
  // MERGE UNION (B-wave, card 42938a74): upstream's cooldownUntilMs field and its `state` hoist are
  // adopted, but the listing stays ASYNC -- measurePct returns a Promise in this fork, so upstream's
  // synchronous map would have put a Promise object in every `pct`.
  return Promise.all(names.map(async (name) => {
    const state = guardStates.get(name)
    const cfg = readContextGuardConfig(name)
    const remote = name !== MAIN_AGENT_ID && !!readAgentRemoteHost(name)
    return {
      agent: name,
      phase: state?.phase ?? 'idle',
      // Koteg 24 (card 57044a66): learn:false -- this is a read-only status listing, not the
      // guard's own sweep; it must not feed its reading into the per-agent high-water mark
      // (observedHighwater), or opening the dashboard status page would itself widen the
      // learned context window.
      pct: cfg.enabled && !remote ? await measurePct(name, cfg.limitTokens, { learn: false }) : null,
      enabled: cfg.enabled,
      saturationRestart: cfg.saturationRestart,
      ...cooldownStatusExtra(state),
    }
  }))
}

/** CGBADGE908: in cooldown the UI shows the REMAINING TIME, because that is
 * what the word promises -- the badge used to append the context pct instead,
 * and "cooldown 19%" read as a cooldown position. The field is sent ONLY in
 * the cooldown phase so no consumer mistakes a stale timestamp for a live
 * timer. Exported so the test pins both branches. */
export function cooldownStatusExtra(
  state: { phase: string; cooldownUntilMs: number } | undefined,
): { cooldownUntilMs?: number } {
  return state?.phase === 'cooldown' && state.cooldownUntilMs > 0
    ? { cooldownUntilMs: state.cooldownUntilMs }
    : {}
}

/**
 * Who the saturation net sweeps: the main agent plus EVERY agent directory,
 * dashboard-hidden technical workers included.
 *
 * Deliberately listAllAgentNames(), not listAgentNames(). A hidden worker is
 * hidden from the OPERATOR, not from the fleet's life support: it runs a real
 * Claude session that can wedge at 100% context exactly like a visible agent,
 * and when it does, this sweep is the only thing that can free it. The hourly
 * heartbeat proved it on 2026-08-04 -- agents/heartbeat wedged, was invisible
 * to this sweep, and the schedule runner's (correct) "defer instead of
 * injecting into a wedged session" turned into an unbounded wait.
 *
 * Exported so the regression test can assert the SET rather than reach into a
 * timer: narrowing this back to listAgentNames() must fail a test, not a
 * production heartbeat.
 *
 * Deduplicated, main first. On an install where agents/<MAIN_AGENT_ID> exists
 * as a real directory (ours does) the main agent appears twice -- once
 * explicitly, once from the listing -- and checkAgent would run its whole
 * decision on it twice per sweep. That is exactly the agent where a doubled
 * decision is least welcome, so the canonical "who do we sweep" answer is a
 * set, not a concatenation.
 */
export function guardSweepAgentNames(): string[] {
  return [...new Set([MAIN_AGENT_ID, ...listAllAgentNames()])]
}

/**
 * Current phase of the hard context-guard for this agent. Returns 'idle' when
 * no state has been recorded. The gate runner uses this for its interlock: when
 * the hard guard is in 'await-handoff' or 'await-ready', the soft gate steps
 * aside so both mechanisms never simultaneously touch the pane.
 */
export function getHardGuardPhase(name: string): string {
  return guardStates.get(name)?.phase ?? 'idle'
}

// The hold end already reported as lapsed, per agent: one warn per hold, not one
// per router tick. One entry per agent, so it cannot grow with time.
const lapsedHoldLogged = new Map<string, number>()

function lapsed(name: string, phase: string, untilMs: number, nowMs: number): null {
  if (lapsedHoldLogged.get(name) !== untilMs) {
    lapsedHoldLogged.set(name, untilMs)
    logger.warn({ name, phase, overdueMs: nowMs - untilMs }, 'context-guard: delivery hold lapsed past the phase deadline -- delivering to this agent again (fail-open)')
  }
  return null
}

/**
 * The message router's delivery hold for this agent (delivery-hold.ts): from the
 * handoff request until the fresh session has its resume prompt.
 *
 * - A resume prompt being typed right now holds, whatever the phase: the sweep's
 *   inject-resume has already moved the state to cooldown when it sends, so this
 *   is the one stretch the phase does not cover, and a message pasted now would
 *   land in front of the resume. Bounded by how long a resume can be owed at all
 *   (the obligation's restart time + PENDING_RESUME_TTL_MS + one sweep), which
 *   covers both the in-run ready deadline and the longer one a restored
 *   obligation gets: a send that never returns must not keep the inbox shut.
 * - await-handoff and await-ready hold until the phase deadline plus one sweep.
 *   The end is fixed by the deadline, never by `now`: a phase can outlast its
 *   deadline (a deferral keeps await-handoff past it), and a hold renewed from
 *   `now` on every look would last exactly as long as that does. Past it the hold
 *   lapses, with one warn, and the agent's rows flow again (fail-open).
 */
export function contextGuardDeliveryHold(name: string, nowMs: number): DeliveryHold | null {
  if (resumeSending.has(name)) {
    const owed = pendingResumes[name]
    // No owed resume while one is being sent should not happen; if it does, hold nothing.
    if (!owed) return null
    const untilMs = owed.restartedAtMs + PENDING_RESUME_TTL_MS + INTERVAL_MS
    return nowMs < untilMs ? { phase: 'resume-sending', untilMs } : lapsed(name, 'resume-sending', untilMs, nowMs)
  }
  const st = guardStates.get(name)
  if (!st || (st.phase !== 'await-handoff' && st.phase !== 'await-ready')) return null
  const untilMs = st.deadlineMs + INTERVAL_MS
  return nowMs < untilMs ? { phase: st.phase, untilMs } : lapsed(name, st.phase, untilMs, nowMs)
}

export function startContextGuardRunner(): NodeJS.Timeout {
  // Before anything can put an agent into a restart sequence -- including the
  // await-ready states re-armed just below.
  setDeliveryHoldProbe(contextGuardDeliveryHold)
  // Before the first sweep can run, so an agent restarted by the
  // previous dashboard process is not re-armed at 'idle' and left without its
  // resume prompt.
  try { restorePendingResumes(Date.now()) }
  catch (err) { logger.warn({ err }, 'context-guard: pending-resume restore failed') }
  let tickRunning = false
  async function sweep() {
    // Re-entrancy guard: checkAgent's 'restart' action now awaits a real
    // restartAgentProcess (no longer a blocking execSync('sleep N')), so a
    // sweep with a restart in flight can still be running when the next
    // interval fires. Skip an overlapping tick; the next tick re-evaluates
    // every agent, so nothing is missed.
    if (tickRunning) {
      logger.debug('context-guard: previous sweep still running, skipping this tick')
      return
    }
    tickRunning = true
    try {
      const now = Date.now()
      // The agents/ namespace tripwire rides THIS sweep rather than owning a timer: it needs the
      // same cadence, and the sweep already holds the db handle the alert needs. The listing
      // function itself stays pure (card 53c59307) precisely so this stays the only alerting site.
      try { sweepAgentDirTripwire(createAgentMessage) } catch (err) {
        logger.debug({ err }, 'agent-dir-tripwire: sweep error')
      }
      for (const name of guardSweepAgentNames()) {
        try { await checkAgent(name, now) } catch (err) { logger.debug({ err, agent: name }, 'context-guard: agent check error') }
      }
    } finally {
      tickRunning = false
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(whileNotFrozen('context-guard', sweep), INTERVAL_MS)
}
