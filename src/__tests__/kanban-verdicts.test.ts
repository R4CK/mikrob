// Card 2bfa4c67 (F2): structured gate-verdict + gate-assignment records. Contract under test:
//   - the route is a pure pass-through (returns false) when AGENT_VERDICT_RECORD is off -- zero
//     new behavior on a fresh/default install;
//   - author resolution: an authenticated agent:<id> device key WINS and is marked verified; the
//     body's own `author` claim is accepted only as a fallback, marked UNVERIFIED;
//   - a gate may never verdict its own proposal (RedHat 16225 proposer-exclusion);
//   - gate-assignment writes are restricted to the actor allowlist (mikrob);
//   - gate-assignment is append-only, so its own row history IS the audit trail;
//   - the migration (CREATE TABLE IF NOT EXISTS) is idempotent and its rollback (DROP TABLE)
//     leaves every neighbouring table intact and is itself re-creatable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase, getDb, createKanbanCard, addKanbanComment } from '../db.js'
import { createDeviceKey } from '../web/auth-device-keys.js'
import { tryHandleKanbanVerdicts, resolveVerdictAuthor, isSelfProposedVerdict, isAgentVerdictRecordEnabled } from '../web/kanban-verdicts.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(path: string, method: string, body?: unknown, auth?: RouteContext['auth']): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url, auth } as RouteContext, out }
}

