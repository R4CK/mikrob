// Card ea3e7316 (F2 Durable Telegram outbox with receipts). Covers:
//  - DB layer: idempotent enqueue (no duplicate row/no reset on a repeat key), due-row
//    selection, sent/failed transitions, and restart-survival (a fresh initDatabase() call
//    against the SAME on-disk file sees exactly what a prior process left behind).
//  - Drain logic: backoff schedule, success/failure transitions, the one-time health warning
//    at exactly 3 consecutive failures, and that the token flag default-off really is a no-op.
//  - The enqueue route: validation, the 503-when-disabled contract, and that posting the same
//    idempotency_key twice never creates a second row.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initDatabase, enqueueTelegramOutbox, getTelegramOutboxRow, listDueTelegramOutbox,
  markTelegramOutboxSent, markTelegramOutboxFailed,
} from '../db.js'

const warnSpy = vi.hoisted(() => vi.fn())
vi.mock('../logger.js', () => ({ logger: { warn: warnSpy, info: () => {}, error: () => {} } }))

import {
  nextRetryDelayMs, sanitizeOutboxError, drainTelegramOutboxOnce, isTelegramOutboxEnabled,
  startTelegramOutboxDrain, OUTBOX_FLAG_ENV, type TelegramSender,
} from '../web/telegram-outbox.js'
import { tryHandleTelegramOutbox } from '../web/routes/telegram-outbox.js'
import type { RouteContext } from '../web/routes/types.js'

beforeEach(() => {
  initDatabase(':memory:')
  warnSpy.mockClear()
  delete process.env[OUTBOX_FLAG_ENV]
})

describe('db layer: enqueueTelegramOutbox', () => {
  it('creates a pending row with attempts=0', () => {
    const row = enqueueTelegramOutbox('123', 'hello', 'key-1')
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(0)
    expect(row.chat_id).toBe('123')
    expect(row.text).toBe('hello')
  })

  it('a repeated idempotency_key returns the SAME row, never a second one', () => {
    const first = enqueueTelegramOutbox('123', 'hello', 'key-dup')
    const second = enqueueTelegramOutbox('123', 'a completely different text', 'key-dup')
    expect(second.id).toBe(first.id)
    // The retried enqueue's own (possibly different) text/chat_id never overwrites the row --
    // first-write-wins, which is what makes this a true no-op rather than a silent update.
    expect(second.text).toBe('hello')
    expect(listDueTelegramOutbox(Date.now() + 1).length).toBe(1)
  })

  it('a repeated key after the row already succeeded does not reset it to pending', () => {
    const row = enqueueTelegramOutbox('123', 'hello', 'key-sent')
    markTelegramOutboxSent(row.id, 999)
    const again = enqueueTelegramOutbox('123', 'hello', 'key-sent')
    expect(again.status).toBe('sent')
    expect(again.message_id).toBe(999)
  })
})

describe('db layer: listDueTelegramOutbox', () => {
  it('only returns pending rows whose next_retry_at has arrived', () => {
    const now = Date.now()
    const due = enqueueTelegramOutbox('1', 'a', 'k-due', now - 1000)
    const future = enqueueTelegramOutbox('2', 'b', 'k-future', now + 60_000)
    const ids = listDueTelegramOutbox(now).map(r => r.id)
    expect(ids).toContain(due.id)
    expect(ids).not.toContain(future.id)
  })

  it('excludes a row already marked sent', () => {
    const row = enqueueTelegramOutbox('1', 'a', 'k-sent')
    markTelegramOutboxSent(row.id, 1)
    expect(listDueTelegramOutbox(Date.now() + 1).map(r => r.id)).not.toContain(row.id)
  })
})

describe('db layer: markTelegramOutboxFailed', () => {
  it('increments attempts, stores the sanitized error, schedules the retry, and STAYS pending (not terminal)', () => {
    const row = enqueueTelegramOutbox('1', 'a', 'k-fail')
    const newAttempts = markTelegramOutboxFailed(row.id, 'boom', Date.now() + 5000)
    expect(newAttempts).toBe(1)
    const reloaded = getTelegramOutboxRow(row.id)!
    expect(reloaded.status).toBe('pending')
    expect(reloaded.attempts).toBe(1)
    expect(reloaded.last_error).toBe('boom')
  })
})

describe('db layer: survives a restart (two independent initDatabase() calls on the same file)', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    while (tmpDirs.length > 0) {
      try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('a pending row enqueued before a restart is still pending and due after it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'telegram-outbox-'))
    tmpDirs.push(dir)
    const path = join(dir, 'test.db')
    initDatabase(path) // process #1
    const row = enqueueTelegramOutbox('1', 'persist me', 'k-restart')
    markTelegramOutboxFailed(row.id, 'transient', Date.now() - 1) // already due again

    initDatabase(path) // simulates the dashboard process restarting against the same file
    const reloaded = getTelegramOutboxRow(row.id)!
    expect(reloaded.status).toBe('pending')
    expect(reloaded.attempts).toBe(1)
    expect(listDueTelegramOutbox().map(r => r.id)).toContain(row.id)
  })
})

