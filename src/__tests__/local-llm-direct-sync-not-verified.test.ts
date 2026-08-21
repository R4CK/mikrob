// Card 41df5159. Peti reported a wall of "Sikertelen" rows on the local-LLM activity panel. They
// were not real failures: local-llm.sh registers a DIRECT-SYNC call for statistics only, hands the
// model's answer straight back to its caller on stdout, and posts an intentionally EMPTY
// `{"result":""}` to /complete just to close the row. Card ea931c14's verifyOutput() then rejected
// that empty body as "empty output" and moved the row to `failed` -- so every SUCCESSFUL direct call
// looked failed. 460 rows in the live DB were in exactly this state.
//
// These tests drive the REAL HTTP route, not the queue module, because the defect lived in the route
// applying a worker-only check to a non-worker row: a module-level test of verifyOutput would have
// stayed green through the whole incident (and did -- it still passes unchanged).
import { describe, it, expect, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, getDb } from '../db.js'
import { tryHandleLocalLlm } from '../web/routes/local-llm.js'
import {
  getById as queueGetById,
  isDirectSyncCall,
  DIRECT_CALL_PLACEHOLDER,
} from '../local-llm-queue.js'
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

async function call(method: string, path: string, rawBody = ''): Promise<any> {
  const req = mkReq(rawBody)
  const res = mkRes()
  const ctx: RouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
  }
  expect(await tryHandleLocalLlm(ctx)).toBe(true)
  return JSON.parse(res.body || '{}')
}

/** The exact sequence local-llm.sh performs on its SUCCESS path (store/local-llm.sh:302-309, 361). */
async function directSyncRoundTrip(
  agent = 'backend',
  taskType = 'route-classify'
): Promise<number> {
  const started = await call(
    'POST',
    '/api/local-llm/queue/start',
    JSON.stringify({ agent, task_type: taskType, source: 'direct-sync' })
  )
  return started.id as number
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('a direct-sync statistics row is not put through the worker output check (card 41df5159)', () => {
  it('THE REPRO: the empty completion local-llm.sh sends ends as `done`, not `failed`', async () => {
    const id = await directSyncRoundTrip()
    const out = await call(
      'POST',
      `/api/local-llm/queue/${id}/complete`,
      JSON.stringify({ result: '' })
    )
    expect(out.status).toBe('done')
    expect(queueGetById(getDb(), id)!.status).toBe('done')
    expect(queueGetById(getDb(), id)!.error).toBeFalsy()
  })

  it('the response does NOT claim the row was verified -- it says the check was skipped', async () => {
    // An honest field: a statistics row carries no model output, so "verified: true" would make the
    // flag worthless as evidence for the rows where it does mean something.
    const id = await directSyncRoundTrip()
    const out = await call(
      'POST',
      `/api/local-llm/queue/${id}/complete`,
      JSON.stringify({ result: '' })
    )
    expect(out.verified).toBe(false)
    expect(out.verificationSkipped).toBe('direct-sync')
  })

  it("the decision rests on the row's own structural marker, not the caller-supplied `source`", async () => {
    // A caller can put any string in `source`; it must not be able to buy itself out of verification.
    const id = await directSyncRoundTrip()
    expect(isDirectSyncCall(getDb(), id)).toBe(true)
    expect(queueGetById(getDb(), id)!.source).toBe('direct-sync')
    getDb().prepare('UPDATE local_llm_queue SET source = ? WHERE id = ?').run('worker', id)
    expect(isDirectSyncCall(getDb(), id)).toBe(true) // still direct-sync: the PROMPT is the marker

    // ...and the converse: a real queued row that merely CLAIMS to be direct-sync is still verified.
    const q = await call(
      'POST',
      '/api/local-llm/queue',
      JSON.stringify({ agent: 'qa', prompt: 'real work' })
    )
    getDb().prepare('UPDATE local_llm_queue SET source = ? WHERE id = ?').run('direct-sync', q.id)
    expect(isDirectSyncCall(getDb(), q.id as number)).toBe(false)
    await call('POST', '/api/local-llm/queue/claim')
    const out = await call(
      'POST',
      `/api/local-llm/queue/${q.id}/complete`,
      JSON.stringify({ result: '  ' })
    )
    expect(out.status).not.toBe('done')
    expect(out.reason).toBe('empty output')
  })

  it('REAL worker verification is untouched: an empty result still fails, a stub still fails', async () => {
    for (const [result, reason] of [
      ['', 'empty output'],
      ['// TODO: implement', undefined],
    ] as const) {
      const q = await call(
        'POST',
        '/api/local-llm/queue',
        JSON.stringify({ agent: 'qa', prompt: 'real work' })
      )
      await call('POST', '/api/local-llm/queue/claim')
      const out = await call(
        'POST',
        `/api/local-llm/queue/${q.id}/complete`,
        JSON.stringify({ result })
      )
      expect(out.status, String(result)).not.toBe('done')
      expect(out.verified, String(result)).toBe(false)
      if (reason) expect(out.reason).toBe(reason)
      expect(queueGetById(getDb(), q.id as number)!.error, String(result)).toContain(
        'output verification failed'
      )
    }
  })

  it('a real worker result still completes normally', async () => {
    const q = await call(
      'POST',
      '/api/local-llm/queue',
      JSON.stringify({ agent: 'qa', prompt: 'real work' })
    )
    await call('POST', '/api/local-llm/queue/claim')
    const out = await call(
      'POST',
      `/api/local-llm/queue/${q.id}/complete`,
      JSON.stringify({ result: 'export function add(a, b) { return a + b }' })
    )
    expect(out).toMatchObject({ status: 'done', verified: true })
  })

  it('isDirectSyncCall answers false for an id that does not exist', async () => {
    expect(isDirectSyncCall(getDb(), 999_999)).toBe(false)
  })

  it('the marker this all rests on is the one the rest of the module already uses', async () => {
    const id = await directSyncRoundTrip()
    expect(getDb().prepare('SELECT prompt FROM local_llm_queue WHERE id = ?').get(id)).toEqual({
      prompt: DIRECT_CALL_PLACEHOLDER,
    })
  })
})
