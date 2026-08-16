// Card 5dcd9bc8: POST /api/local-llm/queue/start lets a DIRECT/synchronous local-llm.sh call
// register itself as `running` so the dashboard's active-task tile reflects real concurrent
// activity, not just the narrow async offload queue (which real usage never touched).
import { describe, it, expect, beforeAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, getDb } from '../db.js'
import { tryHandleLocalLlm } from '../web/routes/local-llm.js'
import { stats } from '../local-llm-queue.js'
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
  path: string,
  rawBody: string,
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> }> {
  const req = mkReq(rawBody)
  const res = mkRes()
  const ctx: RouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method: 'POST',
    url: new URL(`http://127.0.0.1:3420${path}`),
  }
  const handled = await tryHandleLocalLlm(ctx)
  return { res, handled, json: () => JSON.parse(res.body || '{}') }
}

beforeAll(() => {
  initDatabase(':memory:')
})

describe('POST /api/local-llm/queue/start', () => {
  it('creates a running row and returns its id', async () => {
    const { res, handled, json } = await call(
      '/api/local-llm/queue/start',
      JSON.stringify({ agent: 'backend2', task_type: 'code' }),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = json()
    expect(body.status).toBe('running')
    expect(typeof body.id).toBe('number')
  })

  it('rejects a missing agent with 400 (not a silent no-op row)', async () => {
    const { res, json } = await call('/api/local-llm/queue/start', JSON.stringify({}))
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/agent/i)
  })

  it('rejects malformed JSON with 400, not 500', async () => {
    const { res, json } = await call('/api/local-llm/queue/start', '{not json')
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/invalid json/i)
  })

  it('never stores caller-supplied prompt content -- the row is a placeholder regardless of body', async () => {
    const before = stats(getDb()).running
    const { json } = await call(
      '/api/local-llm/queue/start',
      JSON.stringify({ agent: 'backend2', prompt: 'this must never be persisted', task_type: 'code' }),
    )
    const id = json().id as number
    const row = getDb().prepare('SELECT prompt FROM local_llm_queue WHERE id = ?').get(id) as { prompt: string }
    expect(row.prompt).not.toContain('this must never be persisted')
    expect(stats(getDb()).running).toBe(before + 1)
  })

  it('CONTROL: two concurrent starts both count as running -- the tile no longer caps at 0/1', async () => {
    const before = stats(getDb()).running
    await call('/api/local-llm/queue/start', JSON.stringify({ agent: 'backend2' }))
    await call('/api/local-llm/queue/start', JSON.stringify({ agent: 'fullstack' }))
    expect(stats(getDb()).running).toBe(before + 2)
  })

  it('CONTROL: the plain async POST /api/local-llm/queue endpoint is untouched (still starts pending)', async () => {
    const { res, json } = await call(
      '/api/local-llm/queue',
      JSON.stringify({ agent: 'backend2', prompt: 'draft this function' }),
    )
    expect(res.statusCode).toBe(200)
    expect(json().status).toBe('pending')
  })
})
