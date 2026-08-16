import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PROJECT_ROOT } from '../config.js'
import {
  initDatabase,
  createAgentMessage,
  markMessageDelivered,
  markMessageDone,
  failPendingFederatedMessages,
  getAgentMessage,
} from '../db.js'
import { tryHandleFederation, _resetInboxDedupForTest } from '../web/routes/federation.js'
import {
  _setFederationStoreDirForTest,
  reloadFederationForTest,
  getFederationConfig,
} from '../web/federation/config.js'
import type { RouteContext } from '../web/routes/types.js'

// Card a5b71f29: every peer/enabled/routing-mode mutation below runs through the REAL
// tryHandleFederation, which calls ensureFederationClaudeMdSection() (federation.ts's own
// production wiring) after each write. Nothing in this file mocked that, so every run appended
// the live "MARVEEN-FEDERATION:POLICY" block to THIS repo's own root CLAUDE.md (and every
// sub-agent's CLAUDE.md, via the SAME function's catalogAgentNames() loop) -- a suite testing
// federation.json CRUD was mutating a tracked persona file as a side effect, in whatever
// worktree it happened to run in. This file already isolates the federation CONFIG store
// (_setFederationStoreDirForTest below); the onboarding side effect needs the same isolation,
// and mocking it out is correct here because federation-onboarding.test.ts (not this file) is
// what actually tests ensureFederationClaudeMdSection's rendering -- this file has never
// asserted anything about CLAUDE.md content. vi.mock (and the vi.hoisted it references) are
// hoisted above the imports above by vitest's transform, so the mock is registered before
// federation.js's own import of onboarding.js runs.
const { ensureFederationClaudeMdSectionMock } = vi.hoisted(() => ({
  ensureFederationClaudeMdSectionMock: vi.fn(() => false),
}))
vi.mock('../web/federation/onboarding.js', () => ({
  ensureFederationClaudeMdSection: () => ensureFederationClaudeMdSectionMock(),
}))

// Snapshotted at module load, before any test below can run -- the vi.mock above is already
// registered at this point, so nothing in this file has had a chance to write to the real
// CLAUDE.md yet. Card c93443dc: the canary used to assert the file never contains the literal
// "MARVEEN-FEDERATION:POLICY" marker, which broke the day that section became a legitimate,
// permanently-committed part of the real CLAUDE.md (the "Föderációs házirend" block) -- an
// absence check can't tell "always been there" from "the mock leaked and wrote it". A byte-equal
// snapshot can: it still catches the mock leaking (the marker would be newly APPENDED, changing
// the file) or any other unrelated mutation (deletion, insertion elsewhere), while accepting
// content that was already there before this suite ran, whatever it is.
const CLAUDE_MD_PATH = join(PROJECT_ROOT, 'CLAUDE.md')
const CLAUDE_MD_BEFORE_SUITE = readFileSync(CLAUDE_MD_PATH, 'utf-8')

const TMP = mkdtempSync(join(tmpdir(), 'fed-lifecycle-test-'))
const IN_TOKEN = 'a'.repeat(64)
const OUT_TOKEN = 'b'.repeat(64)

function writeConfigFile(obj: unknown): void {
  writeFileSync(join(TMP, 'federation.json'), JSON.stringify(obj))
  reloadFederationForTest()
}

