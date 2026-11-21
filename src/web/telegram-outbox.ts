// Card ea3e7316 (F2 Durable Telegram outbox with receipts, dsh Outbox idea --
// reimplemented on our stack, no code vendored).
//
// Outgoing Telegram sends from the fallback path (scripts/hooks/telegram_fallback_send.py,
// used when the in-session reply tool's MCP plugin has dropped) go into a durable SQLite
// queue (telegram_outbox, src/db.ts) first, instead of being lost if the channel process
// dies mid-send (card f490ae53: the fleet tmux server died 8x in one day and killed the
// live Telegram poller each time). The queue lives in the SAME db file the always-on
// dashboard server already owns, so a drain tick picks a pending row back up after a
// restart exactly as it would have before one -- "survives a restart" is a property of
// where the state lives, not of anything this module does at restart time.
//
// CONSTRAINT (Peti 14288, card body): additive only. The reply tool and
// telegram_fallback_send.py's existing direct-send path both stay as-is; this is a NEW
// path, default OFF (MIKROB_TG_OUTBOX env flag), used by the fallback sender FIRST (other
// call sites are future rounds, not this one).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { channelStateDir, type ChannelProviderType } from '../channel-provider.js'
import { readFileOr } from './agent-config.js'
import { sendTelegramMessage } from './telegram.js'
import { normalizeChatId } from '../owner-chat.js'
import { ALLOWED_CHAT_ID } from '../config.js'
import {
  listDueTelegramOutbox, markTelegramOutboxSent, markTelegramOutboxFailed,
  markTelegramOutboxTerminallyFailed, redactStaleTelegramOutboxText,
} from '../db.js'
import { logger } from '../logger.js'

export const OUTBOX_FLAG_ENV = 'MIKROB_TG_OUTBOX'

export function isTelegramOutboxEnabled(): boolean {
  return process.env[OUTBOX_FLAG_ENV] === '1'
}

const BASE_DELAY_MS = 5_000
const MAX_DELAY_MS = 300_000

/**
 * 5s, 10s, 20s, ... doubling, capped at 300s (the card's own numbers).
 * `attempts` is the failure count AFTER the attempt this delay follows
 * (1-based): nextRetryDelayMs(1) is the delay after the FIRST failure.
 */
export function nextRetryDelayMs(attempts: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, Math.max(0, attempts - 1))
  return Math.min(delay, MAX_DELAY_MS)
}

// Telegram bot tokens look like "<digits>:<30+ url-safe chars>" -- the one secret this
// module ever touches. sendTelegramMessage's thrown errors only ever carry an HTTP status
// and response body text (never the request URL the token sits in -- see telegram.ts), so
// this should never actually match anything live; it exists as defense in depth against a
// future error path that is less careful, per the card's "token never in argv or logs" ask.
const TOKEN_SHAPE_RX = /\d{6,}:[A-Za-z0-9_-]{30,}/g
const MAX_STORED_ERROR_LEN = 500

export function sanitizeOutboxError(message: string): string {
  return message.replace(TOKEN_SHAPE_RX, '<redacted>').slice(0, MAX_STORED_ERROR_LEN)
}

/**
 * Is `chatId` a chat this install actually knows about (CYBERSEC/CYBERED
 * NO-GO 35157 F-C, RedHat 22517)? Before this, any dashboard-token holder
 * could enqueue a send to an ARBITRARY chat_id through the main bot --
 * the outbox's own validation only checked shape (string/number), never
 * membership. The allowlist is the SAME set the channel plugin already
 * trusts for inbound: the configured owner chat (ALLOWED_CHAT_ID) plus
 * every id in access.json's allowFrom/groups/channels (the exact
 * heuristic resolveOwnerChatId already uses) -- not a new, separate trust
 * boundary.
 */
export function isAllowedOutboxChatId(
  chatId: string,
  readAccessFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
  configured: string | null = ALLOWED_CHAT_ID,
  provider: ChannelProviderType = 'telegram',
): boolean {
  const target = normalizeChatId(chatId)
  if (!target) return false
  if (normalizeChatId(configured) === target) return true
  try {
    const raw = JSON.parse(readAccessFile(join(channelStateDir(provider), 'access.json'))) as Record<string, unknown>
    if (Array.isArray(raw.allowFrom)) {
      for (const entry of raw.allowFrom) {
        if (normalizeChatId(typeof entry === 'number' ? String(entry) : (entry as string)) === target) return true
      }
    }
    for (const mapKey of ['groups', 'channels'] as const) {
      const map = raw[mapKey]
      if (!map || typeof map !== 'object') continue
      for (const key of Object.keys(map as Record<string, unknown>)) {
        if (normalizeChatId(key) === target) return true
      }
    }
  } catch {
    // No access.json / unreadable / not JSON: nothing else to allow.
  }
  return false
}

