import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, getDb, createApproval, resolveApproval, getApproval, consumeApproval, listApprovalEvents,
} from '../db.js'
import { tryHandleApprovals, ONESHOT_CONSUME_ALLOWED_CATEGORIES, oneshotConsumeWindowSeconds } from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'
import { MAIN_AGENT_ID } from '../config.js'

// Card 2a80c6cb delta round: CYBERED NO-GO 27872 (P8) + CYBERSEC NO-GO 27873 (W1, W2). The
// original M2 fix (consumeApproval atomicity) was already unit-tested by probe commits in a
// disposable worktree during the gate, never landed as a real test -- this file is the durable
// pin for consumeApproval() itself plus the three delta findings below.

const GPU = 'gpu-driver-silent-install'

function approval(id: string, opts: { category?: string; status?: 'pending' | 'approved' | 'rejected'; resolvedBy?: string } = {}) {
  createApproval({ id, agent_id: 'agent-a', category: opts.category ?? GPU, action_description: 'install newer driver' })
  const status = opts.status ?? 'approved'
  if (status !== 'pending') resolveApproval(id, status, opts.resolvedBy ?? 'owner-a-tg-101')
  return getApproval(id)!
}

function oneshotCtx(id: string, body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const path = `/api/approvals/${id}/consume-oneshot`
  const url = new URL(`http://localhost:3420${path}`)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path, method: 'POST', url } as RouteContext, out }
}

function postCtx(body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const path = '/api/approvals'
  const url = new URL(`http://localhost:3420${path}`)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path, method: 'POST', url } as RouteContext, out }
}

