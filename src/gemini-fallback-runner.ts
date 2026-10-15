// Gemini fallback RUNNER (card 5f5409fd).
//
// What this does: every 15 minutes, reads the fleet's weekly-usage state and
// the Gemini key from the vault, calls decideGeminiFallback (pure logic), and
// on a route switch sends a Telegram notification and persists the new state.
//
// WHY THIS IS SEPARATE FROM the decision module: decideGeminiFallback is
// dependency-free (testable without I/O). This runner is the I/O side --
// state files, vault, Telegram, network -- exactly as the module's header says.
//
// claudeExhausted mapping (card 3de7d530): by default also engages at the
// 85% "new-dev-stop" threshold (weekly-hard-stop.json `newDevStopActive`), not
// only at the 98% hard stop (`active`) -- Peti 11057: in-flight/gate work is
// still Claude, but a card that would otherwise sit idle under the stop can be
// drafted on Gemini instead. Configurable via gemini-fallback-config.json
// (`engageOn: "newDevStop" | "hardStopOnly"`); missing/invalid file defaults
// to "newDevStop", the requested default. We do NOT require the model-fallback
// chain to have bottomed out (that is a separate, shorter-window mechanism).
//
// Key validation: the vault entry for the Gemini key is `integration.gemini.apiKey`.
// We validate with a REAL API call (GET /v1beta/models) and cache the result for
// KEY_VALIDATION_TTL_MS. A bad/missing key never triggers engagement; the fail-safe
// bias is toward Claude, not toward silently looking covered.
//
// CYBERED NO-GO on card 3de7d530 (comment 17031), fixed here:
//   F1 -- the key-validity cache used to be keyed purely on elapsed time, not on
//   WHICH key was checked, and a future-dated `lastKeyCheck`/`engagedAt` in the
//   state file (tampered or a clock step backwards) made `now - lastKeyCheck`
//   negative forever, so the key was NEVER re-validated. Fixed with three changes:
//   the vault key is read fresh every run and an empty key is invalid immediately
//   (no network call needed for that); the cache is bound to a sha256 fingerprint
//   of the actual key validated, so a rotated key can never inherit the old key's
//   cached verdict; and `lastKeyCheck`/`engagedAt` are clamped to `now` on read,
//   so a future-dated value can never suppress a recheck or pin the route.
//   F2 -- `MIN_ENGAGEMENT_MS` (10 min) was shorter than this runner's own 15-minute
//   schedule, so the anti-flap window never actually bound in practice. Raised to
//   45 min (3x the schedule) so it does.
//
// State file: store/gemini-fallback-state.json -- persists across restarts.
// Telegram: sent via the Bot API (BOT_TOKEN + ALLOWED_CHAT_ID from .env), the
// same mechanism update-health-watchdog.sh uses. Key NEVER in the message.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decideGeminiFallback,
  switchNotification,
  type FallbackRoute,
  type GeminiFallbackFacts,
} from './gemini-fallback.js'
import {
  validateGeminiKey,
  DEFAULT_GEMINI_MODEL,
  GEMINI_VAULT_KEY_ID,
} from './gemini-client.js'
import { readEnvFile } from './env.js'
import { getSecret } from './web/vault.js'
import { runDraftCleanupSweep } from './gemini-orchestrator-draft-cleanup.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const STORE = join(ROOT, 'store')

const STATE_PATH = join(STORE, 'gemini-fallback-state.json')
const WEEKLY_HARD_STOP_PATH = join(STORE, 'weekly-hard-stop.json')
const ENGAGE_CONFIG_PATH = join(STORE, 'gemini-fallback-config.json')
const SESSION_OUTAGE_PATH = join(STORE, 'mikrob-session-outage.json')
// H2 (WhiteHat2 NO-GO, card 612058c2 delta-gate @c5e5ec28): how stale a heartbeat may be before
// the marker is no longer trusted. Generous relative to quota-bridge.py's outage_loop refresh
// cadence (roughly once per Telegram long-poll cycle, tens of seconds), but far short of
// "forever" -- the failure mode this closes is a SIGKILL/OOM/host-restart that leaves the file
// behind with nothing left alive to clear it.
const SESSION_OUTAGE_STALE_MS = 15 * 60 * 1000

export type GeminiEngageOn = 'newDevStop' | 'hardStopOnly'

// F2 (Cybered NO-GO 17031): raised from 10 min so the window is actually wider than this
// runner's own 15-minute schedule (3x headroom), not narrower than it.
const MIN_ENGAGEMENT_MS = 45 * 60 * 1000  // 45 min anti-flap
const KEY_VALIDATION_TTL_MS = 60 * 60 * 1000  // re-validate key once per hour

export interface GeminiFallbackState {
  route: FallbackRoute
  engagedAt: number | null
  lastKeyCheck: number | null
  keyValid: boolean
  lastRun: number | null
  /** sha256 hex of the vault key the cached `keyValid` verdict actually applies to (F1). */
  keyFingerprint: string | null
}

function fingerprintKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * F1 (Cybered NO-GO 17031, S6a/S6b): a future-dated `lastKeyCheck`/`engagedAt` -- from a
 * tampered state file or a clock step backwards -- must never be trusted at face value.
 * `now - timestamp` would go negative, and BOTH downstream consumers already treat `null` as
 * the safe/"never happened" sentinel (the key-check TTL logic re-checks when `lastKeyCheck`
 * is null; `decideGeminiFallback`'s own anti-flap check treats `engagedAt === null` as
 * "held long enough", i.e. immediately revert-eligible -- see gemini-fallback.ts). So a
 * future-dated value is sanitized to `null`, not clamped to `now` (clamping to `now` would
 * make it look freshly-checked/freshly-engaged, which is the OPPOSITE of what an untrustworthy
 * timestamp should do). Sanitizing on READ (not just on write) means even an externally
 * rewritten state file self-heals on the very next run.
 */
function sanitizeFutureTimestamp(v: number | null, now: number): number | null {
  return v !== null && v > now ? null : v
}

function readState(): GeminiFallbackState {
  const now = Date.now()
  try {
    // Typed as Record<string, unknown>, not the implicit `any` JSON.parse() returns: `unknown`
    // narrows correctly under `typeof`, so the ternaries below are genuinely `number | null`
    // rather than `any` -- lint's no-unsafe-argument rule (the function-argument form of the
    // no-unsafe-assignment family) only objects to the latter.
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as Record<string, unknown>
    return {
      route: raw.route === 'gemini' ? 'gemini' : 'claude',
      engagedAt: sanitizeFutureTimestamp(typeof raw.engagedAt === 'number' ? raw.engagedAt : null, now),
      lastKeyCheck: sanitizeFutureTimestamp(typeof raw.lastKeyCheck === 'number' ? raw.lastKeyCheck : null, now),
      keyValid: raw.keyValid === true,
      lastRun: typeof raw.lastRun === 'number' ? raw.lastRun : null,
      keyFingerprint: typeof raw.keyFingerprint === 'string' ? raw.keyFingerprint : null,
    }
  } catch {
    return { route: 'claude', engagedAt: null, lastKeyCheck: null, keyValid: false, lastRun: null, keyFingerprint: null }
  }
}

function writeState(state: GeminiFallbackState): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
}

function readEngageOn(): GeminiEngageOn {
  try {
    const raw = JSON.parse(readFileSync(ENGAGE_CONFIG_PATH, 'utf-8'))
    return raw.engageOn === 'hardStopOnly' ? 'hardStopOnly' : 'newDevStop'
  } catch {
    return 'newDevStop'
  }
}

/**
 * Card 612058c2: true when quota-bridge.py's Ghost mode has confirmed a Claude SESSION-level
 * quota outage (the 5h usage limit, not the weekly newDevStop/hard-stop threshold this runner
 * otherwise watches). This is a harder signal than newDevStop -- MikroB cannot run AT ALL right
 * now, there is no "in-flight work can still finish on Claude" case -- so it engages regardless
 * of the `engageOn` config, unlike newDevStopActive below. Fail-safe: a missing/corrupt file (the
 * default, healthy state) reads as false, biasing toward Claude exactly like every other read in
 * this module.
 */
/**
 * H2 (WhiteHat2 NO-GO, card 612058c2 delta-gate @c5e5ec28): the marker alone (`active === true`)
 * is not enough -- quota-bridge.py's outage_loop() only clears it in a `finally` block, so a
 * SIGKILL/OOM/host-restart mid-outage leaves `active: true` on disk with no process left alive to
 * ever clear it, and a `Restart=always` unit comes back healthy while this file still says
 * "outage". Before this fix that meant `readClaudeExhausted` stayed permanently true and the
 * fallback route never returned to Claude post-recovery. The marker now also carries a
 * `heartbeat` (unix seconds, refreshed every outage_loop iteration) -- stale beyond
 * {@link SESSION_OUTAGE_STALE_MS} reads as false, the same fail-safe-toward-Claude direction as a
 * missing/corrupt file.
 */
export function readSessionOutageActive(): boolean {
  try {
    const raw = JSON.parse(readFileSync(SESSION_OUTAGE_PATH, 'utf-8')) as Record<string, unknown>
    if (raw.active !== true) return false
    const heartbeat = raw.heartbeat
    if (typeof heartbeat !== 'number' || !Number.isFinite(heartbeat)) return false
    return Date.now() - heartbeat * 1000 <= SESSION_OUTAGE_STALE_MS
  } catch {
    return false
  }
}

/** claudeExhausted fact for decideGeminiFallback, per the engageOn config (see header comment). */
function readClaudeExhausted(engageOn: GeminiEngageOn): boolean {
  let hardStopActive = false
  let newDevStopActive = false
  try {
    const raw = JSON.parse(readFileSync(WEEKLY_HARD_STOP_PATH, 'utf-8'))
    hardStopActive = raw.active === true
    newDevStopActive = raw.newDevStopActive === true
  } catch {
    // missing/corrupt file -> treat as not exhausted (fail toward Claude)
  }
  return hardStopActive || readSessionOutageActive() || (engageOn === 'newDevStop' && newDevStopActive)
}

