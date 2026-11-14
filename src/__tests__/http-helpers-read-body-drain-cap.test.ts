// Card 1a3c6459 N1 (WhiteHat2 30355, off MikroB's dispatch msg 18087): readBody()'s F1 fix
// (drain instead of destroy, so the 413 reaches the wire) removed the only thing that used to
// bound how much a route would ever read past the size cap -- the OLD req.destroy() itself.
// Measured live: an 8KB-cap route (the shape of POST /api/auth/login) reading all of a 512MB
// body a client declared as 2GB, 532ms CPU, connection held open. These tests prove the new
// DRAIN_SLACK_BYTES cap in http-helpers.ts bounds that for EVERY readBody() caller, not just the
// one route (llm-ledger) that happened to also set Connection: close.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import { Readable } from 'node:stream'
import { readBody, RequestBodyTooLargeError } from '../web/http-helpers.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { initDatabase } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

describe('readBody: drain cap bounds post-limit reading for any caller (1a3c6459 N1)', () => {
  let server: http.Server
  let origin = ''
  let serverBytesSeen = 0

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      // Count every byte the SERVER's socket actually receives, independently of whatever
      // readBody() itself does -- multiple 'data' listeners on the same IncomingMessage all see
      // every chunk, so this is not affected by readBody detaching its own listener later.
      req.on('data', (c: Buffer) => { serverBytesSeen += c.length })
      void (async () => {
        try {
          await readBody(req, { maxBytes: 8 * 1024 }) // same cap as POST /api/auth/login
          res.writeHead(200)
          res.end()
        } catch (err) {
          if (err instanceof RequestBodyTooLargeError) {
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Request body too large' }))
            return
          }
          res.writeHead(500)
          res.end()
        }
      })()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    origin = `http://127.0.0.1:${(server.address() as any).port}`
  })
  afterAll(() => { server.close() })

  it('a client that keeps streaming past the cap gets a 413, and the server stops reading well under the full body', async () => {
    serverBytesSeen = 0
    const DECLARED_TOTAL = 8 * 1024 * 1024 // 8MB declared; a pre-fix server with no drain cap
    // would read all of it (N1's live measurement: 512MB read against an 8KB cap).
    const CHUNK = 256 * 1024
    let sent = 0
    async function* body() {
      while (sent < DECLARED_TOTAL) {
        const n = Math.min(CHUNK, DECLARED_TOTAL - sent)
        sent += n
        yield Buffer.alloc(n, 'x')
      }
    }
    let res: Response
    try {
      res = await fetch(`${origin}/`, {
        method: 'POST',
        // @ts-expect-error -- Node's fetch supports a ReadableStream/async-iterable body with duplex:'half'
        body: Readable.from(body()),
        duplex: 'half',
      })
    } catch {
      // A hard connection reset before any response is itself a failure of the property under
      // test (the 413 must reach the wire) -- fail loudly instead of swallowing it.
      throw new Error('request failed before a response was received -- the 413 never reached the wire')
    }
    expect(res.status).toBe(413)
    const data = await res.json() as { error: string }
    expect(data.error).toMatch(/too large/)
    // The cap is 8KB, DRAIN_SLACK_BYTES is 64KB in http-helpers.ts -- the server must stop well
    // short of the 8MB declared body. A generous bound (1MB, 1/8th of the declared total) keeps
    // this from re-coupling to the exact slack constant while still failing hard if the drain
    // cap regressed back to "unbounded".
    expect(serverBytesSeen).toBeLessThan(1024 * 1024)
  })
})

describe('readBody: drain cap over a real unauthenticated route (POST /api/auth/login, 1a3c6459 N1)', () => {
  let server: http.Server
  let origin = ''
  let serverBytesSeen = 0

  beforeAll(async () => {
    initDatabase(':memory:')
    server = http.createServer((req, res) => {
      req.on('data', (c: Buffer) => { serverBytesSeen += c.length })
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const ctx: RouteContext = { req, res, path: url.pathname, method: req.method ?? 'GET', url, auth: undefined }
      void tryHandleAuth(ctx)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    origin = `http://127.0.0.1:${(server.address() as any).port}`
  })
  afterAll(() => { server.close() })
  beforeEach(() => { serverBytesSeen = 0 })

  it('an oversize body to the real, unauthenticated login route still gets a response (not a dropped connection), and reading stops well under the full body', async () => {
    const DECLARED_TOTAL = 4 * 1024 * 1024
    const CHUNK = 256 * 1024
    let sent = 0
    async function* body() {
      while (sent < DECLARED_TOTAL) {
        const n = Math.min(CHUNK, DECLARED_TOTAL - sent)
        sent += n
        yield Buffer.alloc(n, 'x')
      }
    }
    let res: Response
    try {
      res = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // @ts-expect-error -- see above
        body: Readable.from(body()),
        duplex: 'half',
      })
    } catch {
      throw new Error('request failed before a response was received')
    }
    // auth.ts's parseJsonBody catch-all turns EVERY error (RequestBodyTooLargeError included)
    // into a generic 400 "Invalid JSON", not a 413 -- that is this route's existing, unchanged
    // behavior (it does not special-case RequestBodyTooLargeError the way llm-ledger.ts does).
    // The property this test actually proves is the one N1 is about: the connection does not
    // drop, and the server does not read the whole oversize body -- not the exact status code.
    expect(res.status).toBe(400)
    expect(serverBytesSeen).toBeLessThan(1024 * 1024)
  })
})
