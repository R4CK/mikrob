// POST /api/stuck-incidents -- the seam the guard writes through (card 878cd292).
//
// The three things worth pinning here, none of them obvious from reading the handler:
//   - the route is GATED. /api/* auth is central in web.ts, so a new route inherits the bearer
//     requirement WITHOUT opting in -- but "inherits it" is an assumption about a file this module
//     does not own, and an unauthenticated write path into fleet telemetry is worth one assertion
//     rather than one belief.
//   - a malformed body is the CALLER's mistake: 400, never an unhandled throw in a request handler.
//     That is the same defect class the fork's own PUT /api/messages/:id hardening exists for.
//   - the two CALLING-ERROR verdicts answer 200 with `skipped`, not an error. They are not failures;
//     they are "this was not a decision about a stuck card". Answering 400 would make the guard's
//     own fail-open branch look like a broken write.
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { tryHandleStuckIncidents } from '../web/routes/stuck-incidents.js'
import { REPO_ROOT } from './helpers/repo-location.js'

const tmpDirs: string[] = []
function freshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'stuck-endpoint-'))
  tmpDirs.push(dir)
  initDatabase(join(dir, 'test.db'))
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

/** Minimal request/response doubles: this exercises the handler's own contract (status + body),
 *  which is what the guard depends on. The auth layer is asserted separately, against the real
 *  source, because it lives in web.ts and not here. */
function call(body: unknown, method = 'POST', path = '/api/stuck-incidents') {
  const chunks = [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = {
    [Symbol.asyncIterator]: async function* () {
      yield* chunks
    },
    on(event: string, cb: (...a: unknown[]) => void) {
      if (event === 'data') chunks.forEach((c) => cb(c))
      if (event === 'end') cb()
      return this
    },
  } as unknown as Parameters<typeof tryHandleStuckIncidents>[0]['req']
  const out: { status?: number; body?: unknown } = {}
  const res = {
    writeHead(status: number) {
      out.status = status
      return this
    },
    setHeader() {
      return this
    },
    end(payload?: string) {
      if (payload) out.body = JSON.parse(payload)
    },
  } as unknown as Parameters<typeof tryHandleStuckIncidents>[0]['res']
  return { out, handled: tryHandleStuckIncidents({ req, res, path, method } as never) }
}

describe('POST /api/stuck-incidents -- the route is GATED, not public', () => {
  it('/api/stuck-incidents is NOT on any public-path carve-out in web.ts', () => {
    // The assumption this makes explicit: /api/* is gated centrally, so a new route inherits the
    // bearer requirement. What would break that is somebody adding this path to a public list --
    // this fails if they do. An unauthenticated writer into fleet telemetry could fabricate
    // incidents, and the table's whole value is that its rows were not made up.
    const src = readFileSync(join(REPO_ROOT, 'src/web/auth-gate.ts'), 'utf-8')
    expect(src).not.toContain('stuck-incidents')
  })

  it('the route is registered in web.ts, so it is reachable at all', () => {
    // A handler nobody calls is the 501 shape: policied, present, and dead. Cheap to assert, and it
    // is the failure the CleanCore route-inventory guard exists for on the other repo.
    const src = readFileSync(join(REPO_ROOT, 'src/web.ts'), 'utf-8')
    expect(src).toContain('tryHandleStuckIncidents(routeCtx)')
  })
})

describe('POST /api/stuck-incidents -- contract', () => {
  it('records a detection and answers with the opened id', async () => {
    freshDb()
    const c = call({
      cardId: 'c1',
      assignee: 'backend3',
      verdict: 'DENY:agent-busy',
      detectedAt: 1_700_000_000,
      stalledMs: 900_000,
    })
    expect(await c.handled).toBe(true)
    expect((c.out.body as { kind: string }).kind).toBe('opened')
    expect(getDb().prepare(`SELECT COUNT(*) n FROM stuck_incidents`).get()).toEqual({ n: 1 })
  })

  it('a malformed body is 400, not a throw', async () => {
    freshDb()
    const c = call('{not json')
    expect(await c.handled).toBe(true)
    expect(c.out.status).toBe(400)
    expect((c.out.body as { error: string }).error).toMatch(/Invalid JSON/)
  })

  it.each([
    ['missing cardId', { verdict: 'ALLOW', detectedAt: 1, stalledMs: 1 }],
    ['empty cardId', { cardId: '  ', verdict: 'ALLOW', detectedAt: 1, stalledMs: 1 }],
    ['missing verdict', { cardId: 'c', detectedAt: 1, stalledMs: 1 }],
    ['non-numeric detectedAt', { cardId: 'c', verdict: 'ALLOW', detectedAt: 'x', stalledMs: 1 }],
    ['negative stalledMs', { cardId: 'c', verdict: 'ALLOW', detectedAt: 1, stalledMs: -1 }],
    ['non-string assignee', { cardId: 'c', assignee: 7, verdict: 'ALLOW', detectedAt: 1, stalledMs: 1 }],
  ])('%s -> 400 and NOTHING is written', async (_label, body) => {
    // A bad row is worse than no row here: it would be counted. Refusing the shape is the point.
    freshDb()
    const c = call(body)
    expect(await c.handled).toBe(true)
    expect(c.out.status).toBe(400)
    expect(getDb().prepare(`SELECT COUNT(*) n FROM stuck_incidents`).get()).toEqual({ n: 0 })
  })

  it('a CALLING-ERROR verdict answers 200 skipped, NOT an error', async () => {
    // It is not a failure -- it means "this was not a decision about a stuck card". Answering 400
    // would make the guard's fail-open branch indistinguishable from a broken write, which is the
    // exact distinction the skip reason exists to preserve.
    freshDb()
    const c = call({
      cardId: 'c1',
      assignee: 'backend3',
      verdict: 'DENY:usage',
      detectedAt: 1,
      stalledMs: 1,
    })
    expect(await c.handled).toBe(true)
    expect(c.out.status).toBe(200)
    expect((c.out.body as { kind: string; reason: string }).kind).toBe('skipped')
    expect((c.out.body as { reason: string }).reason).toMatch(/calling error/)
    expect(getDb().prepare(`SELECT COUNT(*) n FROM stuck_incidents`).get()).toEqual({ n: 0 })
  })

  it('does not claim other paths or methods', async () => {
    freshDb()
    expect(await call({}, 'GET').handled).toBe(false)
    expect(await call({}, 'POST', '/api/something-else').handled).toBe(false)
  })
})
