// Card e96d56c5 (F4): per-call LLM ledger + per-agent budget.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'
import {
  initDatabase, appendLlmLedgerRow, markLlmLedgerDraftAccepted, getLlmLedgerSummary,
  getAgentLlmBudget, setAgentLlmBudget, getDb,
} from '../db.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { tryHandleLlmLedger } from '../web/routes/llm-ledger.js'

function call(method: string, path: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string | Buffer) { if (chunk) out.body = JSON.parse(chunk.toString()) },
  }
  const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

async function route(method: string, path: string, body?: unknown) {
  const { ctx, out } = call(method, path, body)
  expect(await tryHandleLlmLedger(ctx)).toBe(true)
  return out
}

describe('llm_ledger: DB layer', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('appendLlmLedgerRow writes exactly one row per call, local and freellm alike', () => {
    const idLocal = appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true, claudeTokenEquiv: 500 })
    const idFree = appendLlmLedgerRow({ agentId: 'backend3', taskType: 'draft', provider: 'freellm', ok: false, failReason: 'quota_429' })
    expect(idLocal).toBeGreaterThan(0)
    expect(idFree).toBeGreaterThan(idLocal)
    const summary = getLlmLedgerSummary(7)
    expect(summary.totals.calls).toBe(2)
    expect(summary.totals.ok).toBe(1)
    expect(summary.totals.fail).toBe(1)
  })

  it('summary aggregates per provider, per task type and per agent, within the day window', () => {
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true, claudeTokenEquiv: 1000, nowS: now })
    appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true, claudeTokenEquiv: 2000, nowS: now })
    appendLlmLedgerRow({ agentId: 'fron-ted', taskType: 'design', provider: 'gemini', ok: false, failReason: 'timeout', nowS: now })
    // Outside the 7-day window -- must not be counted.
    appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true, claudeTokenEquiv: 99999, nowS: now - 8 * 86400 })

    const summary = getLlmLedgerSummary(7)
    expect(summary.totals.calls).toBe(3)
    const local = summary.providers.find((p) => p.provider === 'local')!
    expect(local.calls).toBe(2)
    expect(local.ok).toBe(2)
    expect(local.claude_token_equiv_saved).toBe(3000)
    const gemini = summary.providers.find((p) => p.provider === 'gemini')!
    expect(gemini.calls).toBe(1)
    expect(gemini.fail).toBe(1)
    const code = summary.task_types.find((t) => t.task_type === 'code')!
    expect(code.calls).toBe(2)
    const backend3 = summary.agents.find((a) => a.agent_id === 'backend3')!
    expect(backend3.calls).toBe(2)
    expect(backend3.claude_token_equiv_saved).toBe(3000)
  })

  it('markLlmLedgerDraftAccepted fills in the field after the fact', () => {
    const id = appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true })
    const now = Math.floor(Date.now() / 1000)
    appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true, nowS: now })
    expect(markLlmLedgerDraftAccepted(id, true)).toBe(true)
    const summary = getLlmLedgerSummary(7)
    const local = summary.providers.find((p) => p.provider === 'local')!
    expect(local.accepted).toBe(1)
  })

  it('per-agent budget: platform default when no override row exists, override wins when set', () => {
    const platformDefault = Number(getEffectiveSettingValue('LLM_LEDGER_DEFAULT_DAILY_BUDGET'))
    expect(getAgentLlmBudget('backend3')).toEqual({ daily_budget: platformDefault, source: 'platform' })
    setAgentLlmBudget('backend3', 12345, 'mikrob')
    expect(getAgentLlmBudget('backend3')).toEqual({ daily_budget: 12345, source: 'override' })
    expect(getAgentLlmBudget('fron-ted')).toEqual({ daily_budget: platformDefault, source: 'platform' })
    // Re-setting the same agent updates, does not duplicate.
    setAgentLlmBudget('backend3', 999, 'mikrob')
    expect(getAgentLlmBudget('backend3').daily_budget).toBe(999)
  })

  it('summary.agents carries each agent own budget + source', () => {
    setAgentLlmBudget('backend3', 7000)
    appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true })
    appendLlmLedgerRow({ agentId: 'fron-ted', taskType: 'design', provider: 'gemini', ok: true })
    const summary = getLlmLedgerSummary(7)
    expect(summary.agents.find((a) => a.agent_id === 'backend3')).toMatchObject({ daily_budget: 7000, budget_source: 'override' })
    expect(summary.agents.find((a) => a.agent_id === 'fron-ted')).toMatchObject({ budget_source: 'platform' })
  })
})

describe('llm_ledger: migration rollback (card e96d56c5 requirement)', () => {
  it('both new tables can be dropped and are cleanly re-created on the next initDatabase', () => {
    initDatabase(':memory:')
    appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true })
    setAgentLlmBudget('backend3', 100)
    getDb().exec('DROP TABLE llm_ledger')
    getDb().exec('DROP TABLE agent_llm_budget')
    expect(() => appendLlmLedgerRow({ agentId: 'x', taskType: 'y', provider: 'local', ok: true })).toThrow()
    // Re-running the schema setup (what a real rollback-then-reapply would do) recreates both
    // tables empty and functional -- the down-migration loses only this table's own data, as
    // expected for a brand-new table with no prior-release content to preserve.
    initDatabase(':memory:')
    expect(() => appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true })).not.toThrow()
    expect(getLlmLedgerSummary(7).totals.calls).toBe(1)
    expect(getAgentLlmBudget('backend3').source).toBe('platform')
  })
})

describe('llm_ledger: route GET /api/llm-ledger/summary', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('returns per-provider totals for the requested window', async () => {
    appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true, claudeTokenEquiv: 500 })
    const r = await route('GET', '/api/llm-ledger/summary?days=7')
    expect(r.status).toBe(200)
    expect(r.body.days).toBe(7)
    expect(r.body.totals.calls).toBe(1)
    expect(r.body.providers[0]).toMatchObject({ provider: 'local', calls: 1, claude_token_equiv_saved: 500 })
  })

  it('defaults to 7 days when ?days is omitted', async () => {
    const r = await route('GET', '/api/llm-ledger/summary')
    expect(r.status).toBe(200)
    expect(r.body.days).toBe(7)
  })

  it('rejects an out-of-range days value', async () => {
    const r = await route('GET', '/api/llm-ledger/summary?days=0')
    expect(r.status).toBe(400)
    const r2 = await route('GET', '/api/llm-ledger/summary?days=9999')
    expect(r2.status).toBe(400)
  })
})

describe('llm_ledger: route GET/PUT /api/llm-ledger/budget/:agent', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('GET returns the platform default when unset, PUT sets an override GET then reflects', async () => {
    const before = await route('GET', '/api/llm-ledger/budget/backend3')
    expect(before.body.source).toBe('platform')
    const put = await route('PUT', '/api/llm-ledger/budget/backend3', { daily_budget: 8000, actor: 'mikrob' })
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({ ok: true, agent_id: 'backend3', daily_budget: 8000 })
    const after = await route('GET', '/api/llm-ledger/budget/backend3')
    expect(after.body).toEqual({ daily_budget: 8000, source: 'override' })
  })

  it('PUT rejects a non-integer or negative budget', async () => {
    expect((await route('PUT', '/api/llm-ledger/budget/backend3', { daily_budget: -1 })).status).toBe(400)
    expect((await route('PUT', '/api/llm-ledger/budget/backend3', { daily_budget: 1.5 })).status).toBe(400)
    expect((await route('PUT', '/api/llm-ledger/budget/backend3', { daily_budget: 'lots' })).status).toBe(400)
  })
})
