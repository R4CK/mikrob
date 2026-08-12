import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { initDatabase, createAgentMessage, getAgentMessage, getPendingMessages } from '../db.js'
import { deliverFederatedBatch } from '../web/message-router.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { _setFederationStoreDirForTest, reloadFederationForTest } from '../web/federation/config.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'
import type { RouteContext } from '../web/routes/types.js'

// Fixture agent directories required by the from/to-auth checks in /api/messages
// (card 523a1426 added the to-side check). 'localboss' is the fictional test
// sender, 'localmate' the fictional local recipient, both used throughout this suite.
const FIXTURE_AGENTS = ['localboss', 'localmate']

const TMP = mkdtempSync(join(tmpdir(), 'fed-feedback-test-'))
const IN_TOKEN = 'b'.repeat(64)
const OUT_TOKEN = 'c'.repeat(64)

function writeEnabledConfig(): void {
  writeFileSync(join(TMP, 'federation.json'), JSON.stringify({
    enabled: true, systemId: 'localsys',
    peers: [{ id: 'teodor', baseUrl: 'https://mini.example', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN }],
  }))
  reloadFederationForTest()
}

async function postMessage(body: unknown): Promise<{ statusCode: number; json: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() {},
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const handled = await tryHandleMessages({
    req, res, path: '/api/messages', method: 'POST',
    url: new URL('http://localhost/api/messages'), fedPeer: null,
  })
  expect(handled).toBe(true)
  return { statusCode: state.statusCode || 200, json: state.body ? JSON.parse(state.body) : null }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  // Create minimal fixture agent directories so isKnownAgent() recognises the
  // test senders. These are torn down in afterAll.
  for (const name of FIXTURE_AGENTS) {
    mkdirSync(join(AGENTS_BASE_DIR, name), { recursive: true })
  }
})

beforeEach(() => {
  rmSync(join(TMP, 'federation.json'), { force: true })
  _setFederationStoreDirForTest(TMP)
  writeEnabledConfig()
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
  for (const name of FIXTURE_AGENTS) {
    rmSync(join(AGENTS_BASE_DIR, name), { recursive: true, force: true })
  }
})

describe('POST /api/messages colon-form to guard (L5)', () => {
  it('rejects a "federation:x:y" source-form recipient with 400 instead of a silent 1h phantom', async () => {
    const r = await postMessage({ from: 'localboss', to: 'federation:teodor:teodor', content: 'hi' })
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toMatch(/slash/i)
  })

  it('still accepts a normal local recipient and a valid qualified one', async () => {
    expect((await postMessage({ from: 'localboss', to: 'localmate', content: 'hi' })).statusCode).toBe(200)
    expect((await postMessage({ from: 'localboss', to: 'teodor/kutato', content: 'hi' })).statusCode).toBe(200)
  })
})

