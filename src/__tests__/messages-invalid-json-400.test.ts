// Card a6101228 (Cybersec finding, via Cybered's channel diagnostics): POST /api/messages and
// PUT /api/messages/:id both called JSON.parse(body) unguarded. A malformed/empty body threw a raw
// SyntaxError that fell into whatever generic top-level catch wraps the router, answering HTTP 500
// "Szerver hiba" -- a CLIENT mistake (bad input) reported as a SERVER failure. Consequence measured
// by Cybersec: the caller reads 500 as "retry me", and a malformed-JSON request never becomes valid
// no matter how many times it is retried. Fixed by wrapping both JSON.parse calls in try/catch,
// matching the established convention already used elsewhere in this codebase (agents.ts,
// approvals.ts, auth.ts, voice.ts, federation.ts, agent-taskstate.ts, agent-terminal.ts all do
// `try { ... } catch { json(res, { error: 'Invalid JSON' }, 400); return true }`).
import { describe, it, expect, beforeAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, createAgentMessage } from '../db.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

interface MockRes {
  statusCode: number
  body: string
  writeHead(status: number): MockRes
  setHeader(): void
  end(data?: string): void
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) {
      this.statusCode = status
      return this
    },
    setHeader() {},
    end(data) {
      if (data !== undefined) this.body += data
    },
  }
}

function mkReq(rawBody: string): http.IncomingMessage {
  const r = Readable.from([Buffer.from(rawBody)]) as unknown as http.IncomingMessage
  r.headers = {}
  return r
}

async function call(
  method: string,
  path: string,
  rawBody: string,
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> }> {
  const req = mkReq(rawBody)
  const res = mkRes()
  const ctx: RouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
  }
  const handled = await tryHandleMessages(ctx)
  return { res, handled, json: () => JSON.parse(res.body || '{}') }
}

beforeAll(() => {
  initDatabase(':memory:')
})

describe('POST /api/messages with a malformed body', () => {
  it('empty body -> 400 Invalid JSON, not 500', async () => {
    const { res, handled, json } = await call('POST', '/api/messages', '')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/invalid json/i)
  })

  it('truncated/corrupt JSON -> 400 Invalid JSON, not 500', async () => {
    const { res, json } = await call('POST', '/api/messages', '{"from":"backend2",')
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/invalid json/i)
  })

  it('CONTROL: valid JSON with a missing field still answers the pre-existing 400', async () => {
    // Proves the fix did not swallow the ALREADY-correct validation path below the parse.
    const { res, json } = await call('POST', '/api/messages', JSON.stringify({ from: 'backend2' }))
    expect(res.statusCode).toBe(400)
    expect(json().error).toBe('from, to, and content are required')
  })

  it('CONTROL: well-formed JSON with an unregistered sender still reaches the existing 403 (parse path unaffected)', async () => {
    const { res, json } = await call(
      'POST',
      '/api/messages',
      JSON.stringify({ from: 'no-such-agent-xyz', to: 'mikrob', content: 'hi' }),
    )
    expect(res.statusCode).toBe(403)
    expect(json().error).toMatch(/unknown agent/i)
  })
})

describe('PUT /api/messages/:id with a malformed body', () => {
  it('empty body -> 400 Invalid JSON, not 500', async () => {
    const msg = createAgentMessage('backend2', 'mikrob', 'test')
    const { res, json } = await call('PUT', `/api/messages/${msg.id}`, '')
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/invalid json/i)
  })

  it('malformed JSON -> 400 Invalid JSON, not 500', async () => {
    const msg = createAgentMessage('backend2', 'mikrob', 'test')
    const { res, json } = await call('PUT', `/api/messages/${msg.id}`, '{not json')
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/invalid json/i)
  })
})
