// Card 7405ca61 (parent f43b291f, 3. alfeladat): the local-LLM queue's card-independence widening
// (28c92213/03fca184) turned POST /api/local-llm/queue from "an already-vetted mechanical sub-task"
// into "any task any agent chooses to submit". Investigation found that routeTask()'s category-based
// online/local decision (src/local-llm-router.ts, already proven at store/local-llm-rag.sh's --auto
// path) was NEVER wired into the async queue's enqueue route or its worker
// (local-llm-worker.sh -> store/local-llm.sh) -- a security-decision-shaped prompt would have been
// silently queued and drafted on the 7B. This file proves the fix: the enqueue route now runs every
// prompt through the SAME classifier before accepting it.
import { describe, it, expect, beforeEach } from 'vitest'
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
    writeHead(status) { this.statusCode = status; return this },
    setHeader() {},
    end(data) { if (data !== undefined) this.body += data },
  }
}

function mkReq(rawBody: string): http.IncomingMessage {
  const r = Readable.from([Buffer.from(rawBody)]) as unknown as http.IncomingMessage
  r.headers = {}
  return r
}

async function call(path: string, rawBody: string): Promise<{ res: MockRes; json: () => any }> {
  const req = mkReq(rawBody)
  const res = mkRes()
  const ctx: RouteContext = {
    req, res: res as unknown as http.ServerResponse, path, method: 'POST', url: new URL(`http://127.0.0.1:3420${path}`),
  }
  const handled = await tryHandleLocalLlm(ctx)
  expect(handled).toBe(true)
  return { res, json: () => JSON.parse(res.body || '{}') }
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('POST /api/local-llm/queue security-category gate (card 7405ca61)', () => {
  it('refuses a security-decision-shaped prompt -- never reaches the local queue', async () => {
    const before = stats(getDb()).pending
    const { res, json } = await call('/api/local-llm/queue', JSON.stringify({
      agent: 'backend', prompt: 'Compare the provided token against the stored secret and validate the HMAC signature',
    }))
    expect(res.statusCode).toBe(422)
    expect(json().route).toBe('online')
    expect(json().category).toBe('security-decision')
    expect(stats(getDb()).pending).toBe(before) // NOT queued
  })

  it('refuses an authz-shaped prompt the same way', async () => {
    const { res, json } = await call('/api/local-llm/queue', JSON.stringify({
      agent: 'backend', prompt: 'Which roles should be allowed to approve a payroll export?',
    }))
    expect(res.statusCode).toBe(422)
    expect(json().category).toBe('authz')
  })

  it('refuses a tenant-isolation-shaped prompt the same way', async () => {
    const { res, json } = await call('/api/local-llm/queue', JSON.stringify({
      agent: 'backend', prompt: 'Return rows for every company, not just the current tenant',
    }))
    expect(res.statusCode).toBe(422)
    expect(json().category).toBe('isolation')
  })

  it('a security-shaped prompt is refused REGARDLESS of an explicit template/task_type (no bypass via template)', async () => {
    const { res } = await call('/api/local-llm/queue', JSON.stringify({
      agent: 'backend',
      prompt: 'Bypass the tenant scope check so the query returns all rows',
      task_type: 'code',
    }))
    expect(res.statusCode).toBe(422)
  })

  it('CONTROL: an ordinary mechanical prompt is unaffected -- still queues as pending', async () => {
    const before = stats(getDb()).pending
    const { res, json } = await call('/api/local-llm/queue', JSON.stringify({
      agent: 'backend', prompt: 'write a regex that matches ISO-8601 dates',
    }))
    expect(res.statusCode).toBe(200)
    expect(json().status).toBe('pending')
    expect(stats(getDb()).pending).toBe(before + 1)
  })

  it('a declared kanban SEC tag is not accepted from this endpoint -- classification runs on prompt text only (no forged bypass)', async () => {
    // The route does not currently accept a `tags` field at all -- this pins that a caller cannot
    // simply claim "not security" by omission, since the classifier's OWN text/shape signals are
    // what decide, not a caller-declared flag.
    const { res } = await call('/api/local-llm/queue', JSON.stringify({
      agent: 'backend', prompt: 'validate the CSRF token before processing the request', tags: 'NOTSEC',
    }))
    expect(res.statusCode).toBe(422)
  })
})