describe('nextRetryDelayMs', () => {
  it('doubles from a 5s base and caps at 300s', () => {
    expect(nextRetryDelayMs(1)).toBe(5_000)
    expect(nextRetryDelayMs(2)).toBe(10_000)
    expect(nextRetryDelayMs(3)).toBe(20_000)
    expect(nextRetryDelayMs(4)).toBe(40_000)
    expect(nextRetryDelayMs(5)).toBe(80_000)
    expect(nextRetryDelayMs(6)).toBe(160_000)
    expect(nextRetryDelayMs(7)).toBe(300_000) // would be 320_000 uncapped
    expect(nextRetryDelayMs(20)).toBe(300_000)
  })
})

describe('sanitizeOutboxError', () => {
  it('redacts a token-shaped substring', () => {
    const msg = 'failed calling https://api.telegram.org/bot123456789:AAFakeToken_1234567890abcdefgh/sendMessage'
    expect(sanitizeOutboxError(msg)).not.toContain('123456789:AAFakeToken_1234567890abcdefgh')
    expect(sanitizeOutboxError(msg)).toContain('<redacted>')
  })

  it('truncates to 500 characters', () => {
    expect(sanitizeOutboxError('x'.repeat(1000)).length).toBe(500)
  })

  it('leaves an ordinary error message untouched', () => {
    expect(sanitizeOutboxError('Telegram API 400: chat not found')).toBe('Telegram API 400: chat not found')
  })
})

describe('drainTelegramOutboxOnce', () => {
  it('a successful send marks the row sent with its message_id', async () => {
    const row = enqueueTelegramOutbox('1', 'hi', 'k-ok')
    const sender: TelegramSender = vi.fn(async () => 777)
    await drainTelegramOutboxOnce(sender)
    expect(sender).toHaveBeenCalledWith('1', 'hi')
    const reloaded = getTelegramOutboxRow(row.id)!
    expect(reloaded.status).toBe('sent')
    expect(reloaded.message_id).toBe(777)
  })

  it('a failed send stays pending, increments attempts, and schedules the next try at the right delay', async () => {
    const row = enqueueTelegramOutbox('1', 'hi', 'k-fail')
    const sender: TelegramSender = vi.fn(async () => { throw new Error('Telegram API 500: boom') })
    const before = Date.now()
    await drainTelegramOutboxOnce(sender, before)
    const reloaded = getTelegramOutboxRow(row.id)!
    expect(reloaded.status).toBe('pending')
    expect(reloaded.attempts).toBe(1)
    expect(reloaded.last_error).toContain('Telegram API 500')
    expect(reloaded.next_retry_at).toBeGreaterThanOrEqual(before + 5_000)
  })

  it('a row failing 3 times in a row logs exactly ONE health warning, at the 3rd failure', async () => {
    const row = enqueueTelegramOutbox('1', 'hi', 'k-health')
    const failing: TelegramSender = vi.fn(async () => { throw new Error('down') })
    let now = Date.now()
    for (let i = 0; i < 5; i++) {
      await drainTelegramOutboxOnce(failing, now)
      now = getTelegramOutboxRow(row.id)!.next_retry_at + 1 // jump straight to the next due time
    }
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][1]).toContain('3 consecutive')
  })

  it('a row that fails twice then succeeds never logs the health warning (only 2 consecutive failures)', async () => {
    const row = enqueueTelegramOutbox('1', 'hi', 'k-recover')
    let now = Date.now()
    const failing: TelegramSender = async () => { throw new Error('down') }
    await drainTelegramOutboxOnce(failing, now)
    now = getTelegramOutboxRow(row.id)!.next_retry_at + 1
    await drainTelegramOutboxOnce(failing, now)
    now = getTelegramOutboxRow(row.id)!.next_retry_at + 1
    const succeeding: TelegramSender = async () => 1
    await drainTelegramOutboxOnce(succeeding, now)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(getTelegramOutboxRow(row.id)!.status).toBe('sent')
  })

  it('does not call the sender for a row that is not yet due', async () => {
    enqueueTelegramOutbox('1', 'later', 'k-later', Date.now() + 60_000)
    const sender: TelegramSender = vi.fn(async () => 1)
    await drainTelegramOutboxOnce(sender)
    expect(sender).not.toHaveBeenCalled()
  })
})

