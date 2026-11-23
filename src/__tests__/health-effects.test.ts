// Card 0a527826: GET /api/health/effects. Pure compute functions are tested directly with
// injected data (no mocking needed); the route is tested against a real in-memory DB and a real
// (mkdtemp'd) store dir, same shape as freellm-status.test.ts.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

const { storeDir } = vi.hoisted((): { storeDir: string } => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return { storeDir: mkdtempSync(join(tmpdir(), 'health-effects-test-')) }
})

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, STORE_DIR: storeDir }
})

const {
  trailingFailures,
  computeLandEffect,
  computeScheduledTaskEffect,
  computeTelegramSendEffect,
  computeOffloadDraftEffect,
  computeMemoryEmbedEffect,
  readHealthEffectsEnabled,
  tryHandleHealthEffects,
  HEALTH_EFFECTS_ENABLED_PATH,
} = await import('../web/routes/health-effects.js')

function mkRequest(path: string, method = 'GET') {
  const req = new EventEmitter() as unknown as RouteContext['req']
  const out: { status: number; body: unknown } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420${path}`)
  process.nextTick(() => (req as unknown as EventEmitter).emit('end'))
  return { ctx: { req, res, path: url.pathname, method, url } as unknown as RouteContext, out }
}

beforeEach(() => {
  initDatabase(':memory:')
})
afterAll(() => {
  rmSync(storeDir, { recursive: true, force: true })
})

describe('trailingFailures', () => {
  it('counts a trailing run of failures, stops at the first ok', () => {
    // newest-first: fail, fail, ok, fail -> only the leading 2 count
    const items = ['fail', 'fail', 'ok', 'fail'] as const
    const t = trailingFailures(items, (x) => x, () => 'err')
    expect(t.count).toBe(2)
  })

  it('skip events do not break or extend the streak', () => {
    const items = ['fail', 'skip', 'fail', 'ok'] as const
    const t = trailingFailures(items, (x) => x, () => 'err')
    expect(t.count).toBe(2)
  })

  it('all-ok -> zero failures, null lastError', () => {
    const t = trailingFailures(['ok', 'ok'] as const, (x) => x, () => 'err')
    expect(t).toEqual({ count: 0, lastError: null })
  })

  it('lastError is the newest failing item in the streak', () => {
    const items = [{ e: 'newest' }, { e: 'older' }]
    const t = trailingFailures(items, () => 'fail', (x) => x.e)
    expect(t.lastError).toBe('newest')
  })
})

describe('computeLandEffect', () => {
  const line = (result: string) => JSON.stringify({ event: 'finished', result })

  it('3 trailing fail lines -> red', () => {
    const lines = [line('ok'), line('fail'), line('fail'), line('fail')]
    const h = computeLandEffect(lines)
    expect(h.kind).toBe('land')
    expect(h.status).toBe('red')
    expect(h.consecutiveFailures).toBe(3)
  })

  it('2 trailing fails -> ok (below threshold)', () => {
    const lines = [line('ok'), line('fail'), line('fail')]
    const h = computeLandEffect(lines)
    expect(h.status).toBe('ok')
    expect(h.consecutiveFailures).toBe(2)
  })

  it('a trailing aborted run does not count as failure or success -- looks past it', () => {
    const lines = [line('fail'), line('fail'), line('fail'), line('aborted')]
    const h = computeLandEffect(lines)
    expect(h.consecutiveFailures).toBe(3)
    expect(h.status).toBe('red')
  })

  it('malformed/empty lines are skipped without throwing', () => {
    const lines = ['', 'not json', line('ok')]
    expect(() => computeLandEffect(lines)).not.toThrow()
    expect(computeLandEffect(lines).status).toBe('ok')
  })

  it('non-finished events are ignored', () => {
    const lines = [JSON.stringify({ event: 'started', result: 'fail' })]
    expect(computeLandEffect(lines).consecutiveFailures).toBe(0)
  })
})

describe('computeScheduledTaskEffect', () => {
  it('3 trailing lost outcomes -> red', () => {
    const rows = [
      { status: 'fired', outcome: 'lost', completed_at: 3 },
      { status: 'fired', outcome: 'lost-giveup', completed_at: 2 },
      { status: 'fired', outcome: 'lost', completed_at: 1 },
    ]
    const h = computeScheduledTaskEffect(rows)
    expect(h.kind).toBe('scheduled_task')
    expect(h.status).toBe('red')
    expect(h.consecutiveFailures).toBe(3)
  })

  it('a still-open run (completed_at null) is skipped, not counted as ok or fail', () => {
    const rows = [
      { status: 'fired', outcome: null, completed_at: null },
      { status: 'fired', outcome: 'lost', completed_at: 1 },
    ]
    const h = computeScheduledTaskEffect(rows)
    expect(h.consecutiveFailures).toBe(1)
  })

  it('done breaks the streak', () => {
    const rows = [
      { status: 'fired', outcome: 'done', completed_at: 2 },
      { status: 'fired', outcome: 'lost', completed_at: 1 },
    ]
    expect(computeScheduledTaskEffect(rows).consecutiveFailures).toBe(0)
  })
})

describe('computeTelegramSendEffect', () => {
  it('3 trailing non-sent rows -> red, carries last_error', () => {
    const rows = [
      { status: 'pending', last_error: 'timeout' },
      { status: 'pending', last_error: 'timeout' },
      { status: 'failed', last_error: '401' },
    ]
    const h = computeTelegramSendEffect(rows)
    expect(h.status).toBe('red')
    expect(h.consecutiveFailures).toBe(3)
    expect(h.lastError).toBe('timeout')
  })

  it('a sent row breaks the streak', () => {
    const rows = [{ status: 'sent', last_error: null }, { status: 'failed', last_error: 'x' }]
    expect(computeTelegramSendEffect(rows).consecutiveFailures).toBe(0)
  })
})

describe('computeOffloadDraftEffect', () => {
  it('3 trailing exhausted (by updated_at) -> red', () => {
    const attempts = {
      a: { status: 'exhausted', reason: 'router-online', updated_at: 3 },
      b: { status: 'exhausted', reason: 'router-online', updated_at: 2 },
      c: { status: 'exhausted', reason: 'router-online', updated_at: 1 },
    }
    const h = computeOffloadDraftEffect(attempts)
    expect(h.kind).toBe('offload_draft')
    expect(h.status).toBe('red')
    expect(h.consecutiveFailures).toBe(3)
  })

  it('a pending attempt is skipped (not yet a verdict)', () => {
    const attempts = {
      a: { status: 'pending', updated_at: 3 },
      b: { status: 'exhausted', updated_at: 2 },
      c: { status: 'exhausted', updated_at: 1 },
    }
    expect(computeOffloadDraftEffect(attempts).consecutiveFailures).toBe(2)
  })

  it('done breaks the streak', () => {
    const attempts = { a: { status: 'done', updated_at: 2 }, b: { status: 'exhausted', updated_at: 1 } }
    expect(computeOffloadDraftEffect(attempts).consecutiveFailures).toBe(0)
  })
})

describe('computeMemoryEmbedEffect', () => {
  it('3 trailing NULL embeddings -> red', () => {
    const rows = [{ embedding: null }, { embedding: null }, { embedding: null }]
    const h = computeMemoryEmbedEffect(rows)
    expect(h.kind).toBe('memory_embed')
    expect(h.status).toBe('red')
    expect(h.consecutiveFailures).toBe(3)
  })

  it('an embedded row breaks the streak', () => {
    const rows = [{ embedding: '[0.1]' }, { embedding: null }]
    expect(computeMemoryEmbedEffect(rows).consecutiveFailures).toBe(0)
  })
})

describe('readHealthEffectsEnabled', () => {
  it('missing file -> false (fail closed, default off)', () => {
    expect(readHealthEffectsEnabled(join(storeDir, 'nope.json'))).toBe(false)
  })

  it('malformed JSON -> false, not a throw', () => {
    const p = join(storeDir, 'malformed.json')
    writeFileSync(p, 'not json')
    expect(readHealthEffectsEnabled(p)).toBe(false)
  })

  it('strict enabled:true required ({"enabled":"true"} string -> false)', () => {
    const p = join(storeDir, 'stringy.json')
    writeFileSync(p, JSON.stringify({ enabled: 'true' }))
    expect(readHealthEffectsEnabled(p)).toBe(false)
  })

  it('{"enabled":true} -> true', () => {
    const p = join(storeDir, 'on.json')
    writeFileSync(p, JSON.stringify({ enabled: true }))
    expect(readHealthEffectsEnabled(p)).toBe(true)
  })
})

describe('GET /api/health/effects', () => {
  it('flag off (no switch file) -> effects: [] (additive default, Peti 14288)', async () => {
    const { ctx, out } = mkRequest('/api/health/effects')
    const handled = await tryHandleHealthEffects(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ effects: [] })
  })

  it('flag on -> real data from a fresh (empty) DB/store, all kinds ok', async () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(HEALTH_EFFECTS_ENABLED_PATH, JSON.stringify({ enabled: true }))
    const { ctx, out } = mkRequest('/api/health/effects')
    await tryHandleHealthEffects(ctx)
    const body = out.body as { effects: Array<{ kind: string; status: string }> }
    const kinds = body.effects.map((e) => e.kind).sort()
    expect(kinds).toEqual(['land', 'memory_embed', 'offload_draft', 'scheduled_task', 'telegram_send'])
    expect(body.effects.every((e) => e.status === 'ok')).toBe(true)
  })

  it('flag on -> a real red telegram_outbox row surfaces as red', async () => {
    writeFileSync(HEALTH_EFFECTS_ENABLED_PATH, JSON.stringify({ enabled: true }))
    const db = getDb()
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO telegram_outbox (chat_id, text, idempotency_key, status, attempts, next_retry_at, last_error, created_at)
         VALUES ('1', 'x', ?, 'failed', 3, 0, 'boom', ?)`,
      ).run(`k${i}`, i)
    }
    const { ctx, out } = mkRequest('/api/health/effects')
    await tryHandleHealthEffects(ctx)
    const body = out.body as { effects: Array<{ kind: string; status: string; lastError: string | null }> }
    const row = body.effects.find((e) => e.kind === 'telegram_send')
    expect(row?.status).toBe('red')
    expect(row?.lastError).toBe('boom')
  })
})
