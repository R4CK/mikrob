// Card 08d1aa90, WhiteHat2 GO 25458 INFO note: the shipped freellm-keys tests mock
// freellmapi-client.js entirely, so login, the 401 retry, and the real request/
// response wiring were only covered by code reading, not a test. This drives the
// REAL client (nothing mocked) against a fake HTTP server standing in for
// freellmapi, through the real route handler.
import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'freellm-real-client-test-'))
const CRED_FILE = join(TMP_DIR, 'admin')
writeFileSync(CRED_FILE, 'admin@test.local:fake-password-for-fake-upstream\n')

interface FakeRow { id: number; platform: string; maskedKey: string; createdAt: string }
let rows: FakeRow[] = []
let nextId = 1

interface FakeAddKeyBody { platform: string; key: string }

function readJsonBody(req: IncomingMessage): Promise<FakeAddKeyBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      resolve(JSON.parse(raw) as FakeAddKeyBody)
    })
  })
}

function maskLikeRealFreellmapi(key: string): string {
  if (key.length < 5) return '****'
  if (key.length <= 8) return `****${key.slice(-2)}`
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

const server: Server = createServer((req, res) => {
  void handleFakeUpstreamRequest(req, res)
})

async function handleFakeUpstreamRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || ''
  if (url === '/api/auth/login' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ token: 'fake-session-token-for-test' }))
    return
  }
  if (url === '/api/keys' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(rows))
    return
  }
  if (url === '/api/keys' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const row: FakeRow = {
      id: nextId++,
      platform: body.platform,
      maskedKey: maskLikeRealFreellmapi(body.key),
      createdAt: '2026-10-29 10:00:00',
    }
    rows.push(row)
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(row))
    return
  }
  const delMatch = url.match(/^\/api\/keys\/(\d+)$/)
  if (delMatch && req.method === 'DELETE') {
    const id = Number(delMatch[1])
    rows = rows.filter((r) => r.id !== id)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
}

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
process.env.FREELLMAPI_BASE_URL = `http://127.0.0.1:${port}`
process.env.FREELLMAPI_ADMIN_CREDENTIAL_FILE = CRED_FILE

// Imported AFTER the env vars above are set, with freellmapi-client.js NOT mocked --
// this is the real client, talking to the real (fake) HTTP server over the loop.
const { tryHandleFreellmKeys } = await import('../web/routes/freellm-keys.js')

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  delete process.env.FREELLMAPI_BASE_URL
  delete process.env.FREELLMAPI_ADMIN_CREDENTIAL_FILE
})

function mkRequest(path: string, method: string, body?: unknown) {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
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

describe('freellm-keys route against a real (unmocked) freellmapi-client + fake upstream server', () => {
  it('POST then GET then DELETE round-trips through the real client', async () => {
    const post = mkRequest('/api/freellm/keys', 'POST', { provider: 'groq', key: 'real-client-round-trip-key-9f3c7a' })
    await tryHandleFreellmKeys(post.ctx)
    expect(post.out.status).toBe(201)
    expect(post.out.body.set).toBe(true)
    expect(post.out.body.hint).toBe('3c7a')

    const get1 = mkRequest('/api/freellm/keys', 'GET')
    await tryHandleFreellmKeys(get1.ctx)
    expect(get1.out.body).toHaveLength(1)
    expect(get1.out.body[0]).toMatchObject({ provider: 'groq', set: true, hint: '3c7a' })

    const del = mkRequest('/api/freellm/keys/groq', 'DELETE')
    await tryHandleFreellmKeys(del.ctx)
    expect(del.out.body).toEqual({ provider: 'groq', deleted: true })

    const get2 = mkRequest('/api/freellm/keys', 'GET')
    await tryHandleFreellmKeys(get2.ctx)
    expect(get2.out.body).toEqual([])
  })

  it('a second POST for the same provider leaves exactly one row (F1, end-to-end through the real client)', async () => {
    rows = []
    nextId = 1
    const first = mkRequest('/api/freellm/keys', 'POST', { provider: 'groq', key: 'first-real-client-key-aaaa' })
    await tryHandleFreellmKeys(first.ctx)
    const second = mkRequest('/api/freellm/keys', 'POST', { provider: 'groq', key: 'second-real-client-key-bbbb' })
    await tryHandleFreellmKeys(second.ctx)

    const get = mkRequest('/api/freellm/keys', 'GET')
    await tryHandleFreellmKeys(get.ctx)
    expect(get.out.body).toHaveLength(1)
    expect(get.out.body[0].hint).toBe('bbbb')
  })
})
