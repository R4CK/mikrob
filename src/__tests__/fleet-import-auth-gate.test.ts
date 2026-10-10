// Card 68254bd7 (MikroB follow-up, msg 10134): POST /api/fleet/import?apply=true must come from a
// human (browser session or device key) -- never the shared fleet dashboard bearer every agent
// holds, since that is a network-reachable, unlogged path to the same write a same-UID agent could
// already make on disk (card 8eca67f0).
//
// Card 68254bd7 delta (RedHat NO-GO 14837, MikroB decision 14841): the kind-check alone is not a
// closed gate -- the shared bearer can mint itself a session/device credential via three other
// routes. apply=true additionally requires a human-RESOLVED, content-bound /api/approvals row.
//
// Card 657b32f2 (RedHat delta-gate 14953, MikroB decision 14957): THAT approval mechanism is not a
// human-enforced gate either -- PATCH /api/approvals/:id has no auth-kind check, and resolved_by is
// self-reported, so the SAME shared bearer the kind-check blocks can mint its own "approved" row.
// Until card 3fb0ef97 (a non-forgeable approval channel) ships, apply=true is hard fail-closed:
// ALWAYS 403, for every auth kind and every approval state, and NO approval request is even opened.
// This file now pins that unconditional refusal rather than the approval state machine it
// supersedes -- real sqlite (':memory:', same pattern as approvals.test.ts) is still used so the
// "no approval row gets created" assertion is a real DB read, not a mock trusting itself.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { tryHandleFleet, fleetImportContentHash, fleetImportApprovalDescription } from '../web/routes/fleet.js'
import { initDatabase, createApproval, resolveApproval, listApprovals } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn().mockResolvedValue(null),
}))

beforeEach(() => {
  initDatabase(':memory:')
})

function fakeCtx(
  qs: string,
  auth: RouteContext['auth'],
): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const req: any = new EventEmitter()
  req.headers = {}
  const url = new URL(`http://localhost:3420/api/fleet/import${qs}`)
  const ctx = { req, res, path: url.pathname, method: 'POST', url, auth } as RouteContext
  // readBody resolves on 'end' -- emit it on the next tick so tryHandleFleet's await readBody(req) sees it.
  setImmediate(() => req.emit('end'))
  return { ctx, out }
}

describe('POST /api/fleet/import -- apply=true is hard fail-closed (card 657b32f2)', () => {
  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as RouteContext['auth']],
    ['no auth principal at all', undefined],
    ['a federation peer credential', { kind: 'federation', peer: 'some-peer' } as RouteContext['auth']],
    ['a browser session', { kind: 'session', user: 'peti' } as RouteContext['auth']],
    ['a device key', { kind: 'device', device: 'phone', deviceId: 1 } as RouteContext['auth']],
  ])('refused, 403, with %s -- before any body read or approval lookup', async (_label, auth) => {
    const { ctx, out } = fakeCtx('?apply=true', auth)
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/3fb0ef97/)
  })

  it('refused even with a matching APPROVED approval already on file (the gate the shared bearer could forge)', async () => {
    const rawBody = ''
    createApproval({
      id: 'ap-preexisting',
      agent_id: 'peti',
      category: 'fleet_import_apply',
      action_description: 'test fixture',
      content_hash: fleetImportContentHash(rawBody, false),
    })
    resolveApproval('ap-preexisting', 'approved', 'owner')
    const { ctx, out } = fakeCtx('?apply=true', { kind: 'session', user: 'peti' })
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.status).toBe(403)
  })

  it('no approval row is ever created for an apply=true call -- the old auto-open behavior is gone', async () => {
    const before = listApprovals({ category: 'fleet_import_apply' }).length
    const { ctx, out } = fakeCtx('?apply=true', { kind: 'session', user: 'peti' })
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.body.approval_id).toBeUndefined()
    expect(listApprovals({ category: 'fleet_import_apply' }).length).toBe(before)
  })

  it('dry-run (apply absent/false) is NOT affected -- it writes nothing anyway', async () => {
    const { ctx, out } = fakeCtx('', { kind: 'token' })
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.status).not.toBe(403)
  })

  // MUTATION PIN: without FLEET_IMPORT_APPLY_FAIL_CLOSED (or with it flipped), apply=true with a
  // session auth kind and no approval would instead reach the OLD approval-opening code and return
  // 403 with a DIFFERENT message ("human-approved request", approval_id set) or, with an approved
  // approval already seeded, would sail through to importFleet entirely (400 on the empty test
  // body). Either shape is wrong now; the message below is the one unique to this hard gate.
  it('MUTATION PIN: the refusal message names the specific disabled-until-3fb0ef97 reason', async () => {
    const { ctx, out } = fakeCtx('?apply=true', { kind: 'session', user: 'peti' })
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.body.error).toBe(
      'Fleet import (apply=true) is disabled until a non-forgeable approval channel ships (card 3fb0ef97). Use apply=false (dry-run) for now.',
    )
  })
})

// Card 657b32f2 F-A (RedHat delta-gate 14953): allowRiskyFields must be bound into the content
// hash, so an approval granted for allowRiskyFields=false cannot later authorize the same body
// resent with allowRiskyFields=true. Unit-tested directly since the call site that uses this is
// currently unreachable (FLEET_IMPORT_APPLY_FAIL_CLOSED) -- the function itself is not.
describe('fleetImportContentHash (card 657b32f2 F-A)', () => {
  it('the SAME body with a DIFFERENT allowRiskyFields value hashes differently', () => {
    const a = fleetImportContentHash('{"same":"body"}', false)
    const b = fleetImportContentHash('{"same":"body"}', true)
    expect(a).not.toBe(b)
  })

  it('matches the OLD (rawBody-only) hash shape when the flag is false, for a human sanity check', () => {
    // Not a compatibility requirement -- just confirms the new hash is still deterministic sha256
    // over the body plus a stable suffix, not something that moves on every call.
    const rawBody = '{"x":1}'
    expect(fleetImportContentHash(rawBody, false)).toBe(fleetImportContentHash(rawBody, false))
    expect(fleetImportContentHash(rawBody, false)).not.toBe(createHash('sha256').update(rawBody).digest('hex'))
  })
})

// Card 657b32f2 F-B (RedHat delta-gate 14953): the approval description must name the surfaces
// that change, and call out the risky-field classes specifically when allowRiskyFields is set.
describe('fleetImportApprovalDescription (card 657b32f2 F-B)', () => {
  it('without allowRiskyFields: names the verbatim surfaces, not the risky fields', () => {
    const desc = fleetImportApprovalDescription(123, false)
    expect(desc).toContain('123 bytes')
    expect(desc).toContain('CLAUDE.md/SOUL.md')
    expect(desc).not.toContain('toolDeny')
  })

  it('with allowRiskyFields: additionally names every risky field class', () => {
    const desc = fleetImportApprovalDescription(456, true)
    expect(desc).toContain('456 bytes')
    for (const field of ['toolDeny', 'securityProfile', 'capabilities', 'customProvider', 'settings.hooks']) {
      expect(desc).toContain(field)
    }
  })
})
