// Card 2ba008f2 (elemzo plan-grilling on d5638d28, comment 32144, C1): a 'night' scoped device
// key reaches exactly 3 things -- GET under /api/kanban, POST a comment, POST a message -- and
// nothing else, decided before any handler, same chokepoint/shape as operator-scope-gate.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { initDatabase, createKanbanCard, getKanbanCard, getKanbanComments } from '../db.js'
import { createDeviceKey, resolveDeviceKey, _clearDeviceKeyCacheForTest, NIGHT_KEY_MAX_EXPIRY_DAYS } from '../web/auth-device-keys.js'
import { resolveAuth } from '../web/auth-gate.js'
import { nightGateDecision } from '../web/night-gate.js'
import { tryHandleKanban, NIGHT_COMMENT_AUTHOR, NIGHT_COMMENT_MARKER } from '../web/routes/kanban.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { agentDir } from '../web/agent-config.js'
import type { RouteContext } from '../web/routes/types.js'

// POST /api/messages refuses an unregistered `from` agent id (unrelated to this card) -- mirrors
// message-precedence.test.ts's own fixture agent dirs.
const MSG_TEST_AGENTS = ['night-loop', 'qa', 'backend', 'mikrob']

beforeAll(() => {
  initDatabase(':memory:')
  for (const a of MSG_TEST_AGENTS) mkdirSync(agentDir(a), { recursive: true })
})
afterAll(() => {
  for (const a of MSG_TEST_AGENTS) rmSync(agentDir(a), { recursive: true, force: true })
})
beforeEach(() => { _clearDeviceKeyCacheForTest() })

const night = { kind: 'device', scope: 'night' }

function enumerateApiPaths(): string[] {
  const root = join(__dirname, '..')
  const files = [join(root, 'web.ts'), ...readdirSync(join(root, 'web', 'routes')).filter(f => f.endsWith('.ts')).map(f => join(root, 'web', 'routes', f))]
  const out = new Set<string>()
  for (const f of files) {
    const src = readFileSync(f, 'utf-8')
    for (const m of src.matchAll(/'(\/api\/[A-Za-z0-9/_.-]*)'/g)) out.add(m[1]!)
    for (const m of src.matchAll(/\/\^(\\\/api\\\/[^\n]*?)\$\//g)) {
      const p = m[1]!
        .replace(/\([^)]*\)/g, 'x')
        .replace(/\[[^\]]*\][+*]?/g, 'x')
        .replace(/\\\//g, '/')
        .replace(/[?+*\\]/g, '')
      if (p.startsWith('/api/')) out.add(p)
    }
  }
  return [...out].sort()
}

describe('nightGateDecision over every enumerated /api path', () => {
  const paths = enumerateApiPaths()

  it('the enumeration is not trivially small', () => {
    expect(paths.length).toBeGreaterThan(150)
  })

  it('a night key is refused on every GET path outside /api/kanban', () => {
    const allowed = paths.filter((p) => !p.startsWith('/api/kanban') && nightGateDecision(night, p, 'GET') === null)
    expect(allowed).toEqual([])
  })

  it('a night key is refused on every POST path except a comment route and /api/messages', () => {
    const allowed = paths.filter((p) => {
      if (p === '/api/messages') return false
      if (/^\/api\/kanban\/x\/comments$/.test(p)) return false
      return nightGateDecision(night, p, 'POST') === null
    })
    expect(allowed).toEqual([])
  })

  it('a GET under /api/kanban is allowed (board/cards/comments, read-only)', () => {
    expect(nightGateDecision(night, '/api/kanban', 'GET')).toBeNull()
    expect(nightGateDecision(night, '/api/kanban/abcd1234', 'GET')).toBeNull()
    expect(nightGateDecision(night, '/api/kanban/abcd1234/comments', 'GET')).toBeNull()
  })

  it('MUTATION-PIN-SHAPE: a POST (not GET) under /api/kanban that is not the comments route is refused', () => {
    expect(nightGateDecision(night, '/api/kanban', 'POST')).not.toBeNull()
    expect(nightGateDecision(night, '/api/kanban/abcd1234', 'PUT')).not.toBeNull()
    expect(nightGateDecision(night, '/api/kanban/abcd1234/breakdown/accept', 'POST')).not.toBeNull()
  })

  it('POST on a comment route is allowed, PUT/DELETE on the same path are not', () => {
    expect(nightGateDecision(night, '/api/kanban/abcd1234/comments', 'POST')).toBeNull()
    expect(nightGateDecision(night, '/api/kanban/abcd1234/comments', 'PUT')).not.toBeNull()
    expect(nightGateDecision(night, '/api/kanban/abcd1234/comments', 'DELETE')).not.toBeNull()
  })

  it('POST /api/messages is allowed by the gate (the `to` restriction is enforced in the route)', () => {
    expect(nightGateDecision(night, '/api/messages', 'POST')).toBeNull()
  })

  it('/api/agents/:name/start, card create, and PUT card are all refused', () => {
    expect(nightGateDecision(night, '/api/agents/backend/start', 'POST')).not.toBeNull()
    expect(nightGateDecision(night, '/api/kanban', 'POST')).not.toBeNull()
    expect(nightGateDecision(night, '/api/kanban/abcd1234', 'PUT')).not.toBeNull()
  })

  it('every other credential is untouched by the gate', () => {
    for (const kind of ['token', 'session', 'federation']) {
      expect(nightGateDecision({ kind }, '/api/agents/backend/start', 'POST')).toBeNull()
    }
    expect(nightGateDecision({ kind: 'device', scope: 'full' }, '/api/agents/backend/start', 'POST')).toBeNull()
    expect(nightGateDecision({ kind: 'device', scope: 'operator' }, '/api/agents/backend/start', 'POST')).toBeNull()
  })
})