describe('isTelegramOutboxEnabled / startTelegramOutboxDrain (default-off contract)', () => {
  it('is disabled by default', () => {
    expect(isTelegramOutboxEnabled()).toBe(false)
  })

  it('startTelegramOutboxDrain() returns undefined (starts no interval) when the flag is off', () => {
    const handle = startTelegramOutboxDrain()
    expect(handle).toBeUndefined()
  })

  it('is enabled when the flag is exactly "1"', () => {
    process.env[OUTBOX_FLAG_ENV] = '1'
    expect(isTelegramOutboxEnabled()).toBe(true)
    process.env[OUTBOX_FLAG_ENV] = 'true' // anything other than the literal "1" stays off
    expect(isTelegramOutboxEnabled()).toBe(false)
  })

  it('startTelegramOutboxDrain() returns a real interval handle when the flag is on, and it is cleared cleanly', () => {
    process.env[OUTBOX_FLAG_ENV] = '1'
    const handle = startTelegramOutboxDrain()
    expect(handle).toBeDefined()
    clearInterval(handle)
  })
})

describe('startTelegramOutboxDrain: single-flight guard (CYBERED NO-GO 35157 B1)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a send slower than the interval is never started twice for the same row', async () => {
    process.env[OUTBOX_FLAG_ENV] = '1'
    const row = enqueueTelegramOutbox('1', 'slow send', 'k-slow')
    let resolveSend: (id: number) => void
    const sender: TelegramSender = vi.fn(() => new Promise<number>((resolve) => { resolveSend = resolve }))

    const handle = startTelegramOutboxDrain(sender)
    try {
      // First tick starts the (never-yet-resolved) send.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sender).toHaveBeenCalledTimes(1)

      // Two more ticks fire while the first send is still in flight -- the bug
      // (bare setInterval, no guard) would call the sender again on each of
      // these; the fix must skip them.
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sender).toHaveBeenCalledTimes(1)

      // Let the slow send finish, then confirm the NEXT tick behaves normally
      // (no due row left, sender not called again).
      resolveSend!(42)
      await vi.waitFor(() => expect(getTelegramOutboxRow(row.id)!.status).toBe('sent'))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sender).toHaveBeenCalledTimes(1)
    } finally {
      clearInterval(handle)
    }
  })
})

describe('POST /api/telegram/outbox (route)', () => {
  function fakeReq(body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = {
      writeHead(status: number) { out.status = status; return res },
      end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    }
    const url = new URL('http://localhost:3420/api/telegram/outbox')
    const bodyStr = JSON.stringify(body)
    const req: any = {
      on(event: string, cb: (chunk?: Buffer) => void) {
        if (event === 'data') cb(Buffer.from(bodyStr))
        if (event === 'end') cb()
      },
    }
    return { ctx: { req, res, path: url.pathname, method: 'POST', url } as RouteContext, out }
  }

  it('returns 503 when the flag is off', async () => {
    const { ctx, out } = fakeReq({ chat_id: '1', text: 'hi', idempotency_key: 'k1' })
    expect(await tryHandleTelegramOutbox(ctx)).toBe(true)
    expect(out.status).toBe(503)
  })

  it('enqueues and returns 200 + {id, status} when the flag is on', async () => {
    process.env[OUTBOX_FLAG_ENV] = '1'
    const { ctx, out } = fakeReq({ chat_id: '1', text: 'hi', idempotency_key: 'k-route' })
    expect(await tryHandleTelegramOutbox(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('pending')
    expect(typeof out.body.id).toBe('number')
  })

  it('rejects a missing/invalid chat_id, text, or idempotency_key with 400', async () => {
    process.env[OUTBOX_FLAG_ENV] = '1'
    for (const bad of [
      { text: 'hi', idempotency_key: 'k' },
      { chat_id: '1', idempotency_key: 'k' },
      { chat_id: '1', text: '', idempotency_key: 'k' },
      { chat_id: '1', text: 'hi', idempotency_key: '' },
      { chat_id: '1', text: 'hi', idempotency_key: 'bad key with spaces' },
    ]) {
      const { ctx, out } = fakeReq(bad)
      expect(await tryHandleTelegramOutbox(ctx)).toBe(true)
      expect(out.status).toBe(400)
    }
  })

  it('posting the same idempotency_key twice never creates a second row', async () => {
    process.env[OUTBOX_FLAG_ENV] = '1'
    const body = { chat_id: '1', text: 'hi', idempotency_key: 'k-no-dup' }
    const first = fakeReq(body)
    await tryHandleTelegramOutbox(first.ctx)
    const second = fakeReq(body)
    await tryHandleTelegramOutbox(second.ctx)
    expect(second.out.body.id).toBe(first.out.body.id)
  })

  it('ignores a request for a different path/method', async () => {
    const { ctx } = fakeReq({})
    ctx.path = '/api/other'
    expect(await tryHandleTelegramOutbox(ctx)).toBe(false)
  })
})