describe('kanban-verdicts', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createKanbanCard({ id: 'c1', title: 'x', status: 'planned' })
    process.env.AGENT_VERDICT_RECORD = '1'
  })
  afterEach(() => {
    delete process.env.AGENT_VERDICT_RECORD
  })

  describe('flag gating', () => {
    it('AGENT_VERDICT_RECORD unset/off: the route is a pure pass-through (returns false)', async () => {
      delete process.env.AGENT_VERDICT_RECORD
      expect(isAgentVerdictRecordEnabled()).toBe(false)
      const { ctx, out } = fakeCtx('/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'PASS', author: 'qa' })
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(false)
      expect(out.status).toBe(0) // nothing was written to the response at all
    })

    it('AGENT_VERDICT_RECORD=1: the route handles the request', async () => {
      createDeviceKey('agent:qa')
      const { ctx, out } = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'PASS' },
        { kind: 'device', device: 'agent:qa', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(201)
    })
  })

  describe('resolveVerdictAuthor', () => {
    it('an authenticated agent:<id> device key wins and is VERIFIED, even if the body claims someone else', () => {
      createDeviceKey('agent:qa')
      const { author, verified } = resolveVerdictAuthor(
        { auth: { kind: 'device', device: 'agent:qa', deviceId: 1 } } as RouteContext,
        'cybersec',
      )
      expect(author).toBe('qa')
      expect(verified).toBe(true)
    })

    it('no device-key auth: falls back to the body claim, UNVERIFIED', () => {
      const { author, verified } = resolveVerdictAuthor({ auth: { kind: 'token' } } as RouteContext, 'qa')
      expect(author).toBe('qa')
      expect(verified).toBe(false)
    })

    it('a non-agent device key (Bridge/phone): falls back to the body claim, UNVERIFIED', () => {
      const { author, verified } = resolveVerdictAuthor(
        { auth: { kind: 'device', device: "Peti's iPhone", deviceId: 2 } } as RouteContext,
        'qa',
      )
      expect(author).toBe('qa')
      expect(verified).toBe(false)
    })

    it('no auth and no claim: author is null', () => {
      const { author, verified } = resolveVerdictAuthor({ auth: undefined } as RouteContext, undefined)
      expect(author).toBeNull()
      expect(verified).toBe(false)
    })
  })

  describe('isSelfProposedVerdict', () => {
    it('same agent (case-insensitive): true', () => {
      expect(isSelfProposedVerdict('cybersec2', 'CYBERSEC2')).toBe(true)
    })
    it('a sibling (different agent, same role family): false', () => {
      expect(isSelfProposedVerdict('cybersec2', 'cybersec')).toBe(false)
    })
    it('no proposer claim: false (nothing to exclude)', () => {
      expect(isSelfProposedVerdict('qa', undefined)).toBe(false)
    })
  })

  describe('POST /api/kanban/:id/verdicts', () => {
    // B1' (RedHat NO-GO, 2bfa4c67 comment 16824, HIGH): the measured bypass was exactly this
    // shape -- the shared dashboard token, author:"qa" in the body, used to get a 201 with
    // author_verified=0, and the completeness guard let a close through on it. A verdict record is
    // now authenticated-only; there is no unverified write path left to record.
    it('rejects the common dashboard token with a body-claimed author, no device key: 403, nothing written', async () => {
      const { ctx, out } = fakeCtx('/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'PASS', sha: 'abc123', author: 'qa' })
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(403)
      const list = fakeCtx('/api/kanban/c1/verdicts', 'GET')
      await tryHandleKanbanVerdicts(list.ctx)
      expect(list.out.body).toEqual([])
    })

    it('rejects a missing author with no device key AND no body claim: 403, same as any other unverified attempt', async () => {
      const { ctx, out } = fakeCtx('/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'PASS' })
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(403)
    })

    it('records a verdict with a VERIFIED author when an agent:<id> device key is presented', async () => {
      createDeviceKey('agent:cybersec2')
      const { ctx, out } = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'CYBERSEC', verdict: 'NO-GO' },
        { kind: 'device', device: 'agent:cybersec2', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(201)
      expect(out.body).toMatchObject({ gate: 'CYBERSEC', verdict: 'NO-GO', author: 'cybersec2', author_verified: 1 })
    })

    // B2' (RedHat NO-GO, 2bfa4c67 comment 16824, MEDIUM): the proposer is now recorded
    // automatically by the SAME authenticated write that states the NO-GO/FAIL -- there is no
    // separate "propose" step to call first any more.
    it('rejects a self-proposed verdict with 403, no second row created -- the proposer is the agent\'s own prior NO-GO, recorded automatically', async () => {
      createDeviceKey('agent:qa')
      const noGo = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'NO-GO' },
        { kind: 'device', device: 'agent:qa', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(noGo.ctx)).toBe(true)
      expect(noGo.out.status).toBe(201)

      const { ctx, out } = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'PASS' },
        { kind: 'device', device: 'agent:qa', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(403)
      const list = fakeCtx('/api/kanban/c1/verdicts', 'GET')
      await tryHandleKanbanVerdicts(list.ctx)
      expect(list.out.body).toHaveLength(1) // only the NO-GO -- the self-proposed PASS never wrote
    })

    it('a request-body proposer claim is IGNORED -- self-proposal is accepted when no authenticated NO-GO/FAIL ever happened', async () => {
      createDeviceKey('agent:qa')
      const { ctx, out } = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'PASS', proposer: 'qa' },
        { kind: 'device', device: 'agent:qa', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(201)
    })

    it('a sibling-proposed verdict is accepted (different agent, same role family)', async () => {
      createDeviceKey('agent:cybersec')
      createDeviceKey('agent:cybersec2')
      const noGo = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'CYBERSEC', verdict: 'NO-GO' },
        { kind: 'device', device: 'agent:cybersec', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(noGo.ctx)).toBe(true)
      expect(noGo.out.status).toBe(201)

      const { ctx, out } = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'CYBERSEC', verdict: 'GO' },
        { kind: 'device', device: 'agent:cybersec2', deviceId: 2 },
      )
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(201)
    })

    it('rejects an author authenticated but NOT in the gate role (RedHat T5: fullstack writing a QA verdict)', async () => {
      createDeviceKey('agent:fullstack')
      const { ctx, out } = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'GO' },
        { kind: 'device', device: 'agent:fullstack', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(403)
      const list = fakeCtx('/api/kanban/c1/verdicts', 'GET')
      await tryHandleKanbanVerdicts(list.ctx)
      expect(list.out.body).toEqual([])
    })

    it('rejects a gate value not designated on the card\'s own "Gate:" line', async () => {
      createKanbanCard({ id: 'c2', title: 'y', status: 'planned', description: 'Gate: QA' })
      createDeviceKey('agent:cybered')
      const { ctx, out } = fakeCtx(
        '/api/kanban/c2/verdicts', 'POST', { gate: 'CYBERED', verdict: 'GO' },
        { kind: 'device', device: 'agent:cybered', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(400)
    })

    it('a designated gate is accepted; a card with no Gate: line at all is permissive (matches the completeness guard default)', async () => {
      createKanbanCard({ id: 'c2', title: 'y', status: 'planned', description: 'Gate: QA + Cybered' })
      createDeviceKey('agent:cybered')
      const auth = { kind: 'device', device: 'agent:cybered', deviceId: 1 } as const
      const ok = fakeCtx('/api/kanban/c2/verdicts', 'POST', { gate: 'CYBERED', verdict: 'GO' }, auth)
      expect(await tryHandleKanbanVerdicts(ok.ctx)).toBe(true)
      expect(ok.out.status).toBe(201)
      // c1 (from beforeEach) has no description at all -- no verifiable claim, so nothing is rejected.
      const noLine = fakeCtx('/api/kanban/c1/verdicts', 'POST', { gate: 'CYBERED', verdict: 'GO' }, auth)
      expect(await tryHandleKanbanVerdicts(noLine.ctx)).toBe(true)
      expect(noLine.out.status).toBe(201)
    })

    it('rejects an invalid gate value with 400', async () => {
      const { ctx, out } = fakeCtx('/api/kanban/c1/verdicts', 'POST', { gate: 'NOPE', verdict: 'PASS', author: 'qa' })
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(400)
    })

    it('rejects an invalid verdict value with 400', async () => {
      const { ctx, out } = fakeCtx('/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'MAYBE', author: 'qa' })
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(400)
    })

    it('404s for a nonexistent card', async () => {
      const { ctx, out } = fakeCtx('/api/kanban/nope/verdicts', 'POST', { gate: 'QA', verdict: 'PASS', author: 'qa' })
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })
  })

  describe('GET /api/kanban/:id/verdicts', () => {
    it('returns the full history, oldest first', async () => {
      createDeviceKey('agent:qa')
      createDeviceKey('agent:cybersec')
      await tryHandleKanbanVerdicts(
        fakeCtx('/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'PASS' }, { kind: 'device', device: 'agent:qa', deviceId: 1 }).ctx,
      )
      await tryHandleKanbanVerdicts(
        fakeCtx('/api/kanban/c1/verdicts', 'POST', { gate: 'CYBERSEC', verdict: 'GO' }, { kind: 'device', device: 'agent:cybersec', deviceId: 2 }).ctx,
      )
      const { ctx, out } = fakeCtx('/api/kanban/c1/verdicts', 'GET')
      await tryHandleKanbanVerdicts(ctx)
      expect(out.body).toHaveLength(2)
      expect(out.body[0].gate).toBe('QA')
      expect(out.body[1].gate).toBe('CYBERSEC')
    })
  })

  describe('POST /api/kanban/:id/gate-assignment (actor allowlist)', () => {
    it('mikrob may set the assignment', async () => {
      const { ctx, out } = fakeCtx('/api/kanban/c1/gate-assignment', 'POST', { gates: ['QA', 'CYBERSEC'], actor: 'mikrob' })
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(201)
      expect(out.body).toMatchObject({ card_id: 'c1', gates: JSON.stringify(['QA', 'CYBERSEC']), actor: 'mikrob' })
    })

    it('a non-allowlisted actor (even a real gate agent) is refused with 403, nothing written', async () => {
      const { ctx, out } = fakeCtx('/api/kanban/c1/gate-assignment', 'POST', { gates: ['QA'], actor: 'backend' })
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(403)
      const get = fakeCtx('/api/kanban/c1/gate-assignment', 'GET')
      await tryHandleKanbanVerdicts(get.ctx)
      expect(get.out.body.current).toBeNull()
    })

    it('a missing actor is refused with 403', async () => {
      const { ctx, out } = fakeCtx('/api/kanban/c1/gate-assignment', 'POST', { gates: ['QA'] })
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(403)
    })

    it('an empty or invalid gates array is refused with 400', async () => {
      const empty = fakeCtx('/api/kanban/c1/gate-assignment', 'POST', { gates: [], actor: 'mikrob' })
      expect(await tryHandleKanbanVerdicts(empty.ctx)).toBe(true)
      expect(empty.out.status).toBe(400)
      const bad = fakeCtx('/api/kanban/c1/gate-assignment', 'POST', { gates: ['NOPE'], actor: 'mikrob' })
      expect(await tryHandleKanbanVerdicts(bad.ctx)).toBe(true)
      expect(bad.out.status).toBe(400)
    })

    it('append-only: a second assignment adds a row, GET exposes both as history AND the latest as current', async () => {
      await tryHandleKanbanVerdicts(fakeCtx('/api/kanban/c1/gate-assignment', 'POST', { gates: ['QA'], actor: 'mikrob' }).ctx)
      await tryHandleKanbanVerdicts(fakeCtx('/api/kanban/c1/gate-assignment', 'POST', { gates: ['QA', 'CYBERED'], actor: 'mikrob' }).ctx)
      const { ctx, out } = fakeCtx('/api/kanban/c1/gate-assignment', 'GET')
      await tryHandleKanbanVerdicts(ctx)
      expect(out.body.history).toHaveLength(2)
      expect(out.body.current.gates).toBe(JSON.stringify(['QA', 'CYBERED']))
    })
  })

  // B2' (RedHat NO-GO, 2bfa4c67 comment 16824, MEDIUM): the manual write was ALWAYS exactly as
  // forgeable as the body `proposer` field it replaced -- measured (P5/P6): any authenticated
  // agent:<id> key could write a proposal for ANY card, including one it had no NO-GO/FAIL on, and
  // the latest write won regardless of who wrote it. The proposer is now recorded automatically by
  // the verdicts route itself (see the POST /verdicts tests above); there is no independently
  // callable write path left to test here.
  describe('POST/GET /api/kanban/:id/proposals (write retired, card 2bfa4c67 comment 16824 B2\')', () => {
    it('POST is refused with 403 regardless of auth -- no manual write path exists any more', async () => {
      createDeviceKey('agent:backend')
      const authed = fakeCtx('/api/kanban/c1/proposals', 'POST', undefined, { kind: 'device', device: 'agent:backend', deviceId: 1 })
      expect(await tryHandleKanbanVerdicts(authed.ctx)).toBe(true)
      expect(authed.out.status).toBe(403)

      const token = fakeCtx('/api/kanban/c1/proposals', 'POST', undefined, { kind: 'token' })
      expect(await tryHandleKanbanVerdicts(token.ctx)).toBe(true)
      expect(token.out.status).toBe(403)

      const get = fakeCtx('/api/kanban/c1/proposals', 'GET')
      await tryHandleKanbanVerdicts(get.ctx)
      expect(get.out.body).toBeNull()
    })

    it('GET reflects the proposal the verdicts route auto-recorded for a NO-GO/FAIL', async () => {
      createDeviceKey('agent:backend')
      await tryHandleKanbanVerdicts(
        fakeCtx('/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'FAIL' }, { kind: 'device', device: 'agent:backend', deviceId: 1 }).ctx,
      )
      // 'backend' is not a QA/CYBERSEC/CYBERED role agent, so the verdict write itself is refused
      // (403, role-allowlist) -- use a real gate agent instead to exercise the auto-record path.
      createDeviceKey('agent:qa')
      await tryHandleKanbanVerdicts(
        fakeCtx('/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'FAIL' }, { kind: 'device', device: 'agent:qa', deviceId: 2 }).ctx,
      )
      const get = fakeCtx('/api/kanban/c1/proposals', 'GET')
      await tryHandleKanbanVerdicts(get.ctx)
      expect(get.out.body).toMatchObject({ card_id: 'c1', proposer: 'qa' })
    })
  })

  // Card 2bfa4c67 round 2 (WhiteHat2 NO-GO on 3d702874, N1/W2, MikroB 16574: BLOCKING). The
  // measured bypass: a verdict record citing an arbitrary sha (or none at all) was accepted as
  // "about" the card's current round regardless. The bar is the latest builder hand-off's OWN
  // declared Gate-SHA (`latestReviewGateSha`) -- when no hand-off ever used that convention, there
  // is nothing to bind against, so the check stays permissive (same as the Gate: line default).
  describe('N1/W2 sha binding to the latest REVIEW Gate-SHA', () => {
    const REVIEW_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const WRONG_SHA = 'ffffffffffffffffffffffffffffffffffffffff'

    it('no REVIEW with Gate-SHA ever on the card: sha is NOT required (permissive default)', async () => {
      createDeviceKey('agent:qa')
      const { ctx, out } = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'PASS' },
        { kind: 'device', device: 'agent:qa', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(201)
    })

    it('a REVIEW with Gate-SHA exists: a missing sha is rejected with 400 (the measured bypass)', async () => {
      createDeviceKey('agent:qa')
      addKanbanComment('c1', 'backend', `REVIEW: kesz.\nGate-SHA: ${REVIEW_SHA}`)
      const { ctx, out } = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'PASS' },
        { kind: 'device', device: 'agent:qa', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(400)
    })

    it('a REVIEW with Gate-SHA exists: a WRONG sha is rejected with 400', async () => {
      createDeviceKey('agent:qa')
      addKanbanComment('c1', 'backend', `REVIEW: kesz.\nGate-SHA: ${REVIEW_SHA}`)
      const { ctx, out } = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'PASS', sha: WRONG_SHA },
        { kind: 'device', device: 'agent:qa', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(400)
    })

    it('a REVIEW with Gate-SHA exists: the matching sha (full or short-prefix form) is accepted', async () => {
      createDeviceKey('agent:qa')
      createDeviceKey('agent:cybersec')
      addKanbanComment('c1', 'backend', `REVIEW: kesz.\nGate-SHA: ${REVIEW_SHA}`)
      const full = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'QA', verdict: 'PASS', sha: REVIEW_SHA },
        { kind: 'device', device: 'agent:qa', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(full.ctx)).toBe(true)
      expect(full.out.status).toBe(201)
      const short = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'CYBERSEC', verdict: 'GO', sha: REVIEW_SHA.slice(0, 8) },
        { kind: 'device', device: 'agent:cybersec', deviceId: 2 },
      )
      expect(await tryHandleKanbanVerdicts(short.ctx)).toBe(true)
      expect(short.out.status).toBe(201)
    })
  })

  // Card 2bfa4c67 round 2 (WhiteHat2 NO-GO on 3d702874, N5). The measured bypass: the exclusion
  // used to be "latest proposal wins", so a LATER, unrelated proposal from a DIFFERENT agent
  // silently cleared an earlier, still-relevant exclusion. B2' (RedHat 16824) replaced the manual
  // "propose" call with an automatic one on NO-GO/FAIL -- these tests now drive that path directly.
  describe('N5 set-semantics proposer exclusion, scoped to the current round', () => {
    it('an earlier NO-GO from the gate stays blocking even after a later, different proposal', async () => {
      createDeviceKey('agent:cybersec')
      createDeviceKey('agent:cybersec2')
      await tryHandleKanbanVerdicts(
        fakeCtx('/api/kanban/c1/verdicts', 'POST', { gate: 'CYBERSEC', verdict: 'NO-GO' }, { kind: 'device', device: 'agent:cybersec', deviceId: 1 }).ctx,
      )
      // A later, different sibling's own NO-GO must not clear cybersec's earlier exclusion.
      await tryHandleKanbanVerdicts(
        fakeCtx('/api/kanban/c1/verdicts', 'POST', { gate: 'CYBERSEC', verdict: 'NO-GO' }, { kind: 'device', device: 'agent:cybersec2', deviceId: 2 }).ctx,
      )
      const { ctx, out } = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST', { gate: 'CYBERSEC', verdict: 'GO' },
        { kind: 'device', device: 'agent:cybersec', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(403)
    })

    it('a proposal scoped to an OLD round (different Gate-SHA) does not block the gate in the CURRENT round', async () => {
      createDeviceKey('agent:cybersec')
      addKanbanComment('c1', 'backend', 'REVIEW: round 1.\nGate-SHA: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      await tryHandleKanbanVerdicts(
        fakeCtx(
          '/api/kanban/c1/verdicts', 'POST',
          { gate: 'CYBERSEC', verdict: 'NO-GO', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
          { kind: 'device', device: 'agent:cybersec', deviceId: 1 },
        ).ctx,
      )
      addKanbanComment('c1', 'backend', 'REVIEW: round 2.\nGate-SHA: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
      const { ctx, out } = fakeCtx(
        '/api/kanban/c1/verdicts', 'POST',
        { gate: 'CYBERSEC', verdict: 'GO', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        { kind: 'device', device: 'agent:cybersec', deviceId: 1 },
      )
      expect(await tryHandleKanbanVerdicts(ctx)).toBe(true)
      expect(out.status).toBe(201)
    })
  })

  describe('migration rollback (kanban_verdicts, kanban_gate_assignments)', () => {
    it('DROP TABLE leaves a neighbouring table intact, and re-running the CREATE recreates it, usable', () => {
      const db = getDb()
      db.exec(`INSERT INTO kanban_verdicts (card_id, gate, verdict, author, author_verified, created_at) VALUES ('c1','QA','PASS','qa',0,0)`)
      db.exec('DROP TABLE kanban_verdicts')
      db.exec('DROP TABLE kanban_gate_assignments')
      // The dropped tables are really gone.
      expect(() => db.prepare('SELECT * FROM kanban_verdicts').all()).toThrow()
      // A neighbouring table survives the rollback untouched.
      expect(db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get('c1')).toBeTruthy()
      // Re-running the exact CREATE TABLE IF NOT EXISTS from db.ts recreates it, empty and usable --
      // the same statement the initialiser runs on every startup, so this is not a different path.
      db.exec(`
        CREATE TABLE IF NOT EXISTS kanban_verdicts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, gate TEXT NOT NULL,
          verdict TEXT NOT NULL, sha TEXT, round INTEGER NOT NULL DEFAULT 1, findings_ref TEXT,
          proposer TEXT, author TEXT NOT NULL, author_verified INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )
      `)
      expect(db.prepare('SELECT * FROM kanban_verdicts').all()).toEqual([])
      db.exec(`INSERT INTO kanban_verdicts (card_id, gate, verdict, author, author_verified, created_at) VALUES ('c1','QA','PASS','qa',0,0)`)
      expect(db.prepare('SELECT * FROM kanban_verdicts').all()).toHaveLength(1)
    })

    it('kanban_fix_proposals: DROP TABLE + CREATE TABLE IF NOT EXISTS is the same additive/rollback shape', () => {
      const db = getDb()
      db.exec(`INSERT INTO kanban_fix_proposals (card_id, proposer, created_at) VALUES ('c1','qa',0)`)
      db.exec('DROP TABLE kanban_fix_proposals')
      expect(() => db.prepare('SELECT * FROM kanban_fix_proposals').all()).toThrow()
      expect(db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get('c1')).toBeTruthy()
      db.exec(`
        CREATE TABLE IF NOT EXISTS kanban_fix_proposals (
          id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, proposer TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `)
      expect(db.prepare('SELECT * FROM kanban_fix_proposals').all()).toEqual([])
      db.exec(`INSERT INTO kanban_fix_proposals (card_id, proposer, created_at) VALUES ('c1','qa',0)`)
      expect(db.prepare('SELECT * FROM kanban_fix_proposals').all()).toHaveLength(1)
    })
  })
})
