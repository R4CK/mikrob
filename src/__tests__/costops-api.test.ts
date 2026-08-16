import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { tryHandleCosts, startCostsSyncTask } from '../web/routes/costs.js'
import { monthWindow } from '../costops/ledger.js'
import { COSTOPS_CONFIG_PATH } from '../costops/config.js'
import type { RouteContext } from '../web/routes/types.js'

// Minimal fake ServerResponse capturing what json() writes.
function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as any, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

describe('costops API (route smoke)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('GET /api/costs/summary returns a well-formed read-only summary', async () => {
    // seed a current-month token_usage row -> proves volume is reported but NOT priced
    const now = Math.floor(Date.now() / 1000)
    const w = monthWindow(now)
    getDb().prepare("INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens) VALUES ('marveen','s',?,1234,5678,0,0)").run(w.start + 100)

    const { ctx, out } = fakeCtx('/api/costs/summary')
    const handled = await tryHandleCosts(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    // shape
    expect(out.body).toHaveProperty('month')
    expect(out.body).toHaveProperty('current_spend')
    expect(out.body).toHaveProperty('forecast_month_end')
    expect(out.body).toHaveProperty('top_sources')
    expect(out.body).toHaveProperty('confidence_breakdown')
    expect(out.body).toHaveProperty('breakdown')
    expect(out.body).toHaveProperty('budget')
    expect(out.body).toHaveProperty('token_usage')
    // token usage reported as VOLUME
    expect(out.body.token_usage.input_tokens).toBe(1234)
    expect(out.body.token_usage.output_tokens).toBe(5678)
    // no model on the seeded row -> unpriced, not silently zero-cost
    expect(out.body.token_usage.estimated_cost_usd).toBe(0)
    expect(out.body.token_usage.unpriced_calls).toBe(1)
    // money never derived from tokens (config amounts are 0 placeholders)
    expect(typeof out.body.current_spend).toBe('number')
    // no secret / account id leaks into the response
    expect(JSON.stringify(out.body)).not.toMatch(/secret|api[_-]?key|password|token=/i)
  })

  it('GET /api/costs/token-cost returns a per-agent/per-day USD estimate (card d2cfa818)', async () => {
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare("INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,model) VALUES ('marveen','s',?,1000000,0,'claude-sonnet-5')").run(now)

    const { ctx, out } = fakeCtx('/api/costs/token-cost')
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toHaveProperty('rows')
    expect(out.body).toHaveProperty('since_days', 30)
    expect(Array.isArray(out.body.rows)).toBe(true)
    const row = out.body.rows.find((r: { agent: string }) => r.agent === 'marveen')
    expect(row.estimated_cost_usd).toBe(2.0) // 1,000,000 input tokens @ $2/MTok
    // no secret / account id leaks
    expect(JSON.stringify(out.body)).not.toMatch(/secret|api[_-]?key|password|token=/i)
  })

  it('GET /api/costs/token-cost?days=N honours the lookback window', async () => {
    const { ctx, out } = fakeCtx('/api/costs/token-cost?days=7')
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.body.since_days).toBe(7)
  })

  // card f597369b: the overview widget (card 01b51197) called this exact path/shape and 404'd,
  // because the real backend (d2cfa818, above) shipped under a different path with a different
  // shape (per agent+day, snake_case). This aggregates the same data into what the widget expects.
  describe('GET /api/costops/estimates (card f597369b, widget contract for card 01b51197)', () => {
    it('aggregates per-agent across days into the shape the overview widget expects', async () => {
      const now = Math.floor(Date.now() / 1000)
      const db = getDb()
      db.prepare("INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,model) VALUES ('marveen','s1',?,1000000,0,'claude-sonnet-5')").run(now)
      // A second day for the SAME agent -- must be SUMMED into one row, not left split by day.
      db.prepare("INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,model) VALUES ('marveen','s2',?,500000,0,'claude-sonnet-5')").run(now - 2 * 86400)
      db.prepare("INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,model) VALUES ('qa','s3',?,0,1000000,'claude-sonnet-5')").run(now)

      const { ctx, out } = fakeCtx('/api/costops/estimates')
      expect(await tryHandleCosts(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(Array.isArray(out.body.estimates)).toBe(true)
      expect(out.body.estimates).toHaveLength(2) // one row PER AGENT, not per agent-per-day

      const marveen = out.body.estimates.find((e: { agent: string }) => e.agent === 'marveen')
      expect(marveen.estimatedUsd).toBeCloseTo(3.0, 6) // (1,000,000 + 500,000) input @ $2/MTok
      expect(marveen.inputTokens).toBe(1500000)
      expect(marveen.outputTokens).toBe(0)

      // sorted by cost descending -- the widget's proportional bar assumes the biggest is first.
      expect(out.body.estimates[0].agent).toBe('marveen')
      expect(typeof out.body.totalEstimatedUsd).toBe('number')
      expect(out.body.totalEstimatedUsd).toBeGreaterThan(0)
      expect(typeof out.body.note).toBe('string')
      // no secret / account id leaks
      expect(JSON.stringify(out.body)).not.toMatch(/secret|api[_-]?key|password|token=/i)
    })

    it('no usage rows at all -> empty estimates array, zero total (the widget renders its own empty state)', async () => {
      const { ctx, out } = fakeCtx('/api/costops/estimates')
      expect(await tryHandleCosts(ctx)).toBe(true)
      expect(out.body.estimates).toEqual([])
      expect(out.body.totalEstimatedUsd).toBe(0)
    })
  })

  it('GET /api/costs/sources returns an array', async () => {
    const { ctx, out } = fakeCtx('/api/costs/sources')
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
  })

  it('falls through (returns false) for unrelated paths', async () => {
    const { ctx } = fakeCtx('/api/kanban')
    expect(await tryHandleCosts(ctx)).toBe(false)
  })

  // Review blocker (Szotasz, PR #524): "the GET endpoint performs writes". Proven with a
  // REAL fixed cost configured (not the empty default), so there is something a buggy
  // sync-on-GET would actually have inserted -- an empty-config test wouldn't distinguish
  // "no write call" from "nothing to write".
  describe('GET /api/costs/summary is read-only (review blocker regression)', () => {
    const hadConfig = existsSync(COSTOPS_CONFIG_PATH)
    beforeEach(() => {
      mkdirSync(dirname(COSTOPS_CONFIG_PATH), { recursive: true })
      writeFileSync(COSTOPS_CONFIG_PATH, JSON.stringify({
        version: 1, currency: 'HUF',
        fixed_costs: [{ source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 22000 }],
        budgets: [],
      }))
    })
    afterEach(() => { if (!hadConfig) { try { unlinkSync(COSTOPS_CONFIG_PATH) } catch { /* already gone */ } } })

    it('never inserts into cost_line_items/cost_sources, even with a real fixed cost configured', async () => {
      const { ctx } = fakeCtx('/api/costs/summary')
      expect(await tryHandleCosts(ctx)).toBe(true)
      expect(await tryHandleCosts(ctx)).toBe(true) // twice, to also rule out a one-shot lazy-write pattern
      const items = (getDb().prepare('SELECT COUNT(*) as n FROM cost_line_items').get() as { n: number }).n
      const sources = (getDb().prepare('SELECT COUNT(*) as n FROM cost_sources').get() as { n: number }).n
      expect(items).toBe(0)
      expect(sources).toBe(0)
    })

    it('startCostsSyncTask() is where the write actually happens, and it works', () => {
      startCostsSyncTask(24 * 60 * 60 * 1000) // long interval -- test only needs the immediate one-shot run
      const row = getDb().prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='anthropic-max'").get() as { billed_cost: number } | undefined
      expect(row?.billed_cost).toBe(22000)
    })
  })
})
