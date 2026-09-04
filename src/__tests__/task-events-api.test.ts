// Task-event + summary API for the Swimlane Timeline (card a5bbfb98).
//
// These run against a real in-memory database rather than a mocked db module, because the two things
// most likely to be wrong here are SQL-shaped, not logic-shaped: the overlap predicate for the time
// window, and the MILLISECONDS-vs-SECONDS split between the two source tables. A mocked db would
// have proved neither.
//
// THE UNIT TRAP, stated because it is the expensive one: local_llm_queue stamps epoch MILLISECONDS
// (measured on live data: 1788528687675) while token_usage.timestamp stamps SECONDS. Reading either
// with the other's unit does not error -- it silently returns nothing, or returns rows dated 1970 or
// 56000 AD. getTaskSummary converts at the boundary and the conversion is pinned below.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase, getDb, getTaskEvents, getTaskSummary } from '../db.js'
import { tryHandleTaskEvents } from '../web/routes/task-events.js'
import type { RouteContext } from '../web/routes/types.js'

const T0 = 1_788_500_000_000 // epoch ms
const sec = (ms: number) => Math.floor(ms / 1000)

function call(path: string): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: undefined }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req = Readable.from([]) as unknown as http.IncomingMessage
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method: 'GET', url } as RouteContext, out }
}

const get = async (path: string) => {
  const { ctx, out } = call(path)
  const handled = await tryHandleTaskEvents(ctx)
  return { handled, ...out }
}

/** One finished local task. startMs/endMs are epoch MILLISECONDS, like the real column. */
function task(id: number, agent: string, type: string, startMs: number, durMs: number, status = 'done'): void {
  getDb().prepare(
    `INSERT INTO local_llm_queue (id, agent, card_id, task_type, prompt, status, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, 'p', ?, ?, ?, ?)`,
  ).run(id, agent, `card${id}`, type, status, startMs, startMs, startMs + durMs)
}

