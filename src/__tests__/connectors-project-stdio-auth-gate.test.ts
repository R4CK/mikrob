// Card 67e73b48 (RedHat R2, 1d31cfcc follow-up): POST /api/connectors with scope=project and
// type=stdio writes an arbitrary command into PROJECT_ROOT/.mcp.json, which every agent's Claude
// Code session loads via ancestor-directory discovery regardless of its own .mcp.json/inheritance
// filter (R1) -- the shared fleet dashboard bearer every agent holds could otherwise plant a
// command there and have it reach the whole fleet.
//
// Card 34f972bb delta (RedHat GO 67e73b48, comment 15391, R1): the session/device kind-check this
// file originally pinned is not a closed gate on its own -- the shared fleet bearer can mint
// itself a session via the break-glass password-reset + login path (auth.ts:265-297, unrelated to
// this file) without ever holding a real human credential. Until card 3fb0ef97 (a non-forgeable
// approval channel) ships, a project-scope stdio write is hard fail-closed: ALWAYS 403, for every
// auth kind. This file now pins that unconditional refusal rather than the session/device
// allowance it supersedes -- same posture as fleet-import-auth-gate.test.ts (card 657b32f2).
//
// Route-level test: the gate runs right after body parsing, before any `claude mcp add` shell-out,
// so a 403 (or its absence) is enough to pin the gate without a real connector pipeline.
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

describe('POST /api/connectors -- scope=project + type=stdio is hard fail-closed (card 34f972bb)', () => {
  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as RouteContext['auth']],
    ['no auth principal at all', undefined],
    ['a federation peer credential', { kind: 'federation', peer: 'some-peer' } as RouteContext['auth']],
    ['a browser session', { kind: 'session', user: 'peti' } as RouteContext['auth']],
    ['a device key', { kind: 'device', device: 'phone', deviceId: 1 } as RouteContext['auth']],
  ])('refused, 403, with %s -- before any `claude mcp add` shell-out', async (_label, auth) => {
    const { ctx, out } = fakeCtx(auth, projectStdioBody)
    expect(await tryHandleConnectors(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/3fb0ef97/)
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

  // MUTATION PIN: without CONNECTORS_PROJECT_STDIO_FAIL_CLOSED (or with it flipped), a
  // session-credentialed request would instead reach the OLD kind-check below (which it already
  // passes) and sail through to `claude mcp add` (mocked here), returning ok:true. The message
  // below is the one unique to this hard gate, so a flip (or a condition broadened/narrowed by a
  // future edit) changes the assertion, not just the status code.
  it('MUTATION PIN: the refusal message names the specific disabled-until-3fb0ef97 reason, even for a session', async () => {
    const { ctx, out } = fakeCtx({ kind: 'session', user: 'peti' }, projectStdioBody)
    expect(await tryHandleConnectors(ctx)).toBe(true)
    expect(out.body.error).toBe(
      'A project-scope stdio connector is disabled until a non-forgeable approval channel ships (card 3fb0ef97).',
    )
  })
})