// Card 523a1426 (Cybersec finding while gating 801774f2): selectFairBatch buckets pending
// messages BY to_agent with no notion of "real" vs "forged" recipient -- a flood of distinct,
// made-up local to_agent values (sent with a valid, known from) each open their own bucket and
// each claim one of the ~25 per-tick round-robin slots, starving real agents' buckets out of a
// tick. Rejecting an unknown local recipient AT CREATION means a forged bucket can never exist.
describe('POST /api/messages to-authentication (card 523a1426)', () => {
  it('rejects an unknown LOCAL recipient with 400 -- a forged to_agent can never open a fair-batch bucket', async () => {
    const r = await postMessage({ from: 'localboss', to: 'totally-made-up-agent-42', content: 'hi' })
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toMatch(/unknown agent/i)
  })

  it('accepts the special MAIN_AGENT_ID recipient (not a fixture directory, but always known)', async () => {
    expect((await postMessage({ from: 'localboss', to: 'marveen', content: 'hi' })).statusCode).toBe(200)
  })

  it('a flood of distinct forged recipients is rejected one by one -- none is ever stored under its own bucket name', async () => {
    for (let i = 0; i < 30; i++) {
      const to = `attacker-bucket-${i}`
      const r = await postMessage({ from: 'localboss', to, content: 'flood' })
      expect(r.statusCode).toBe(400)
      // Proves the row was never created at all, not merely unreachable by some other query --
      // a forged to_agent that WAS persisted would still open its own selectFairBatch bucket.
      expect(getPendingMessages(to)).toHaveLength(0)
    }
  })

  // Cybered NO-GO on the first version of this check (commit 6323ec6): validating
  // sanitizeAgentIdent(storedTo) while STORING the raw storedTo left the actual bucket-
  // splitting vulnerability open -- "localmate.", ".localmate", "localmate!" all sanitize
  // to the real, known "localmate" (validation passes), but each RAW value would still
  // open its OWN distinct selectFairBatch bucket. Live end-to-end proof (through the real
  // tryHandleMessages route handler, not an isolated function call), per Cybered's own
  // reproduction in kanban comment 10941.
  it('SECURITY REGRESSION (Cybered 523a1426): garbage-suffixed/prefixed variants of a real name canonicalize to the SAME bucket, not their own', async () => {
    const variants = ['localmate', 'localmate.', '.localmate', 'localmate!', 'localmate#', 'localmate$']
    for (const to of variants) {
      const r = await postMessage({ from: 'localboss', to, content: 'probe' })
      expect(r.statusCode).toBe(200)
      // The STORED to_agent must be the canonical name -- not the raw garbage-suffixed
      // input -- so selectFairBatch buckets every variant together with the real agent.
      expect(r.json.to_agent).toBe('localmate')
    }
    // All 6 variants landed in ONE bucket, not six: selectFairBatch would give 'localmate'
    // exactly one round-robin slot per tick, same as if only the canonical form was ever sent.
    expect(getPendingMessages('localmate')).toHaveLength(variants.length)
  })

  it('CONTROL: a REAL extra letter (not a stripped symbol) is a genuinely different, still-rejected name', async () => {
    // Not a false-positive fix: sanitizeAgentIdent only strips [^a-zA-Z0-9_-] -- it never
    // removes an actual alphanumeric character, so appending a real letter changes the
    // identity for good (no fixture directory for 'localmatex'), unlike appending a
    // symbol which the sanitizer strips back down to the real name. Confirms the fix
    // canonicalizes garbage away without loosening validation for a genuinely new name.
    const r = await postMessage({ from: 'localboss', to: 'localmatex', content: 'probe' })
    expect(r.statusCode).toBe(400)
  })
})

describe('delegation failure feedback (L5)', () => {
  it('bounces an ABANDONED federated task back to the sender as a local system notice', async () => {
    // Age it well past the 60-min default abandon window; the abandon branch
    // fires with NO network attempt.
    const old = createAgentMessage('localboss', 'teodor/kutato', 'please research X')
    const now = old.created_at * 1000 + 2 * 60 * 60 * 1000 // +2h
    await deliverFederatedBatch([getAgentMessage(old.id)!], now)

    expect(getAgentMessage(old.id)?.status).toBe('failed')
    // A single local 'system' notice now waits for the sender.
    const inbox = getPendingMessages('localboss')
    expect(inbox).toHaveLength(1)
    expect(inbox[0].from_agent).toBe('system')
    expect(inbox[0].to_agent).toBe('localboss') // local -- never crosses the bridge
    expect(inbox[0].content).toContain(`#${old.id}`)
    expect(inbox[0].content).toContain('teodor/kutato')
  })

  it('does NOT bounce a second notice when the row was already closed concurrently (status-guarded)', async () => {
    // Distinct sender: the in-memory DB is shared across tests (no per-test reset).
    const old = createAgentMessage('boss2', 'teodor/kutato', 'research Y')
    const now = old.created_at * 1000 + 2 * 60 * 60 * 1000
    // First pass: abandons + one notice.
    await deliverFederatedBatch([getAgentMessage(old.id)!], now)
    expect(getPendingMessages('boss2')).toHaveLength(1)
    // Second pass over the SAME (now failed) row: markPendingFederatedFailed
    // must not re-fire, so no duplicate notice piles up.
    await deliverFederatedBatch([getAgentMessage(old.id)!], now + 1000)
    expect(getPendingMessages('boss2')).toHaveLength(1) // still exactly one notice
  })
})
