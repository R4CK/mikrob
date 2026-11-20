// Card ea3e7316: the enqueue side of the durable Telegram outbox. See
// ../telegram-outbox.ts for the drain/retry/backoff side -- this file is only the
// HTTP shape for telegram_fallback_send.py to hand a message over.
import { readBody, json } from '../http-helpers.js'
import { enqueueTelegramOutbox } from '../../db.js'
import { isTelegramOutboxEnabled } from '../telegram-outbox.js'
import type { RouteContext } from './types.js'

const MAX_TEXT_LEN = 4096 // Telegram's own sendMessage limit.
const IDEMPOTENCY_KEY_RX = /^[A-Za-z0-9._:-]{1,128}$/

export async function tryHandleTelegramOutbox(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/telegram/outbox' || method !== 'POST') return false

  if (!isTelegramOutboxEnabled()) {
    json(res, { error: 'telegram outbox is disabled on this install (MIKROB_TG_OUTBOX is not set)' }, 503)
    return true
  }

  let body: { chat_id?: unknown; text?: unknown; idempotency_key?: unknown }
  try {
    body = JSON.parse((await readBody(req)).toString())
  } catch {
    json(res, { error: 'Invalid JSON' }, 400)
    return true
  }

  const { chat_id, text, idempotency_key } = body
  if (typeof chat_id !== 'string' && typeof chat_id !== 'number') {
    json(res, { error: 'chat_id is required (string or number)' }, 400)
    return true
  }
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_LEN) {
    json(res, { error: `text is required, 1-${MAX_TEXT_LEN} characters` }, 400)
    return true
  }
  if (typeof idempotency_key !== 'string' || !IDEMPOTENCY_KEY_RX.test(idempotency_key)) {
    json(res, { error: 'idempotency_key is required (1-128 chars, [A-Za-z0-9._:-])' }, 400)
    return true
  }

  const row = enqueueTelegramOutbox(String(chat_id), text, idempotency_key)
  json(res, { id: row.id, status: row.status }, 200)
  return true
}
