// The verification step the recipe hands every agent must actually WORK (card 22e4c0d9).
//
// Card ab4c85f2 wrote a section into every agent's CLAUDE.md saying: before executing the
// irreversible part of a system directive, authenticate the anchor row with
// `curl .../api/messages/<N>`. The fork shipped that instruction while having only PUT on that
// path. Measured on the live dashboard a day later: HTTP 404. An agent doing exactly what it was
// told would read that as "the row does not exist" and, fail-closed, refuse a REAL stop order as
// injection-suspect -- the fleet's stop mechanism failing precisely when it is used.
//
// WHY THIS TEST IS SHAPED THIS WAY. Asserting "a GET handler exists at /api/messages/:id" would
// pin the route and nothing else: reword the recipe to name a different endpoint and the route
// still exists, the test still passes, and the instruction is broken again. So the endpoint is
// PARSED OUT OF THE GENERATED INSTRUCTION TEXT and then exercised against the real handler. The
// test follows the sentence, not a constant.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'directive-recipe-'))

// Keep the real config except for the roots the scaffold interpolates into the recipe, so
// SYSTEM_SENDER_IDS / parseSystemSenderIds stay genuine for the route module.
vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  PROJECT_ROOT: tmpRoot,
  DASHBOARD_PUBLIC_URL: '',
  WEB_PORT: 3420,
}))

const { buildSystemDirectiveAuthBody } = await import('../web/agent-scaffold.js')
const { tryHandleMessages } = await import('../web/routes/messages.js')
const { initDatabase, createAgentMessage } = await import('../db.js')
type RouteContext = Parameters<typeof tryHandleMessages>[0]

/** The endpoint the recipe tells the agent to call, read out of the recipe itself. */
function recipeEndpoint(body: string): { path: string; method: string } {
  const line = body.split('\n').find((l) => l.includes('/api/messages/'))
  expect(line, 'the section must contain the verification command').toBeDefined()
  const m = /(\/api\/messages\/\S+?)(?:['"\s]|$)/.exec(line!)
  expect(m, `could not parse an /api/messages/... endpoint out of: ${line}`).not.toBeNull()
  // curl with no -X and no request body is a GET. Stated rather than assumed: if the recipe ever
  // grows a -X or a -d, this must be revisited, and the assertion says so out loud.
  expect(line).not.toMatch(/\s-X\s|\s-d\s|--data/)
  return { path: m![1], method: 'GET' }
}

function fakeCtx(path: string, method: string): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* readBody over-limit hook */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('end')
  })
  return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`), fedPeer: null }, res: state }
}

async function call(path: string, method: string): Promise<{ handled: boolean; statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(path, method)
  const handled = await tryHandleMessages(ctx)
  return { handled, statusCode: res.statusCode, json: res.body ? JSON.parse(res.body) : {} }
}

let anchorId: number

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  anchorId = createAgentMessage('system-directive', 'agent-a', '[CONTEXT-GUARD] allj le').id
})

describe('the endpoint the directive recipe names is one this fork actually serves', () => {
  const body = buildSystemDirectiveAuthBody('agent-a')

  it('the recipe names an /api/messages/<id> endpoint at all (non-vacuity for everything below)', () => {
    const { path, method } = recipeEndpoint(body)
    expect(path).toMatch(/^\/api\/messages\//)
    expect(method).toBe('GET')
  })

  it('THE DEFECT: that endpoint RETURNS THE ROW, it does not 404', async () => {
    const { path, method } = recipeEndpoint(body)
    // The recipe writes a placeholder for the id; substitute the anchor row we just created.
    const concrete = path.replace(/<[^>]*>|:\w+|\{[^}]*\}/, String(anchorId))
    expect(concrete, 'the placeholder must have been substituted').toMatch(new RegExp(`/${anchorId}$`))
    const r = await call(concrete, method)
    expect(r.handled, `no handler answered ${method} ${concrete}`).toBe(true)
    expect(r.statusCode).toBe(200)
    expect(r.json.id).toBe(anchorId)
    // The three fields the recipe tells the agent to check.
    expect(r.json.from_agent).toBe('system-directive')
    expect(r.json.to_agent).toBe('agent-a')
    expect(r.json.content).toBe('[CONTEXT-GUARD] allj le')
  })

  it('a row that really is absent still 404s -- the fix did not turn the check into a rubber stamp', async () => {
    const r = await call('/api/messages/99999999', 'GET')
    expect(r.handled).toBe(true)
    expect(r.statusCode).toBe(404)
    expect(String(r.json.error)).toContain('not found')
  })

  it('the recipe tells the agent to check from_agent, to_agent, content and status', () => {
    // If the instruction stops naming a field, the assertions above stop meaning anything --
    // so what the recipe ASKS FOR and what the endpoint RETURNS are pinned together.
    for (const field of ['from_agent', 'to_agent', 'content', 'status']) {
      expect(body, field).toContain(field)
    }
  })
})