function readMarveenTelegramToken(): string | null {
  // Same resolution as readMarveenTelegramConfig/refreshMarveenBotUsername in telegram.ts.
  const envPath = join(channelStateDir('telegram'), '.env')
  const match = readFileOr(envPath, '').match(/TELEGRAM_BOT_TOKEN=(.+)/)
  return match?.[1]?.trim() || null
}

export type TelegramSender = (chatId: string, text: string) => Promise<number | null>

function realSender(): TelegramSender {
  return async (chatId, text) => {
    const token = readMarveenTelegramToken()
    if (!token) throw new Error('telegram-outbox: no TELEGRAM_BOT_TOKEN configured for this install')
    return sendTelegramMessage(token, chatId, text)
  }
}

const HEALTH_WARN_AT_ATTEMPTS = 3

/**
 * Give-up threshold (CYBERSEC/CYBERED NO-GO 35157 F-F, RedHat 22517): a row
 * that is still failing after this many consecutive attempts goes terminal
 * ('failed') instead of retrying every 300s forever. Not specified
 * numerically by the finding; chosen so a row gets a real chance to recover
 * from a transient outage (health warning already fires at 3) before giving
 * up -- roughly 20 minutes of total backoff at the 5s/300s-capped schedule.
 */
export const MAX_ATTEMPTS = 10

/**
 * Drains every row currently due, once. `sender` is injectable for tests;
 * production goes through startTelegramOutboxDrain(), which supplies the real
 * one and also holds the single-flight guard (CYBERED NO-GO 35157 B1: a bare
 * setInterval does NOT wait for a slow send -- a 25s call left 3 overlapping
 * ticks all draining the same still-pending row, 3 sends for 1 row).
 */
export async function drainTelegramOutboxOnce(sender: TelegramSender, now = Date.now()): Promise<void> {
  for (const row of listDueTelegramOutbox(now)) {
    try {
      const messageId = await sender(row.chat_id, row.text)
      markTelegramOutboxSent(row.id, messageId, Date.now())
    } catch (err) {
      const newAttempts = row.attempts + 1
      const raw = err instanceof Error ? err.message : String(err)
      const sanitized = sanitizeOutboxError(raw)
      if (newAttempts >= MAX_ATTEMPTS) {
        markTelegramOutboxTerminallyFailed(row.id, sanitized)
        logger.warn({ outboxId: row.id, chatId: row.chat_id, attempts: newAttempts }, 'telegram-outbox: giving up after max consecutive failures, marking failed (terminal)')
        continue
      }
      markTelegramOutboxFailed(row.id, sanitized, Date.now() + nextRetryDelayMs(newAttempts))
      // Fires exactly once per row, at the moment it crosses 3 consecutive failures
      // (attempts only increases for a row that hasn't succeeded yet -- a row that
      // succeeds leaves listDueTelegramOutbox's result for good) -- not on every tick
      // after, which would just be log noise for a queue that keeps retrying anyway.
      if (newAttempts === HEALTH_WARN_AT_ATTEMPTS) {
        logger.warn({ outboxId: row.id, chatId: row.chat_id, attempts: newAttempts }, 'telegram-outbox: 3 consecutive delivery failures, still retrying')
      }
    }
  }
}

/**
 * Retention (CYBERSEC/CYBERED NO-GO 35157 F-G, RedHat 22517): clears the
 * message TEXT of terminal (sent/failed) rows older than this, keeping the
 * receipt metadata. Not specified numerically by the finding; 24h is chosen
 * as a generous window to inspect a recent delivery/failure before the body
 * is redacted.
 */
export const TEXT_RETENTION_MS = 24 * 60 * 60 * 1000

const DRAIN_INTERVAL_MS = 10_000

/**
 * Starts the drain interval when MIKROB_TG_OUTBOX=1, else does nothing (the
 * flag's whole point: zero behaviour change by default). Mirrors the
 * webOnly-gated start*() functions in web.ts (startMessageRouter et al.).
 *
 * `sender` is injectable for tests (production omits it and gets realSender()).
 *
 * Single-flight guard (CYBERED NO-GO 35157 B1): a tick that fires while the
 * PREVIOUS drain is still running (a slow send outliving the 10s interval) is
 * a no-op, not a second overlapping drain -- otherwise the same still-pending
 * row gets sent again by every tick that fires before the first send settles.
 */
export function startTelegramOutboxDrain(sender: TelegramSender = realSender()): ReturnType<typeof setInterval> | undefined {
  if (!isTelegramOutboxEnabled()) return undefined
  let draining = false
  return setInterval(() => {
    if (draining) return
    draining = true
    drainTelegramOutboxOnce(sender)
      .catch((err) => logger.warn({ err }, 'telegram-outbox: drain tick failed'))
      .finally(() => { draining = false })
    // Cheap (small table, indexed by status), so it rides the same tick as the
    // drain rather than needing its own interval -- F-G retention.
    redactStaleTelegramOutboxText(Date.now(), TEXT_RETENTION_MS)
  }, DRAIN_INTERVAL_MS)
}