function patchCtx(id: string, body: unknown, auth?: RouteContext['auth']): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const path = `/api/approvals/${id}`
  const url = new URL(`http://localhost:3420${path}`)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path, method: 'PATCH', url, auth } as RouteContext, out }
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('consumeApproval (M2, 2a80c6cb)', () => {
  it('a pending approval refuses with not_approved and consumed_at stays null', () => {
    approval('p1', { status: 'pending' })
    const r = consumeApproval({ id: 'p1', category: GPU, consumer: 'oneshot-api', windowSeconds: 3600 })
    expect(r).toMatchObject({ ok: false, reason: 'not_approved' })
    expect(getApproval('p1')!.consumed_at).toBeNull()
  })

  it('a rejected approval refuses with not_approved', () => {
    approval('p2', { status: 'rejected' })
    expect(consumeApproval({ id: 'p2', category: GPU, consumer: 'oneshot-api', windowSeconds: 3600 }))
      .toMatchObject({ ok: false, reason: 'not_approved' })
  })

  it('an approved row older than the window refuses as expired', () => {
    const row = approval('p3')
    const r = consumeApproval({ id: 'p3', category: GPU, consumer: 'oneshot-api', windowSeconds: 3600, nowS: (row.resolved_at ?? 0) + 3601 })
    expect(r).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('8 parallel consumes on one approved row: exactly one wins, the rest get already_consumed', () => {
    approval('p4')
    const results = Array.from({ length: 8 }, () => consumeApproval({ id: 'p4', category: GPU, consumer: 'oneshot-api', windowSeconds: 3600 }))
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(results.filter(r => !r.ok && r.reason === 'already_consumed')).toHaveLength(7)
  })

  it('writes a consumed event on success and a consume_refused event on refusal', () => {
    approval('p5')
    consumeApproval({ id: 'p5', category: GPU, consumer: 'oneshot-api', windowSeconds: 3600 })
    consumeApproval({ id: 'p5', category: GPU, consumer: 'oneshot-api', windowSeconds: 3600 })
    expect(listApprovalEvents('p5').map(e => [e.event, e.reason])).toEqual([
      ['consumed', null],
      ['consume_refused', 'already_consumed'],
    ])
  })
})

describe('W2 (CYBERSEC NO-GO 27873): consume-oneshot must not be category-generic', () => {
  it('rejects a category outside the allowlist before touching the row', async () => {
    approval('w2-email', { category: 'email_send' })
    const { ctx, out } = oneshotCtx('w2-email', { category: 'email_send' })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(403)
    expect(out.body).toMatchObject({ ok: false, reason: 'category_not_allowed' })
    // the approved email_send row must be untouched -- this is the exact P8/W2 probe: an approved
    // approval of a DIFFERENT feature's category must not be burnable through this route.
    expect(getApproval('w2-email')!.consumed_at).toBeNull()
  })

  it('still accepts the one legitimate category', async () => {
    approval('w2-gpu')
    const { ctx, out } = oneshotCtx('w2-gpu', { category: GPU })
    await tryHandleApprovals(ctx)
    expect(out.body).toMatchObject({ ok: true })
    expect(getApproval('w2-gpu')!.consumed_at).not.toBeNull()
  })

  it('the allowlist names exactly the one real caller category', () => {
    expect(ONESHOT_CONSUME_ALLOWED_CATEGORIES).toEqual([GPU])
  })
})

describe('W1 (CYBERSEC NO-GO 27873): consume-oneshot window is server-owned, not caller-supplied', () => {
  it('a 10-day-stale approval stays refused through the HTTP route even when the body asks for a huge window_seconds', async () => {
    approval('w1-stale')
    const tenDaysAgo = Math.floor(Date.now() / 1000) - 10 * 24 * 3600
    getDb().prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(tenDaysAgo, 'w1-stale')

    // Pre-fix behaviour (regression pin): the SAME forged window_seconds the gate measured
    // (1e9) used to flip this exact row from refused to consumed through this exact route.
    const { ctx, out } = oneshotCtx('w1-stale', { category: GPU, window_seconds: 1e9 })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(409)
    expect(out.body).toMatchObject({ ok: false, reason: 'expired' })
    expect(getApproval('w1-stale')!.consumed_at).toBeNull()
  })

  it('a fresh approval is still consumable normally -- the fix does not break the happy path', async () => {
    approval('w1-fresh')
    const { ctx, out } = oneshotCtx('w1-fresh', { category: GPU })
    await tryHandleApprovals(ctx)
    expect(out.body).toMatchObject({ ok: true })
  })

  it('oneshotConsumeWindowSeconds takes no caller-controlled window argument by construction', () => {
    // .length excludes the defaulted env param, so a 0-arg signature here means: the only input is
    // process.env, never request-body data -- if a future edit adds a window_seconds parameter,
    // this assertion catches it even before any route-level test would.
    expect(oneshotConsumeWindowSeconds.length).toBe(0)
  })
})

describe('P8 (CYBERED NO-GO 27872): approving gpu-driver-silent-install is hard fail-closed', () => {
  it('refuses to approve even with a DIFFERENT resolved_by than the requester (the self-approval bypass)', async () => {
    createApproval({ id: 'p8-1', agent_id: 'backend2', category: GPU, action_description: 'install newer driver' })
    const { ctx, out } = patchCtx('p8-1', { status: 'approved', resolved_by: 'not-backend2-at-all' })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(403)
    expect(getApproval('p8-1')!.status).toBe('pending')
  })

  it('refuses even with a session auth kind (the auth-kind check this precedent already showed insufficient)', async () => {
    createApproval({ id: 'p8-2', agent_id: 'backend2', category: GPU, action_description: 'install newer driver' })
    const { ctx, out } = patchCtx('p8-2', { status: 'approved', resolved_by: 'owner' }, { kind: 'session', user: 'peti' })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(403)
    expect(getApproval('p8-2')!.status).toBe('pending')
  })

  it('does not block rejecting or timing out a gpu-driver-silent-install request', async () => {
    createApproval({ id: 'p8-3', agent_id: 'backend2', category: GPU, action_description: 'install newer driver' })
    const { ctx, out } = patchCtx('p8-3', { status: 'rejected', resolved_by: 'owner' })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    expect(getApproval('p8-3')!.status).toBe('rejected')
  })

  it('does not block approving a DIFFERENT category', async () => {
    createApproval({ id: 'p8-4', agent_id: 'backend2', category: 'email_send', action_description: 'send mail' })
    const { ctx, out } = patchCtx('p8-4', { status: 'approved', resolved_by: 'owner' })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    expect(getApproval('p8-4')!.status).toBe('approved')
  })

  it('end-to-end: a gpu-driver-silent-install approval can never reach consumed, because it can never reach approved', async () => {
    createApproval({ id: 'p8-5', agent_id: 'backend2', category: GPU, action_description: 'install newer driver' })
    await tryHandleApprovals(patchCtx('p8-5', { status: 'approved', resolved_by: 'anyone-else' }).ctx)
    expect(getApproval('p8-5')!.status).toBe('pending')
    await tryHandleApprovals(oneshotCtx('p8-5', { category: GPU }).ctx)
    expect(getApproval('p8-5')!.consumed_at).toBeNull()
  })

  // H1 (Cybersec delta re-gate, comment 27965): the PATCH hard-refuse above has a second,
  // unguarded door into the same "approved" state. Any holder of the shared bearer token can
  // self-declare agent_id = MAIN_AGENT_ID (not a secret) on POST /api/approvals and attach
  // owner_approved_message_id -- createAndNotifyApproval resolves the row 'approved' on that
  // path alone, with no PATCH and no real check that the owner actually said anything.
  // Measured by Cybersec on 403ee09bc: this reaches 201 {status:'approved'}, and the
  // consume-oneshot that follows returns 200 -- the install fires with zero human in the loop.
  it('H1: POST with agent_id=MAIN_AGENT_ID + owner_approved_message_id is refused for gpu-driver-silent-install, not born approved', async () => {
    const { ctx, out } = postCtx({
      agent_id: MAIN_AGENT_ID,
      category: GPU,
      action_description: 'install newer driver',
      owner_approved_message_id: 4242,
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/gpu-driver-silent-install/)
    // no row was created at all -- a caller probing this path learns nothing it can retry with
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM approvals WHERE category = ?').get(GPU) as { n: number }).toEqual({ n: 0 })
  })

  it('H1 end-to-end: the same POST path can never reach consumed either, same as the PATCH path above', async () => {
    const { ctx, out } = postCtx({
      agent_id: MAIN_AGENT_ID,
      category: GPU,
      action_description: 'install newer driver',
      owner_approved_message_id: 4242,
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(403)
    // nothing exists to consume -- confirm no approved row of this category exists anywhere
    const rows = getDb().prepare("SELECT status FROM approvals WHERE category = ?").all(GPU) as { status: string }[]
    expect(rows.every(r => r.status !== 'approved')).toBe(true)
  })

  it('H1 control: a DIFFERENT category still gets born approved through the same POST field (no over-broad refusal)', async () => {
    const { ctx, out } = postCtx({
      agent_id: MAIN_AGENT_ID,
      category: 'email_send',
      action_description: 'send mail',
      owner_approved_message_id: 4243,
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(201)
    expect(out.body.status).toBe('approved')
  })
})