/** One token-usage row. timestamp is epoch SECONDS, like the real column. */
function usage(agent: string, model: string, atMs: number, inTok: number, outTok: number): void {
  getDb().prepare(
    `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model)
     VALUES (?, 's', ?, ?, ?, ?)`,
  ).run(agent, sec(atMs), inTok, outTok, model)
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('getTaskEvents: blocks come from rows that have BOTH a start and an end', () => {
  it('returns finished tasks as blocks with a real duration', () => {
    task(1, 'backend2', 'card-draft', T0 + 1000, 7110)
    const ev = getTaskEvents(T0, T0 + 60_000, null, 100)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({
      agent: 'backend2', category: 'card-draft', lane: 'local',
      startMs: T0 + 1000, endMs: T0 + 8110, durationMs: 7110, status: 'done',
    })
  })

  it('a RUNNING task is not a block -- guessing a width would draw one that shrinks next poll', () => {
    getDb().prepare(
      `INSERT INTO local_llm_queue (id, agent, task_type, prompt, status, created_at, started_at)
       VALUES (9, 'qa', 'route-triage', 'p', 'running', ?, ?)`,
    ).run(T0, T0)
    expect(getTaskEvents(T0, T0 + 60_000, null, 100)).toEqual([])
  })

  it('an uncategorised task still draws, labelled -- it must not vanish from the timeline', () => {
    getDb().prepare(
      `INSERT INTO local_llm_queue (id, agent, prompt, status, created_at, started_at, finished_at)
       VALUES (7, 'qa', 'p', 'done', ?, ?, ?)`,
    ).run(T0, T0, T0 + 500)
    expect(getTaskEvents(T0, T0 + 60_000, null, 100)[0]!.category).toBe('(uncategorised)')
  })

  it('OVERLAP, not containment: a task straddling either edge of the window is included', () => {
    task(1, 'a', 'x', T0 - 5_000, 10_000)          // starts before, ends inside
    task(2, 'a', 'x', T0 + 55_000, 10_000)         // starts inside, ends after
    task(3, 'a', 'x', T0 - 60_000, 1_000)          // wholly before
    task(4, 'a', 'x', T0 + 120_000, 1_000)         // wholly after
    const ids = getTaskEvents(T0, T0 + 60_000, null, 100).map(e => e.id)
    expect(ids.sort()).toEqual([1, 2])
  })

  it('filters by agent when asked, and does not when not', () => {
    task(1, 'backend2', 'x', T0, 100)
    task(2, 'qa', 'x', T0, 100)
    expect(getTaskEvents(T0, T0 + 60_000, 'qa', 100).map(e => e.agent)).toEqual(['qa'])
    expect(getTaskEvents(T0, T0 + 60_000, null, 100)).toHaveLength(2)
  })
})

describe('getTaskSummary: the seconds/milliseconds boundary', () => {
  it('finds token_usage rows written in SECONDS from a window given in MILLISECONDS', () => {
    // The whole point: pass ms straight to a seconds column and this returns nothing.
    usage('backend2', 'claude-opus-5', T0 + 1000, 100, 20)
    usage('backend2', 'claude-opus-5', T0 + 2000, 50, 10)
    usage('qa', 'claude-sonnet-5', T0 + 3000, 7, 3)
    const s = getTaskSummary(T0, T0 + 60_000)
    expect(s.activeModels).toBe(2)
    const opus = s.models.find(m => m.model === 'claude-opus-5')!
    expect(opus).toMatchObject({ requests: 2, inputTokens: 150, outputTokens: 30, agents: 1 })
  })

  it('counts tasks and errors, and averages duration across categories', () => {
    task(1, 'a', 'card-draft', T0, 1000)
    task(2, 'a', 'card-draft', T0, 3000)
    task(3, 'a', 'route-triage', T0, 2000, 'failed')
    const s = getTaskSummary(T0, T0 + 60_000)
    expect(s.taskCount).toBe(3)
    expect(s.failedCount).toBe(1)
    expect(s.byCategory).toEqual({ 'card-draft': 2, 'route-triage': 1 })
    expect(s.avgDurationMs).toBe(2000) // (1000+3000+2000)/3
  })

  it('an empty window is an empty answer, not a crash or a NaN average', () => {
    const s = getTaskSummary(T0, T0 + 60_000)
    expect(s).toMatchObject({ activeModels: 0, taskCount: 0, failedCount: 0, avgDurationMs: null })
    expect(s.models).toEqual([])
  })

  it('blockCoverage names which lanes can actually draw blocks', () => {
    // Contract, not decoration: a timeline that assumed every model had blocks would render empty
    // lanes for the online models and read as a bug rather than as the honest state.
    const s = getTaskSummary(T0, T0 + 60_000)
    expect(s.blockCoverage.lanes).toEqual(['local'])
    expect(s.blockCoverage.note).toMatch(/otel_spans/)
  })
})

describe('the route: fail closed on a bad window, and say what to fix (rule 12)', () => {
  it('ignores everything that is not one of its two GET paths', async () => {
    const { ctx } = call('/api/something-else')
    expect(await tryHandleTaskEvents(ctx)).toBe(false)
  })

  it('missing from/to is a 400 that NAMES the parameters and the unit', async () => {
    const r = await get('/api/task-events')
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/from/)
    expect(r.body.error).toMatch(/MILLISZEKUNDUM/i)
  })

  it('a non-numeric or negative bound is rejected, not coerced to 0', async () => {
    expect((await get('/api/task-events?from=abc&to=123')).status).toBe(400)
    expect((await get('/api/task-events?from=-5&to=123')).status).toBe(400)
    expect((await get('/api/task-events?from=1.5&to=123')).status).toBe(400)
  })

  it('an inverted or empty window is rejected', async () => {
    expect((await get(`/api/task-events?from=${T0}&to=${T0}`)).status).toBe(400)
    expect((await get(`/api/task-events?from=${T0}&to=${T0 - 1}`)).status).toBe(400)
  })

  it('an over-wide window is REFUSED rather than silently truncated', async () => {
    // Truncating here would hand back a slice that looks complete -- the caller must be told.
    const r = await get(`/api/task-events?from=${T0}&to=${T0 + 40 * 86_400_000}`)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/31 nap/)
  })

  it('rejects a limit outside 1..2000', async () => {
    expect((await get(`/api/task-events?from=${T0}&to=${T0 + 1000}&limit=0`)).status).toBe(400)
    expect((await get(`/api/task-events?from=${T0}&to=${T0 + 1000}&limit=2001`)).status).toBe(400)
  })

  it('truncated is FALSE on an exactly-full page, and TRUE when there is really more', async () => {
    // The off-by-one this pins: comparing rows.length === limit reports truncation on a full page
    // that had nothing after it, which would show a permanent "more data" hint on a complete window.
    for (let i = 1; i <= 3; i++) task(i, 'a', 'x', T0 + i * 1000, 100)
    const exact = await get(`/api/task-events?from=${T0}&to=${T0 + 60_000}&limit=3`)
    expect(exact.body.events).toHaveLength(3)
    expect(exact.body.truncated).toBe(false)

    const cut = await get(`/api/task-events?from=${T0}&to=${T0 + 60_000}&limit=2`)
    expect(cut.body.events).toHaveLength(2)
    expect(cut.body.truncated).toBe(true)
  })

  it('serves the summary on its own path', async () => {
    usage('a', 'claude-opus-5', T0 + 1000, 5, 5)
    const r = await get(`/api/task-summary?from=${T0}&to=${T0 + 60_000}`)
    expect(r.status).toBe(200)
    expect(r.body.activeModels).toBe(1)
    expect(r.body.blockCoverage.lanes).toEqual(['local'])
  })
})
