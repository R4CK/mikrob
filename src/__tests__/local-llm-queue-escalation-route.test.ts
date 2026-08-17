// Card 03fca184 (plan-grilling verdict, MikroB komment 14138): the escalated STATE transition is
// unit-tested against the DB module in local-llm-queue.test.ts; this file proves the wiring that
// makes it a real capability -- a row that escalates through the actual HTTP route ends up as a
// real inter-agent message (agent_messages row) carrying the FULL original task (requirement 1),
// addressed to the right target (the card's assignee, or MikroB when the row is not card-bound).
import { describe, it, expect, beforeAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, getDb, createKanbanCard, getPendingMessages } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleLocalLlm } from '../web/routes/local-llm.js'
import { MAX_ATTEMPTS, getById as queueGetById } from '../local-llm-queue.js'
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

async function call(method: string, path: string, rawBody = ''): Promise<{ res: MockRes; json: () => any }> {
  const req = mkReq(rawBody)
  const res = mkRes()
  const ctx: RouteContext = {
    req, res: res as unknown as http.ServerResponse, path, method, url: new URL(`http://127.0.0.1:3420${path}`),
  }
  const handled = await tryHandleLocalLlm(ctx)
  expect(handled).toBe(true)
  return { res, json: () => JSON.parse(res.body || '{}') }
}

async function enqueueAndDriveToCap(body: Record<string, unknown>): Promise<number> {
  const { json } = await call('POST', '/api/local-llm/queue', JSON.stringify(body))
  const id = json().id as number
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    await call('POST', '/api/local-llm/queue/claim')
    await call('POST', `/api/local-llm/queue/${id}/fail`, JSON.stringify({ error: `attempt ${i} failed` }))
  }
  return id
}

beforeAll(() => {
  initDatabase(':memory:')
})

describe('POST /api/local-llm/queue/:id/fail escalation wiring (card 03fca184)', () => {
  it('card-bound row escalates to the card\'s assignee with the full original task', async () => {
    createKanbanCard({ id: 'esc-card-1', title: 'x', assignee: 'cybersec' })
    const id = await enqueueAndDriveToCap({
      agent: 'backend', prompt: 'refactor this exact function safely', context: 'must preserve behaviour',
      card_id: 'esc-card-1', task_type: 'code',
    })
    expect(queueGetById(getDb(), id)!.status).toBe('escalated')

    const msgs = getPendingMessages('cybersec')
    const escalationMsg = msgs.find((m) => m.content.includes('#' + id))
    expect(escalationMsg).toBeDefined()
    expect(escalationMsg!.from_agent).toBe(MAIN_AGENT_ID)
    expect(escalationMsg!.content).toContain('refactor this exact function safely')
    expect(escalationMsg!.content).toContain('must preserve behaviour')
    expect(escalationMsg!.content).toContain('esc-card-1')
  })

  it('non-card-bound row escalates to MikroB (MAIN_AGENT_ID) for triage', async () => {
    const id = await enqueueAndDriveToCap({ agent: 'qa', prompt: 'no card attached to this one' })
    expect(queueGetById(getDb(), id)!.status).toBe('escalated')

    const msgs = getPendingMessages(MAIN_AGENT_ID)
    const escalationMsg = msgs.find((m) => m.content.includes('#' + id))
    expect(escalationMsg).toBeDefined()
    expect(escalationMsg!.content).toContain('no card attached to this one')
  })

  it('a row that fails BELOW the cap sends no escalation message', async () => {
    const { json } = await call('POST', '/api/local-llm/queue', JSON.stringify({ agent: 'backend', prompt: 'p' }))
    const id = json().id as number
    await call('POST', '/api/local-llm/queue/claim')
    const before = getPendingMessages(MAIN_AGENT_ID).length
    await call('POST', `/api/local-llm/queue/${id}/fail`, JSON.stringify({ error: 'one-off' }))
    expect(queueGetById(getDb(), id)!.status).toBe('pending')
    expect(getPendingMessages(MAIN_AGENT_ID).length).toBe(before)
  })
})

describe('POST /api/local-llm/queue/claim reclaim-escalation wiring (worker-crash path, card 03fca184)', () => {
  it('a row abandoned by a vanished worker at the attempt cap also escalates with a real message', async () => {
    createKanbanCard({ id: 'esc-card-2', title: 'y', assignee: 'fron-ted' })
    const { json } = await call('POST', '/api/local-llm/queue', JSON.stringify({
      agent: 'fullstack', prompt: 'a task the worker will vanish on', card_id: 'esc-card-2',
    }))
    const id = json().id as number
    // Drive it to attempts = MAX_ATTEMPTS - 1 via the normal fail path, then leave the LAST claim
    // running and backdate started_at past STALE_RUNNING_MS so the next /claim call's reclaim sweep
    // finds it -- simulating the worker process dying mid-run on the final strike.
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      await call('POST', '/api/local-llm/queue/claim')
      await call('POST', `/api/local-llm/queue/${id}/fail`, JSON.stringify({ error: 'e' }))
    }
    await call('POST', '/api/local-llm/queue/claim') // last claim -- now attempts === MAX_ATTEMPTS, status running
    getDb().prepare('UPDATE local_llm_queue SET started_at = ? WHERE id = ?').run(Date.now() - 60 * 60 * 1000, id)

    await call('POST', '/api/local-llm/queue/claim') // triggers reclaimStaleRunning's sweep
    expect(queueGetById(getDb(), id)!.status).toBe('escalated')

    const msgs = getPendingMessages('fron-ted')
    const escalationMsg = msgs.find((m) => m.content.includes('#' + id))
    expect(escalationMsg).toBeDefined()
    expect(escalationMsg!.content).toContain('a task the worker will vanish on')
  })
})
