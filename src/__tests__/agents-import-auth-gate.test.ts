// Card 4f4cb0df (WhiteHat, 68254bd7 szomszédja): POST /api/agents/import's overwrite=1 replaces an
// EXISTING agent's directory (hooks, settings, config included) and is reachable with the shared
// fleet dashboard bearer every agent holds -- the same hibaosztály fleet-transfer.ts's apply=true
// had. 68254bd7's own delta-gate (RedHat NO-GO 14953/14953, MikroB decision 14957) found that a
// session/device auth-kind check alone is not a closed gate (the shared bearer can mint itself a
// session/device credential elsewhere), and that a bespoke approval mechanism (PATCH
// /api/approvals/:id) is forgeable the same way. So, like FLEET_IMPORT_APPLY_FAIL_CLOSED in
// routes/fleet.ts, overwrite=1 here is hard fail-closed: ALWAYS 403, for every auth kind, with no
// bundle ever extracted, until card 3fb0ef97 (non-forgeable approval channel) ships.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tryHandleAgents } from '../web/routes/agents.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function fakeCtx(
  qs: string,
  auth: RouteContext['auth'],
  bodyBuf: Buffer = Buffer.from('not-a-real-tar-but-non-empty'),
): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const req: any = new EventEmitter()
  req.headers = {}
  const url = new URL(`http://localhost:3420/api/agents/import${qs}`)
  req.url = url.pathname + url.search
  const ctx = { req, res, path: url.pathname, method: 'POST', url, auth } as RouteContext
  setImmediate(() => {
    req.emit('data', bodyBuf)
    req.emit('end')
  })
  return { ctx, out }
}

describe('POST /api/agents/import -- overwrite=1 is hard fail-closed (card 4f4cb0df)', () => {
  let webDir: string
  beforeEach(() => { webDir = mkdtempSync(join(tmpdir(), 'agents-import-gate-test-')) })
  afterEach(() => { rmSync(webDir, { recursive: true, force: true }) })

  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as RouteContext['auth']],
    ['no auth principal at all', undefined],
    ['a federation peer credential', { kind: 'federation', peer: 'some-peer' } as RouteContext['auth']],
    ['a browser session', { kind: 'session', user: 'peti' } as RouteContext['auth']],
    ['a device key', { kind: 'device', device: 'phone', deviceId: 1 } as RouteContext['auth']],
  ])('refused, 403, with %s -- before any bundle extraction', async (_label, auth) => {
    const { ctx, out } = fakeCtx('?overwrite=1', auth)
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/3fb0ef97/)
  })

  it('refused via overwrite=true (not just =1)', async () => {
    const { ctx, out } = fakeCtx('?overwrite=true', { kind: 'token' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(403)
  })

  it('a fresh (non-overwrite) import is NOT refused by this gate -- it reaches extraction and fails on the garbage body instead', async () => {
    const { ctx, out } = fakeCtx('', { kind: 'token' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    // The gate itself must not have fired; the 400 below comes from the (intentionally invalid)
    // tar body failing extraction, proving we got past the overwrite check.
    expect(out.status).not.toBe(403)
    expect(out.body.error).toMatch(/could not extract/)
  })

  // MUTATION PIN: without AGENT_IMPORT_OVERWRITE_FAIL_CLOSED (or with it flipped), overwrite=1
  // would instead reach importAgentBundle/importAllAgentsBundle directly and fail differently (a
  // tar-extraction 400, not a 403 naming 3fb0ef97). This message is unique to the hard gate.
  it('MUTATION PIN: the refusal message names the specific disabled-until-3fb0ef97 reason', async () => {
    const { ctx, out } = fakeCtx('?overwrite=1', { kind: 'session', user: 'peti' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.body.error).toBe(
      'Agent import (overwrite=1) is disabled until a non-forgeable approval channel ships (card 3fb0ef97). Re-import under a different name, or delete the existing agent first, for now.',
    )
  })
})