describe('the night gate binding in web.ts', () => {
  const SRC = readFileSync(join(__dirname, '../web.ts'), 'utf-8')

  it('runs after the 401 check, after the operator gate, and before ANY handler', () => {
    const unauthorized = SRC.indexOf("res.end(JSON.stringify({ error: 'Unauthorized' }))")
    const operatorGate = SRC.indexOf('operatorGateDecision(auth, path, () => readOperatorAccess())')
    const nightGate = SRC.indexOf('nightGateDecision(auth, path, method)')
    const firstHandler = SRC.indexOf('if (await tryHandleAuth(routeCtx)) return')
    expect(unauthorized).toBeGreaterThan(0)
    expect(operatorGate).toBeGreaterThan(unauthorized)
    expect(nightGate).toBeGreaterThan(operatorGate)
    expect(nightGate).toBeLessThan(firstHandler)
    expect(SRC.slice(nightGate - 200, nightGate)).toMatch(/if \(requiresAuth\(path, method\)\) \{/)
  })
})

describe('night device keys', () => {
  it('a night key cannot be minted without an expiry', () => {
    expect(() => createDeviceKey('it-night', { scope: 'night' })).toThrow(/must expire/)
  })

  it('a night key cannot exceed its max expiry', () => {
    expect(() => createDeviceKey('it-night', { scope: 'night', expiresInDays: NIGHT_KEY_MAX_EXPIRY_DAYS + 1 })).toThrow(/at most/)
  })

  it('the scope travels from the stored key to the gate', () => {
    const k = createDeviceKey('it-night', { scope: 'night', expiresInDays: 7 })
    _clearDeviceKeyCacheForTest()
    expect(resolveDeviceKey(k.key)?.scope).toBe('night')
    const req = { headers: { authorization: `Bearer ${k.key}` } } as unknown as IncomingMessage
    const auth = resolveAuth(req, new URL('http://x/api/kanban'), '/api/kanban', 'GET', 'a'.repeat(64))
    expect(auth).toMatchObject({ kind: 'device', scope: 'night' })
  })

  it('a key minted without a scope is still a full key (unaffected)', () => {
    const k = createDeviceKey('phone')
    expect(k.scope).toBe('full')
  })
})

function fakeCtx(method: string, path: string, body: unknown, auth: RouteContext['auth']) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { setHeader() { return res }, writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const req: any = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))])
  req.headers = { 'content-type': 'application/json' }
  return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`), auth } as RouteContext, out }
}

describe('POST /api/kanban/:id/comments -- night scope forces author and marker', () => {
  const nightAuth = { kind: 'device', scope: 'night' } as RouteContext['auth']

  it('a night-scoped comment ignores the caller-supplied author and gets the marker prefix', async () => {
    createKanbanCard({ id: 'night1', title: 'x', project: 'test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/night1/comments', { author: 'spoofed-qa', content: 'hello' }, nightAuth)
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    const [comment] = getKanbanComments('night1')
    expect(comment.author).toBe(NIGHT_COMMENT_AUTHOR)
    expect(comment.content).toBe(`[${NIGHT_COMMENT_MARKER}] hello`)
  })

  it('MUTATION PIN: a plain token-authed comment is UNAFFECTED (existing trust-boundary behavior)', async () => {
    createKanbanCard({ id: 'night2', title: 'x', project: 'test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/night2/comments', { author: 'qa', content: 'hello' }, { kind: 'token' } as RouteContext['auth'])
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    const [comment] = getKanbanComments('night2')
    expect(comment.author).toBe('qa')
    expect(comment.content).toBe('hello')
  })
})

describe('POST /api/messages -- night scope can only message mikrob', () => {
  const nightAuth = { kind: 'device', scope: 'night' } as RouteContext['auth']

  it('refuses a night-scoped message to anyone but mikrob', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/messages', { from: 'night-loop', to: 'backend', content: 'hi' }, nightAuth)
    expect(await tryHandleMessages(ctx)).toBe(true)
    expect(out.status).toBe(403)
  })

  it('allows a night-scoped message to mikrob', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/messages', { from: 'night-loop', to: 'mikrob', content: 'hi' }, nightAuth)
    expect(await tryHandleMessages(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('the restriction check itself is case-insensitive on `to` (a differently-cased refusal would still be wrong)', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/messages', { from: 'night-loop', to: 'MikroB', content: 'hi' }, nightAuth)
    expect(await tryHandleMessages(ctx)).toBe(true)
    // Not 403 from the night-scope restriction (it recognizes 'MikroB' as mikrob); any status here
    // is from unrelated recipient-registration casing, not from the thing this card fixes.
    expect(out.status).not.toBe(403)
  })

  it('MUTATION PIN: a plain token-authed message to any agent is unaffected', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/messages', { from: 'qa', to: 'backend', content: 'hi' }, { kind: 'token' } as RouteContext['auth'])
    expect(await tryHandleMessages(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })
})