function fakeCtx(method: string, path: string, body?: string): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* noop */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* noop */ },
  } as unknown as RouteContext['res']
  if (body !== undefined) {
    process.nextTick(() => {
      ;(req as unknown as EventEmitter).emit('data', Buffer.from(body))
      ;(req as unknown as EventEmitter).emit('end')
    })
  }
  return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`), fedPeer: null }, res: state }
}

async function call(method: string, path: string, body?: unknown): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(method, path, body === undefined ? undefined : JSON.stringify(body))
  expect(await tryHandleFederation(ctx)).toBe(true)
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(res.body) } catch { /* empty */ }
  return { statusCode: res.statusCode || 200, json: parsed }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  rmSync(join(TMP, 'federation.json'), { force: true })
  _setFederationStoreDirForTest(TMP)
  _resetInboxDedupForTest()
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('failPendingFederatedMessages (db helper)', () => {
  it('fails ONLY pending qualified rows; per-peer scoping is exact-prefix (no LIKE underscore wildcard)', () => {
    const pTeodor = createAgentMessage('a', 'teodor/x', 'p1')
    const pUnderscore = createAgentMessage('a', 'te_dor/x', 'p2') // '_' would be a LIKE wildcard
    const pLocal = createAgentMessage('a', 'localagent', 'p3')
    const delivered = createAgentMessage('a', 'teodor/y', 'p4')
    markMessageDelivered(delivered.id)

    const failed = failPendingFederatedMessages('te_dor', 'peer removed')
    expect(failed).toEqual([pUnderscore.id]) // teodor/x must NOT be swept
    expect(getAgentMessage(pTeodor.id)?.status).toBe('pending')
    expect(getAgentMessage(pLocal.id)?.status).toBe('pending')
    expect(getAgentMessage(delivered.id)?.status).toBe('delivered') // history untouched

    const all = failPendingFederatedMessages(undefined, 'disabled')
    expect(all).toEqual([pTeodor.id]) // only the remaining pending qualified row
    expect(getAgentMessage(pTeodor.id)?.result).toBe('disabled')
  })

  it('per-peer scoping is case-insensitive (L1): pre-normalization uppercase rows are purged too', () => {
    const upper = createAgentMessage('a', 'Teodor/x', 'legacy row')
    const other = createAgentMessage('a', 'cecil/x', 'other peer')
    const failed = failPendingFederatedMessages('teodor', 'peer removed')
    expect(failed).toEqual([upper.id])
    expect(getAgentMessage(other.id)?.status).toBe('pending')
    failPendingFederatedMessages(undefined, 'cleanup')
  })
})

describe('markMessageDelivered status guard', () => {
  it('refuses to flip a non-pending row (concurrent bulk-fail vs in-flight send)', () => {
    const msg = createAgentMessage('a', 'teodor/x', 'race')
    failPendingFederatedMessages('teodor', 'Federation removed while pending')
    expect(markMessageDelivered(msg.id)).toBe(false)
    expect(getAgentMessage(msg.id)?.status).toBe('failed')
    expect(getAgentMessage(msg.id)?.result).toBe('Federation removed while pending')

    const done = createAgentMessage('a', 'b', 'done-first')
    markMessageDone(done.id, 'ok')
    expect(markMessageDelivered(done.id)).toBe(false)
  })
})

describe('peer lifecycle endpoints', () => {
  it('POST /peers mints an inbound token, returns it once, list stays redacted', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const created = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://mini.example' })
    expect(created.statusCode).toBe(201)
    const minted = created.json.inboundToken as string
    expect(minted).toMatch(/^[0-9a-f]{64}$/)
    expect(created.json.peer).toMatchObject({ id: 'teodor', hasInboundToken: true, hasOutboundToken: false })

    const dup = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://mini.example' })
    expect(dup.statusCode).toBe(409)

    const list = await call('GET', '/api/federation/peers')
    expect(JSON.stringify(list.json)).not.toContain(minted)

    const reveal = await call('GET', '/api/federation/peers/teodor/inbound-token')
    expect(reveal.json.inboundToken).toBe(minted)
  })

  it('shareCapabilitySummaries survives every mutation path (L5): add, PATCH, rotate, sibling DELETE, enabled flip', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const created = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://mini.example', shareCapabilitySummaries: true })
    expect(created.statusCode).toBe(201)
    expect(created.json.peer).toMatchObject({ shareCapabilitySummaries: true })
    // Non-boolean is refused.
    expect((await call('POST', '/api/federation/peers', { id: 'cecil', baseUrl: 'https://c.example', shareCapabilitySummaries: 'yes' })).statusCode).toBe(400)
    await call('POST', '/api/federation/peers', { id: 'cecil', baseUrl: 'https://c.example' })

    // The grant must ride every validator round-trip:
    expect((await call('PATCH', '/api/federation/peers/teodor', { abandonWindowMinutes: 1440 })).statusCode).toBe(200)
    await call('POST', '/api/federation/peers/teodor/rotate-inbound-token')
    await call('DELETE', '/api/federation/peers/cecil')
    await call('POST', '/api/federation/enabled', { enabled: false })
    await call('POST', '/api/federation/enabled', { enabled: true })
    const list = await call('GET', '/api/federation/peers')
    const teodor = (list.json.peers as Array<{ id: string; shareCapabilitySummaries: boolean }>).find((p) => p.id === 'teodor')
    expect(teodor?.shareCapabilitySummaries).toBe(true)
    // And PATCH can revoke it.
    expect((await call('PATCH', '/api/federation/peers/teodor', { shareCapabilitySummaries: false })).statusCode).toBe(200)
    const after = await call('GET', '/api/federation/peers')
    expect((after.json.peers as Array<{ id: string; shareCapabilitySummaries: boolean }>)[0].shareCapabilitySummaries).toBe(false)
  })

  it('routingMode: endpoint sets it, GET reflects it, and it SURVIVES peer add + enabled flip + PATCH (round-trip)', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    expect((await call('GET', '/api/federation/peers')).json.routingMode).toBe('catalog-first') // default
    expect((await call('POST', '/api/federation/routing-mode', { mode: 'strong' })).statusCode).toBe(200)
    expect((await call('GET', '/api/federation/peers')).json.routingMode).toBe('strong')
    expect((await call('POST', '/api/federation/routing-mode', { mode: 'aggressive' })).statusCode).toBe(400) // unknown mode refused
    // The owner's choice must ride the mutation paths that re-validate + persist the whole config:
    expect((await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://mini.example' })).statusCode).toBe(201) // add-peer must not reset it
    expect((await call('GET', '/api/federation/peers')).json.routingMode).toBe('strong')
    await call('POST', '/api/federation/enabled', { enabled: false })
    await call('POST', '/api/federation/enabled', { enabled: true })
    await call('PATCH', '/api/federation/peers/teodor', { abandonWindowMinutes: 1440 })
    expect((await call('GET', '/api/federation/peers')).json.routingMode).toBe('strong')
  })

  it('peer ids are case-insensitive end to end (L1): uppercase add stores lowercase, uppercase URL id resolves', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const created = await call('POST', '/api/federation/peers', { id: 'Teodor', baseUrl: 'https://mini.example' })
    expect(created.statusCode).toBe(201)
    expect(created.json.peer).toMatchObject({ id: 'teodor' })
    // Duplicate across case is refused.
    expect((await call('POST', '/api/federation/peers', { id: 'TEODOR', baseUrl: 'https://mini.example' })).statusCode).toBe(409)
    // Display-cased URL segment still finds the stored lowercase peer.
    expect((await call('GET', '/api/federation/peers/Teodor/inbound-token')).statusCode).toBe(200)
    expect((await call('PATCH', '/api/federation/peers/Teodor', { abandonWindowMinutes: 1440 })).statusCode).toBe(200)
    expect((await call('DELETE', '/api/federation/peers/TEODOR')).statusCode).toBe(200)
  })

  it('PATCH edits baseUrl/outboundToken/abandonWindowMinutes with validation', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://mini.example', inboundToken: IN_TOKEN }] })
    const ok = await call('PATCH', '/api/federation/peers/teodor', { outboundToken: OUT_TOKEN, abandonWindowMinutes: 1440 })
    expect(ok.statusCode).toBe(200)
    expect(ok.json).toMatchObject({ hasOutboundToken: true, abandonWindowMinutes: 1440 })
    expect(getFederationConfig().peers[0].outboundToken).toBe(OUT_TOKEN)

    expect((await call('PATCH', '/api/federation/peers/teodor', { outboundToken: 'short' })).statusCode).toBe(400)
    expect((await call('PATCH', '/api/federation/peers/teodor', { abandonWindowMinutes: 1 })).statusCode).toBe(400)
    expect((await call('PATCH', '/api/federation/peers/nobody', { outboundToken: OUT_TOKEN })).statusCode).toBe(404)
    // %2F-smuggled slash in the id param is rejected before any use:
    expect((await call('PATCH', '/api/federation/peers/a%2Fb', {})).statusCode).toBe(400)
  })

  it('rotate mints a fresh token and invalidates the old one in config', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://mini.example', inboundToken: IN_TOKEN }] })
    const rotated = await call('POST', '/api/federation/peers/teodor/rotate-inbound-token')
    expect(rotated.statusCode).toBe(200)
    const fresh = rotated.json.inboundToken as string
    expect(fresh).not.toBe(IN_TOKEN)
    expect(getFederationConfig().peers[0].inboundToken).toBe(fresh)
  })

  it('DELETE removes the peer and fails ONLY its pending messages', async () => {
    writeConfigFile({
      enabled: true, systemId: 'localsys',
      peers: [
        { id: 'teodor', baseUrl: 'https://mini.example', inboundToken: IN_TOKEN },
        { id: 'cecil', baseUrl: 'https://c.example', inboundToken: 'c'.repeat(64) },
      ],
    })
    const mine = createAgentMessage('a', 'teodor/x', 'to-removed-peer')
    const other = createAgentMessage('a', 'cecil/x', 'to-kept-peer')
    const del = await call('DELETE', '/api/federation/peers/teodor')
    expect(del.statusCode).toBe(200)
    expect(getFederationConfig().peers.map((p) => p.id)).toEqual(['cecil'])
    expect(getAgentMessage(mine.id)?.status).toBe('failed')
    expect(getAgentMessage(other.id)?.status).toBe('pending')
  })
})

describe('master switch + full removal', () => {
  it('POST /enabled false is LOSSLESS for config but deterministic for the queue', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://mini.example', inboundToken: IN_TOKEN, outboundToken: OUT_TOKEN }] })
    const q = createAgentMessage('a', 'teodor/x', 'queued')
    const off = await call('POST', '/api/federation/enabled', { enabled: false })
    expect(off.json.enabled).toBe(false)
    expect((off.json.peers as unknown[]).length).toBe(1) // peers survive
    expect(getAgentMessage(q.id)?.status).toBe('failed') // queue is deterministic

    const on = await call('POST', '/api/federation/enabled', { enabled: true })
    expect(on.json.enabled).toBe(true)
    expect((on.json.peers as unknown[]).length).toBe(1) // one-click re-enable
  })

  it('peers are editable while DISABLED (pairing precedes opening the perimeter)', async () => {
    writeConfigFile({ enabled: false, systemId: 'localsys', peers: [] })
    const created = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://mini.example' })
    expect(created.statusCode).toBe(201)
    const cfg = getFederationConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.peers).toHaveLength(1)
  })

  it('PUT with a valid enabled:false document persists it as given', async () => {
    const put = await call('PUT', '/api/federation/peers', {
      enabled: false, systemId: 'localsys',
      peers: [{ id: 'teodor', baseUrl: 'https://mini.example', inboundToken: IN_TOKEN }],
    })
    expect(put.json.enabled).toBe(false)
    expect((put.json.peers as unknown[]).length).toBe(1)
  })

  it('refuses peer mutations on an invalid-but-present file (no silent peer-destroy)', async () => {
    // A hand-edited file with one bad peer fail-closes the VIEW to peers:[];
    // an add/patch/delete/rotate must 409, not overwrite the recoverable file.
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://mini.example', inboundToken: 'short' }] })
    expect(getFederationConfig().peers).toHaveLength(0) // fail-closed view
    expect((await call('POST', '/api/federation/peers', { id: 'cecil', baseUrl: 'https://c.example' })).statusCode).toBe(409)
    expect((await call('PATCH', '/api/federation/peers/teodor', { baseUrl: 'https://x.example' })).statusCode).toBe(409)
    expect((await call('DELETE', '/api/federation/peers/teodor')).statusCode).toBe(409)
    expect((await call('POST', '/api/federation/peers/teodor/rotate-inbound-token')).statusCode).toBe(409)
    // the file is untouched:
    const raw = JSON.parse(readFileSync(join(TMP, 'federation.json'), 'utf-8'))
    expect(raw.peers).toHaveLength(1)
  })

  it('a {"__error":true} body is treated as data, not a parse failure (no hung request)', async () => {
    writeConfigFile({ enabled: false, systemId: 'localsys', peers: [] })
    // Must produce a real HTTP response (not hang); it is an invalid peer body -> 400.
    const r = await call('POST', '/api/federation/peers', { __error: true })
    expect(r.statusCode).toBe(400)
  })

  it('POST /peers accepts an abandonWindowMinutes on add', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    const created = await call('POST', '/api/federation/peers', { id: 'teodor', baseUrl: 'https://mini.example', abandonWindowMinutes: 1440 })
    expect(created.statusCode).toBe(201)
    expect(getFederationConfig().peers[0].abandonWindowMinutes).toBe(1440)
    expect((await call('POST', '/api/federation/peers', { id: 'cecil', baseUrl: 'https://c.example', abandonWindowMinutes: 1 })).statusCode).toBe(400)
  })

  it('enabling an invalid-but-parseable file 409s instead of reporting a false success', async () => {
    writeConfigFile({ enabled: false, systemId: 'localsys', peers: 'oops' })
    const r = await call('POST', '/api/federation/enabled', { enabled: true })
    expect(r.statusCode).toBe(409)
    expect(getFederationConfig().enabled).toBe(false)
  })

  it('POST /remove purges files, queue and answers idempotently', async () => {
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://mini.example', inboundToken: IN_TOKEN }] })
    writeFileSync(join(TMP, '.federation-token'), 'legacy'.repeat(11))
    const q = createAgentMessage('a', 'teodor/x', 'queued-at-removal')
    const rm = await call('POST', '/api/federation/remove')
    expect(rm.json.ok).toBe(true)
    expect(existsSync(join(TMP, 'federation.json'))).toBe(false)
    expect(existsSync(join(TMP, '.federation-token'))).toBe(false)
    expect(getFederationConfig().enabled).toBe(false)
    expect(getAgentMessage(q.id)?.status).toBe('failed')
    const again = await call('POST', '/api/federation/remove')
    expect(again.json.ok).toBe(true)
  })
})

describe('this suite does not write the repo it runs in (card a5b71f29)', () => {
  it('a mutation reaches the mocked onboarding call (not a vacuous mock)', async () => {
    ensureFederationClaudeMdSectionMock.mockClear()
    writeConfigFile({ enabled: true, systemId: 'localsys', peers: [] })
    await call('POST', '/api/federation/peers', { id: 'vacuous-check', baseUrl: 'https://x.example' })
    expect(ensureFederationClaudeMdSectionMock).toHaveBeenCalled()
  })

  it('the real project CLAUDE.md is untouched after every mutation test above has already run', () => {
    expect(readFileSync(CLAUDE_MD_PATH, 'utf-8')).toBe(CLAUDE_MD_BEFORE_SUITE)
  })

  it('...and the snapshot itself is not vacuous -- it does contain the legitimate policy marker', () => {
    // Negative control for the assertion above: if the real CLAUDE.md stopped carrying the
    // committed federation-policy section, the snapshot would go empty of it too and the previous
    // test would pass FOR THE WRONG REASON (comparing two files that both lack the marker, rather
    // than proving nothing new was appended). This pins the fixture's own precondition.
    expect(CLAUDE_MD_BEFORE_SUITE).toContain('MARVEEN-FEDERATION:POLICY')
  })
})
