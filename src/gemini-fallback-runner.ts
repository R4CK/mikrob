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
// State file: store/gemini-fallback-state.json -- persists across restarts.
// Telegram: sent via the Bot API (BOT_TOKEN + ALLOWED_CHAT_ID from .env), the
// same mechanism update-health-watchdog.sh uses. Key NEVER in the message.

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

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const STORE = join(ROOT, 'store')

const STATE_PATH = join(STORE, 'gemini-fallback-state.json')
const WEEKLY_HARD_STOP_PATH = join(STORE, 'weekly-hard-stop.json')
const ENGAGE_CONFIG_PATH = join(STORE, 'gemini-fallback-config.json')

export type GeminiEngageOn = 'newDevStop' | 'hardStopOnly'

const MIN_ENGAGEMENT_MS = 10 * 60 * 1000  // 10 min anti-flap
const KEY_VALIDATION_TTL_MS = 60 * 60 * 1000  // re-validate key once per hour

export interface GeminiFallbackState {
  route: FallbackRoute
  engagedAt: number | null
  lastKeyCheck: number | null
  keyValid: boolean
  lastRun: number | null
}

function readState(): GeminiFallbackState {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    return {
      route: raw.route === 'gemini' ? 'gemini' : 'claude',
      engagedAt: typeof raw.engagedAt === 'number' ? raw.engagedAt : null,
      lastKeyCheck: typeof raw.lastKeyCheck === 'number' ? raw.lastKeyCheck : null,
      keyValid: raw.keyValid === true,
      lastRun: typeof raw.lastRun === 'number' ? raw.lastRun : null,
    }
  } catch {
    return { route: 'claude', engagedAt: null, lastKeyCheck: null, keyValid: false, lastRun: null }
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
  return hardStopActive || (engageOn === 'newDevStop' && newDevStopActive)
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

export async function runGeminiFallbackCheck(): Promise<void> {
  const now = Date.now()
  const state = readState()
  const engageOn = readEngageOn()
  const claudeExhausted = readClaudeExhausted(engageOn)

  // Key validation: use cached result unless TTL expired or never checked
  let keyValid = state.keyValid
  let newLastKeyCheck = state.lastKeyCheck
  const needsKeyCheck =
    state.lastKeyCheck === null ||
    now - state.lastKeyCheck > KEY_VALIDATION_TTL_MS

  if (needsKeyCheck) {
    const apiKey = getSecret(GEMINI_VAULT_KEY_ID) ?? ''
    const result = await validateGeminiKey(apiKey)
    keyValid = result.valid
    newLastKeyCheck = now
    if (!keyValid) {
      console.log(`[gemini-runner] Key validation failed: ${result.reason} -- ${result.detail ?? ''}`)
    } else {
      console.log('[gemini-runner] Key valid.')
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
}

// Entry point when run directly: node dist/gemini-fallback-runner.js
if (process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*[/\\]/, '/'))) {
  runGeminiFallbackCheck()
    .then(() => process.exit(0))
    .catch(err => { console.error('[gemini-runner] Fatal:', err); process.exit(1) })
}