async function sendTelegram(text: string): Promise<void> {
  const env = readEnvFile(['TELEGRAM_BOT_TOKEN', 'ALLOWED_CHAT_ID'])
  const token = (env['TELEGRAM_BOT_TOKEN'] ?? '').trim()
  const chatId = (env['ALLOWED_CHAT_ID'] ?? '').trim()
  if (!token || !chatId) {
    console.warn('[gemini-runner] Telegram not configured (no BOT_TOKEN or CHAT_ID) -- skip notify')
    return
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[gemini-runner] Telegram ${res.status}: ${body.slice(0, 100)}`)
    }
  } catch (err) {
    console.warn(`[gemini-runner] Telegram send failed: ${err instanceof Error ? err.message : err}`)
  }
}

export async function runGeminiFallbackCheck(
  cleanupSweep: () => void = runDraftCleanupSweep
): Promise<void> {
  const now = Date.now()
  const state = readState()
  const engageOn = readEngageOn()
  const claudeExhausted = readClaudeExhausted(engageOn)

  // F1 (Cybered NO-GO 17031, S4): the vault key is read fresh EVERY run, cheap and local,
  // before any network call -- an empty/missing key is invalid immediately, never from a
  // cache that could still be "valid" from a key that was since deleted or rotated away.
  const apiKey = getSecret(GEMINI_VAULT_KEY_ID) ?? ''
  const currentFingerprint = apiKey ? fingerprintKey(apiKey) : null

  let keyValid = state.keyValid
  let newLastKeyCheck = state.lastKeyCheck
  let newFingerprint = state.keyFingerprint

  if (!apiKey) {
    keyValid = false
    newLastKeyCheck = now
    newFingerprint = null
    console.log('[gemini-runner] No Gemini key in the vault -- invalid.')
  } else {
    // The 1h TTL only governs how often we re-hit the NETWORK for an UNCHANGED key. A
    // fingerprint mismatch (the key was rotated, possibly to a bad value) always forces an
    // immediate recheck regardless of TTL -- the old key's cached verdict never carries over.
    const needsKeyCheck =
      newLastKeyCheck === null ||
      currentFingerprint !== state.keyFingerprint ||
      now - newLastKeyCheck > KEY_VALIDATION_TTL_MS

    if (needsKeyCheck) {
      const result = await validateGeminiKey(apiKey)
      keyValid = result.valid
      newLastKeyCheck = now
      newFingerprint = currentFingerprint
      if (!keyValid) {
        console.log(`[gemini-runner] Key validation failed: ${result.reason} -- ${result.detail ?? ''}`)
      } else {
        console.log('[gemini-runner] Key valid.')
      }
    }
  }

  const facts: GeminiFallbackFacts = {
    enabled: keyValid,  // disabled if key is invalid -- consistent with fail-safe bias
    keyValid,
    claudeExhausted,
    route: state.route,
    engagedAt: state.engagedAt,
    now,
    minEngagementMs: MIN_ENGAGEMENT_MS,
    geminiUnavailable: false,
  }

  const action = decideGeminiFallback(facts)
  console.log(`[gemini-runner] route=${state.route} exhausted=${claudeExhausted} engageOn=${engageOn} keyValid=${keyValid} action=${action.kind}`)

  const newState: GeminiFallbackState = {
    ...state,
    keyValid,
    lastKeyCheck: newLastKeyCheck,
    keyFingerprint: newFingerprint,
    lastRun: now,
  }

  if (action.kind === 'engage') {
    newState.route = 'gemini'
    newState.engagedAt = now
    writeState(newState)
    const msg = switchNotification(action, DEFAULT_GEMINI_MODEL)
    if (msg) await sendTelegram(msg)
    console.log('[gemini-runner] Engaged Gemini fallback.')
  } else if (action.kind === 'revert') {
    newState.route = 'claude'
    newState.engagedAt = null
    writeState(newState)
    const msg = switchNotification(action, DEFAULT_GEMINI_MODEL)
    if (msg) await sendTelegram(msg)
    console.log(`[gemini-runner] Reverted to Claude (reason: ${action.reason}).`)
  } else {
    writeState(newState)
  }

  // Gemini-orch 4/4 (card b8da509b, decision B): "a kvota visszatereserkor... a draft/temp
  // adatokat torlik" -- gated on route==='claude' (post-reset), not just the instant of the
  // revert action, because a role agent's Draft-Review is async and may lag past this exact
  // tick; running every check while we're on the claude route keeps retrying until each draft
  // has actually been adjudicated. Best-effort housekeeping, never allowed to break the real
  // fallback decision above.
  if (newState.route === 'claude') {
    try {
      cleanupSweep()
    } catch (err) {
      console.warn(`[gemini-runner] draft cleanup sweep failed: ${err instanceof Error ? err.message : err}`)
    }
  }
}

// Entry point when run directly: node dist/gemini-fallback-runner.js
if (process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*[/\\]/, '/'))) {
  runGeminiFallbackCheck()
    .then(() => process.exit(0))
    .catch(err => { console.error('[gemini-runner] Fatal:', err); process.exit(1) })
}
