// Card a8e34618: GET/PUT /api/freellm/status. The FE (web/app-freellm.js) was built against this
// contract before the route existed -- these tests pin GET/PUT against the REAL function, a real
// (mkdtemp'd) store dir for the switch file, and a real in-memory kanban DB for the counters.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { rmSync, writeFileSync, symlinkSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, appendLlmLedgerRow } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

// ONE real, writable tmp dir for the whole file -- STORE_DIR is read into a module-level
// constant by the route file at import time, so the mock must resolve before that first import
// and stay fixed afterward (same "fixed value for the whole file" shape as fleet-transfer.test.ts/
// router-voice-stt-gate.test.ts, just pointing at a real directory instead of a fake path).
// vi.mock's factory is hoisted above this file's own top-level statements, so the directory is
// created inside vi.hoisted() rather than a plain const -- a plain const here hits a
// "Cannot access before initialization" TDZ error at the hoisted call site.
const { storeDir } = vi.hoisted((): { storeDir: string } => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return { storeDir: mkdtempSync(join(tmpdir(), 'freellm-status-test-')) }
})

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, STORE_DIR: storeDir }
})

const { tryHandleFreellmStatus, FREELLM_ENABLED_PATH } = await import('../web/routes/freellm-status.js')

function mkRequest(path: string, method: string, body?: unknown) {
  const req = new EventEmitter() as unknown as RouteContext['req']
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420${path}`)
  if (body !== undefined) {
    process.nextTick(() => {
      ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
      ;(req as unknown as EventEmitter).emit('end')
    })
  } else {
    process.nextTick(() => (req as unknown as EventEmitter).emit('end'))
  }
  const ctx = { req, res, path: url.pathname, method, url } as unknown as RouteContext
  return { ctx, out }
}

beforeEach(() => {
  initDatabase(':memory:')
  if (existsSync(FREELLM_ENABLED_PATH)) unlinkSync(FREELLM_ENABLED_PATH)
})
afterAll(() => {
  rmSync(storeDir, { recursive: true, force: true })
})

describe('GET /api/freellm/status', () => {
  it('missing switch file -> enabled false, calls/drafts 0, lastError null', async () => {
    const { ctx, out } = mkRequest('/api/freellm/status', 'GET')
    const handled = await tryHandleFreellmStatus(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ enabled: false, calls: 0, drafts: 0, lastError: null })
  })

  it('strict enabled:true -> enabled true', async () => {
    writeFileSync(FREELLM_ENABLED_PATH, JSON.stringify({ enabled: true }))
    const { ctx, out } = mkRequest('/api/freellm/status', 'GET')
    await tryHandleFreellmStatus(ctx)
    expect(out.body.enabled).toBe(true)
  })

  it('malformed JSON -> fail closed to false, not a 500', async () => {
    writeFileSync(FREELLM_ENABLED_PATH, 'not json')
    const { ctx, out } = mkRequest('/api/freellm/status', 'GET')
    await tryHandleFreellmStatus(ctx)
    expect(out.status).toBe(200)
    expect(out.body.enabled).toBe(false)
  })

  it('truthy-but-not-strict-true ({"enabled":"true"}) -> false (card 4eb3743e F4 parity)', async () => {
    writeFileSync(FREELLM_ENABLED_PATH, JSON.stringify({ enabled: 'true' }))
    const { ctx, out } = mkRequest('/api/freellm/status', 'GET')
    await tryHandleFreellmStatus(ctx)
    expect(out.body.enabled).toBe(false)
  })

  it('counts successful + failed freellm calls in the last 24h, splits calls vs drafts (card 685f25cb: sourced from llm_ledger)', async () => {
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'backend2', cardId: 'cardX', taskType: 'offload', provider: 'freellm', ok: true, nowS: now })
    appendLlmLedgerRow({ agentId: 'backend3', cardId: 'cardY', taskType: 'offload', provider: 'freellm', ok: true, nowS: now })
    appendLlmLedgerRow({ agentId: 'backend2', cardId: 'cardZ', taskType: 'offload', provider: 'freellm', ok: false, failReason: 'http_404', nowS: now })
    // a non-freellm provider row must not be counted at all
    appendLlmLedgerRow({ agentId: 'backend2', taskType: 'offload', provider: 'local', ok: true, nowS: now })
    // an OLD freellm row outside the 24h window must not be counted
    appendLlmLedgerRow({ agentId: 'backend2', taskType: 'offload', provider: 'freellm', ok: true, nowS: now - 25 * 3600 })

    const { ctx, out } = mkRequest('/api/freellm/status', 'GET')
    await tryHandleFreellmStatus(ctx)
    expect(out.body.calls).toBe(3)
    expect(out.body.drafts).toBe(2)
    expect(out.body.lastError).toContain('http_404')
  })

  it('excludes known test callers (test-agent/selftest/queue) from the counters', async () => {
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'selftest', taskType: 'offload', provider: 'freellm', ok: true, nowS: now })
    appendLlmLedgerRow({ agentId: 'test-agent', taskType: 'offload', provider: 'freellm', ok: false, failReason: 'quota_429', nowS: now })
    appendLlmLedgerRow({ agentId: 'queue', taskType: 'offload', provider: 'freellm', ok: false, failReason: 'auth_401', nowS: now })

    const { ctx, out } = mkRequest('/api/freellm/status', 'GET')
    await tryHandleFreellmStatus(ctx)
    expect(out.body.calls).toBe(0)
    expect(out.body.drafts).toBe(0)
    expect(out.body.lastError).toBeNull()
  })
})

describe('PUT /api/freellm/status', () => {
  it('accepts a strict boolean, writes the file, GET reflects it', async () => {
    const put = mkRequest('/api/freellm/status', 'PUT', { enabled: true })
    await tryHandleFreellmStatus(put.ctx)
    expect(put.out.status).toBe(200)
    expect(put.out.body.enabled).toBe(true)
    expect(JSON.parse(readFileSync(FREELLM_ENABLED_PATH, 'utf-8')).enabled).toBe(true)

    const get = mkRequest('/api/freellm/status', 'GET')
    await tryHandleFreellmStatus(get.ctx)
    expect(get.out.body.enabled).toBe(true)
  })

  it('toggling off writes false and GET reflects it', async () => {
    await tryHandleFreellmStatus(mkRequest('/api/freellm/status', 'PUT', { enabled: true }).ctx)
    const off = mkRequest('/api/freellm/status', 'PUT', { enabled: false })
    await tryHandleFreellmStatus(off.ctx)
    expect(off.out.body.enabled).toBe(false)
    const get = mkRequest('/api/freellm/status', 'GET')
    await tryHandleFreellmStatus(get.ctx)
    expect(get.out.body.enabled).toBe(false)
  })

  it('rejects a non-boolean enabled value with 400', async () => {
    const { ctx, out } = mkRequest('/api/freellm/status', 'PUT', { enabled: 'true' })
    await tryHandleFreellmStatus(ctx)
    expect(out.status).toBe(400)
  })

  it('rejects a missing enabled field with 400', async () => {
    const { ctx, out } = mkRequest('/api/freellm/status', 'PUT', {})
    await tryHandleFreellmStatus(ctx)
    expect(out.status).toBe(400)
  })

  it('rejects invalid JSON body with 400', async () => {
    const req = new EventEmitter() as unknown as RouteContext['req']
    process.nextTick(() => {
      ;(req as unknown as EventEmitter).emit('data', Buffer.from('not json'))
      ;(req as unknown as EventEmitter).emit('end')
    })
    const out: { status: number; body: any } = { status: 0, body: null }
    const res = { writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) }, setHeader() {} }
    const url = new URL('http://localhost:3420/api/freellm/status')
    const ctx = { req, res, path: url.pathname, method: 'PUT', url } as unknown as RouteContext
    await tryHandleFreellmStatus(ctx)
    expect(out.status).toBe(400)
  })

  it('never follows a symlink: writing through a symlinked switch path leaves the real target untouched, replaces only the link entry', async () => {
    const realTarget = join(storeDir, 'real-target.json')
    writeFileSync(realTarget, JSON.stringify({ enabled: true, sentinel: 'do-not-touch' }))
    symlinkSync(realTarget, FREELLM_ENABLED_PATH)

    const put = mkRequest('/api/freellm/status', 'PUT', { enabled: false })
    await tryHandleFreellmStatus(put.ctx)
    expect(put.out.status).toBe(200)

    // the symlink's OWN target entry was replaced (rename over a symlink replaces the directory
    // entry, not the thing it pointed at) -- the original real-target.json content survives.
    expect(JSON.parse(readFileSync(realTarget, 'utf-8')).sentinel).toBe('do-not-touch')
    expect(JSON.parse(readFileSync(FREELLM_ENABLED_PATH, 'utf-8')).enabled).toBe(false)
  })
})

describe('unrelated path', () => {
  it('returns false (not handled) for a different path', async () => {
    const { ctx } = mkRequest('/api/freellm/keys', 'GET')
    expect(await tryHandleFreellmStatus(ctx)).toBe(false)
  })
})
