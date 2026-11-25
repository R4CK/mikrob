// Card 954a6a93: GET /api/llm/chain. Contract ACCEPTed between Fron Ted (comment 37917) and
// backend2 (comment 37945) before this endpoint existed -- these tests pin the REAL handler
// against a real in-memory kanban DB plus a real (mkdtemp'd) store dir for the switch file and
// the card-build-route.log.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { rmSync, writeFileSync, existsSync, unlinkSync, appendFileSync } from 'node:fs'
import { initDatabase, appendLlmLedgerRow, markLlmLedgerDraftAccepted, getDb } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

const { storeDir } = vi.hoisted((): { storeDir: string } => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return { storeDir: mkdtempSync(join(tmpdir(), 'llm-chain-test-')) }
})

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, STORE_DIR: storeDir }
})

const { tryHandleLlmChain } = await import('../web/routes/llm-chain.js')
const { FREELLM_ENABLED_PATH } = await import('../web/routes/freellm-status.js')
const { CARD_BUILD_ROUTE_LOG_FILE } = await import('../web/routes/local-llm.js')

function mkRequest(path: string) {
  const req = new EventEmitter() as unknown as RouteContext['req']
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420${path}`)
  process.nextTick(() => (req as unknown as EventEmitter).emit('end'))
  const ctx = { req, res, path: url.pathname, method: 'GET', url } as unknown as RouteContext
  return { ctx, out }
}

function routeLine(date: string, cardId: string, verdict: 'LOCAL' | 'ONLINE', reason: string): string {
  return `${date}\t${cardId}\t${verdict}\t${reason}\tcalls=1\tchars=100\tdispatcher=-\tdecompose=-\n`
}

beforeEach(() => {
  initDatabase(':memory:')
  if (existsSync(FREELLM_ENABLED_PATH)) unlinkSync(FREELLM_ENABLED_PATH)
  if (existsSync(CARD_BUILD_ROUTE_LOG_FILE)) unlinkSync(CARD_BUILD_ROUTE_LOG_FILE)
})
afterAll(() => {
  rmSync(storeDir, { recursive: true, force: true })
})

describe('GET /api/llm/chain', () => {
  it('matches the handled path only', async () => {
    expect(await tryHandleLlmChain(mkRequest('/api/llm/other').ctx)).toBe(false)
  })

  it('rejects an invalid window with 400', async () => {
    const { ctx, out } = mkRequest('/api/llm/chain?window=30d')
    expect(await tryHandleLlmChain(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('rejects a non-boolean includeTest with 400', async () => {
    const { ctx, out } = mkRequest('/api/llm/chain?includeTest=1')
    expect(await tryHandleLlmChain(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('defaults to window=24h, testTrafficIncluded=false, empty data -> honest zeros, not fabricated', async () => {
    const { ctx, out } = mkRequest('/api/llm/chain')
    expect(await tryHandleLlmChain(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.window).toBe('24h')
    expect(out.body.testTrafficIncluded).toBe(false)
    const online = out.body.stages.find((s: any) => s.stage === 'online')
    expect(online).toEqual({ stage: 'online', calls: 0, ok: 0, failReasons: [], avgLatencyMs: null, source: 'llm_ledger' })
    expect(out.body.draftReview).toEqual({ available: false, verdicts: null, source: 'llm_ledger' })
    expect(out.body.routing).toEqual({ local: 0, online: 0, reasons: [], source: 'card_build_route_log' })
  })

  it('every section names its own source (comment 37945 point 2)', async () => {
    const { ctx, out } = mkRequest('/api/llm/chain')
    await tryHandleLlmChain(ctx)
    for (const s of out.body.stages) expect(s.source).toBe('llm_ledger')
    expect(out.body.routing.source).toBe('card_build_route_log')
    expect(out.body.draftReview.source).toBe('llm_ledger')
    expect(out.body.switches.source).toBe('config')
    expect(out.body.cost.source).toBe('token_usage')
  })

  it('stages: local/freellm calls+ok+failReasons+avgLatencyMs from llm_ledger, numbers match a hand-run count', async () => {
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'backend', taskType: 'offload', provider: 'local', ok: true, latencyMs: 100, nowS: now })
    appendLlmLedgerRow({ agentId: 'backend', taskType: 'offload', provider: 'local', ok: true, latencyMs: 300, nowS: now })
    appendLlmLedgerRow({ agentId: 'backend', taskType: 'offload', provider: 'local', ok: false, failReason: 'timeout', latencyMs: 200, nowS: now })
    appendLlmLedgerRow({ agentId: 'backend2', taskType: 'offload', provider: 'freellm', ok: true, latencyMs: 50, nowS: now })
    appendLlmLedgerRow({ agentId: 'backend2', taskType: 'offload', provider: 'freellm', ok: false, failReason: 'quota_429', nowS: now })
    // a gemini row must not leak into local/freellm stages or affect their totals
    appendLlmLedgerRow({ agentId: 'ghost', taskType: 'offload', provider: 'gemini', ok: true, nowS: now })

    const { ctx, out } = mkRequest('/api/llm/chain')
    await tryHandleLlmChain(ctx)
    const local = out.body.stages.find((s: any) => s.stage === 'local')
    const freellm = out.body.stages.find((s: any) => s.stage === 'freellm')
    expect(local.calls).toBe(3)
    expect(local.ok).toBe(2)
    expect(local.failReasons).toEqual([{ reason: 'timeout', count: 1 }])
    expect(local.avgLatencyMs).toBe(200)
    expect(freellm.calls).toBe(2)
    expect(freellm.ok).toBe(1)
    expect(freellm.failReasons).toEqual([{ reason: 'quota_429', count: 1 }])
    // exactly 2 stages tracked by llm_ledger + the static 'online' entry, never a 'gemini' entry
    expect(out.body.stages.map((s: any) => s.stage).sort()).toEqual(['freellm', 'local', 'online'])
  })

  it('excludes known test callers (test-agent/selftest/queue) by default, includes them with includeTest=true', async () => {
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'selftest', taskType: 'offload', provider: 'local', ok: true, nowS: now })
    appendLlmLedgerRow({ agentId: 'backend', taskType: 'offload', provider: 'local', ok: true, nowS: now })

    const excluded = mkRequest('/api/llm/chain')
    await tryHandleLlmChain(excluded.ctx)
    expect(excluded.out.body.stages.find((s: any) => s.stage === 'local').calls).toBe(1)
    expect(excluded.out.body.testTrafficIncluded).toBe(false)

    const included = mkRequest('/api/llm/chain?includeTest=true')
    await tryHandleLlmChain(included.ctx)
    expect(included.out.body.stages.find((s: any) => s.stage === 'local').calls).toBe(2)
    expect(included.out.body.testTrafficIncluded).toBe(true)
  })

  it('window=7d reaches further back than window=24h', async () => {
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'backend', taskType: 'offload', provider: 'local', ok: true, nowS: now - 3 * 24 * 3600 })

    const win24h = mkRequest('/api/llm/chain?window=24h')
    await tryHandleLlmChain(win24h.ctx)
    expect(win24h.out.body.stages.find((s: any) => s.stage === 'local').calls).toBe(0)

    const win7d = mkRequest('/api/llm/chain?window=7d')
    await tryHandleLlmChain(win7d.ctx)
    expect(win7d.out.body.stages.find((s: any) => s.stage === 'local').calls).toBe(1)
  })

  it('routing: tallies LOCAL/ONLINE verdicts + reason counts from card-build-route.log within the window', async () => {
    const now = new Date()
    // readRecentDecisions parses this as LOCAL time (matches card-build-route.sh's own `date`
    // call) -- toISOString() would be UTC and drift by the host's offset from Budapest.
    const pad = (n: number) => String(n).padStart(2, '0')
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    writeFileSync(CARD_BUILD_ROUTE_LOG_FILE, '')
    appendFileSync(CARD_BUILD_ROUTE_LOG_FILE, routeLine(fmt(now), 'cardA', 'LOCAL', 'all-stages-passed'))
    appendFileSync(CARD_BUILD_ROUTE_LOG_FILE, routeLine(fmt(now), 'cardB', 'ONLINE', 'vram-hold'))
    appendFileSync(CARD_BUILD_ROUTE_LOG_FILE, routeLine(fmt(now), 'cardC', 'ONLINE', 'vram-hold'))
    // outside the 24h window -- must not be counted
    const old = new Date(now.getTime() - 25 * 3600 * 1000)
    appendFileSync(CARD_BUILD_ROUTE_LOG_FILE, routeLine(fmt(old), 'cardD', 'ONLINE', 'model-busy'))

    const { ctx, out } = mkRequest('/api/llm/chain')
    await tryHandleLlmChain(ctx)
    expect(out.body.routing.local).toBe(1)
    expect(out.body.routing.online).toBe(2)
    expect(out.body.routing.reasons.sort((a: any, b: any) => a.reason.localeCompare(b.reason))).toEqual([
      { reason: 'all-stages-passed', count: 1 },
      { reason: 'vram-hold', count: 2 },
    ])
  })

  it('draftReview: unavailable while draft_accepted is NULL everywhere (current real state)', async () => {
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'backend', taskType: 'offload', provider: 'local', ok: true, nowS: now })
    const { ctx, out } = mkRequest('/api/llm/chain')
    await tryHandleLlmChain(ctx)
    expect(out.body.draftReview).toEqual({ available: false, verdicts: null, source: 'llm_ledger' })
  })

  it('draftReview: becomes available once draft_accepted is set, mapped to ELFOGADVA/ELUTASITVA only', async () => {
    const now = Math.floor(Date.now() / 1000)
    const id1 = appendLlmLedgerRow({ agentId: 'backend', taskType: 'offload', provider: 'local', ok: true, nowS: now })
    const id2 = appendLlmLedgerRow({ agentId: 'backend', taskType: 'offload', provider: 'local', ok: true, nowS: now })
    markLlmLedgerDraftAccepted(id1, true)
    markLlmLedgerDraftAccepted(id2, false)

    const { ctx, out } = mkRequest('/api/llm/chain')
    await tryHandleLlmChain(ctx)
    expect(out.body.draftReview).toEqual({
      available: true,
      verdicts: { ELFOGADVA: 1, RESZBEN: 0, ELUTASITVA: 1, FELESLEGES: 0 },
      source: 'llm_ledger',
    })
  })

  it('switches: freellmEnabled from the real switch file, freellmFirstLive always true', async () => {
    const unset = mkRequest('/api/llm/chain')
    await tryHandleLlmChain(unset.ctx)
    expect(unset.out.body.switches).toEqual({ freellmEnabled: false, freellmFirstLive: true, source: 'config' })

    writeFileSync(FREELLM_ENABLED_PATH, JSON.stringify({ enabled: true }))
    const set = mkRequest('/api/llm/chain')
    await tryHandleLlmChain(set.ctx)
    expect(set.out.body.switches.freellmEnabled).toBe(true)
  })

  it('cost: isEstimate always true, usd matches a priced token_usage row in the window', async () => {
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(
      "INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,model) VALUES ('marveen','s',?,1000000,0,'claude-sonnet-5')",
    ).run(now)
    const { ctx, out } = mkRequest('/api/llm/chain')
    await tryHandleLlmChain(ctx)
    expect(out.body.cost.isEstimate).toBe(true)
    expect(out.body.cost.usd).toBeGreaterThan(0)
  })
})
