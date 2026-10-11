// Card 67e73b48 (RedHat R2, 1d31cfcc follow-up): POST /api/connectors with scope=project and
// type=stdio writes an arbitrary command into PROJECT_ROOT/.mcp.json, which every agent's Claude
// Code session loads via ancestor-directory discovery regardless of its own .mcp.json/inheritance
// filter (R1) -- the shared fleet dashboard bearer every agent holds could otherwise plant a
// command there and have it reach the whole fleet. Same human-only posture as POST
// /api/fleet/import?apply=true (fleet.ts, card 68254bd7, fleet-import-auth-gate.test.ts): a
// browser session or a device key, never the shared 'token' credential. Route-level test: the
// auth-kind gate runs right after body parsing, before any `claude mcp add` shell-out, so a 403
// (or its absence) is enough to pin the gate without a real connector pipeline.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { tryHandleConnectors } from '../web/routes/connectors.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/exec-async.js', () => ({
  execShellAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

function fakeCtx(auth: RouteContext['auth'], body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const req: any = new EventEmitter()
  req.headers = {}
  const url = new URL('http://localhost:3420/api/connectors')
  const ctx = { req, res, path: url.pathname, method: 'POST', url, auth } as RouteContext
  const payload = JSON.stringify(body)
  process.nextTick(() => {
    req.emit('data', Buffer.from(payload))
    req.emit('end')
  })
  return { ctx, out }
}

const projectStdioBody = { name: 'evil', type: 'stdio', command: 'whatever', scope: 'project' }

describe('POST /api/connectors -- auth-kind gate on scope=project + type=stdio (card 67e73b48)', () => {
  it('project-scope stdio with the shared agent bearer (kind: token) is rejected, 403', async () => {
    const { ctx, out } = fakeCtx({ kind: 'token' }, projectStdioBody)
    expect(await tryHandleConnectors(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/browser session or a device key/)
  })

  it('project-scope stdio with no auth principal at all is rejected, 403', async () => {
    const { ctx, out } = fakeCtx(undefined, projectStdioBody)
    expect(await tryHandleConnectors(ctx)).toBe(true)
    expect(out.status).toBe(403)
  })

  it('project-scope stdio with a federation peer credential is rejected, 403 (not on the allowlist)', async () => {
    const { ctx, out } = fakeCtx({ kind: 'federation', peer: 'some-peer' }, projectStdioBody)
    expect(await tryHandleConnectors(ctx)).toBe(true)
    expect(out.status).toBe(403)
  })

  it('project-scope stdio with a browser session passes the gate (reaches claude mcp add, not a 403)', async () => {
    const { ctx, out } = fakeCtx({ kind: 'session', user: 'peti' }, projectStdioBody)
    expect(await tryHandleConnectors(ctx)).toBe(true)
    expect(out.status).not.toBe(403)
  })

  it('project-scope stdio with a device key passes the gate (reaches claude mcp add, not a 403)', async () => {
    const { ctx, out } = fakeCtx({ kind: 'device', device: 'phone', deviceId: 1 }, projectStdioBody)
    expect(await tryHandleConnectors(ctx)).toBe(true)
    expect(out.status).not.toBe(403)
  })

  it('USER-scope stdio with the shared agent bearer is NOT blocked by this gate (scope=project only)', async () => {
    const { ctx, out } = fakeCtx({ kind: 'token' }, { ...projectStdioBody, scope: 'user' })
    expect(await tryHandleConnectors(ctx)).toBe(true)
    expect(out.status).not.toBe(403)
  })

  it('project-scope HTTP (not stdio) with the shared agent bearer is NOT blocked by this gate (stdio only)', async () => {
    const { ctx, out } = fakeCtx({ kind: 'token' }, { name: 'remote', type: 'http', url: 'https://example.com/mcp', scope: 'project' })
    expect(await tryHandleConnectors(ctx)).toBe(true)
    expect(out.status).not.toBe(403)
  })

  // MUTATION PIN: without the gate, a token-credentialed request would sail straight through to
  // `claude mcp add` (mocked here) and return 200 -- this is the case that flips if the
  // `data.scope === 'project' && data.type === 'stdio' && ctx.auth?.kind !== 'session' &&
  // ctx.auth?.kind !== 'device'` check is ever removed.
  it('MUTATION PIN: self-check -- a session-credentialed request past the gate returns ok:true, never 403', async () => {
    const { ctx, out } = fakeCtx({ kind: 'session', user: 'peti' }, projectStdioBody)
    expect(await tryHandleConnectors(ctx)).toBe(true)
    expect(out.status).not.toBe(403)
    expect(out.body.ok).toBe(true)
  })
})
