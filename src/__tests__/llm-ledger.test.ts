// Card e96d56c5 (F4): per-call LLM ledger + per-agent budget.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'
import {
  initDatabase, appendLlmLedgerRow, markLlmLedgerDraftAccepted, getLlmLedgerSummary,
  getAgentLlmBudget, setAgentLlmBudget, getDb,
} from '../db.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { getSettingDefinition } from '../config-registry.js'

// card 1a3c6459 (F2): isKnownAgent stats agents/<name> on disk, which the repo deliberately does
// not track (see /agents/ in .gitignore) -- a fixed fixture roster keeps this test independent of
// whatever agent directories happen to exist on whichever checkout it runs in.
const KNOWN_TEST_AGENTS = new Set(['backend3', 'fron-ted'])
vi.mock('../web/agent-config.js', () => ({
  isKnownAgent: (name: string) => KNOWN_TEST_AGENTS.has(name),
}))

import { tryHandleLlmLedger } from '../web/routes/llm-ledger.js'

// `:memory:` cannot serve a rollback test: initDatabase() opens a NEW in-memory database every
// call, so "drop the table, re-init" on memory would silently test a fresh DB and prove nothing
// about an existing store (same pitfall + fix as src/__tests__/stuck-incidents-schema.test.ts,
// caught here by QA2 comment 29600 on this card's first REVIEW). A temp FILE, re-initDatabase'd
// on the SAME path, is also the real deployment shape.
const tmpDirs: string[] = []
function persistentDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'llm-ledger-'))
  tmpDirs.push(dir)
  const path = join(dir, 'test.db')
  initDatabase(path)
  return path
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

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
  it('DROP on a PERSISTENT store, re-init on the SAME path restores both tables without touching other data', () => {
    const path = persistentDbPath()
    // A pre-existing row in an UNRELATED table proves the re-init below really is the SAME store,
    // not a fresh one (the exact defect QA2 caught: two initDatabase(':memory:') calls are two
    // independent databases, so a passing assertion there proves nothing about recovery).
    getDb().prepare(
      `INSERT INTO kanban_cards (id, title, status, created_at, updated_at) VALUES (?,?,?,?,?)`,
    ).run('c-pre', 'pre-existing card', 'planned', 1_700_000_000, 1_700_000_000)
    appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true })
    setAgentLlmBudget('backend3', 100)

    getDb().exec('DROP TABLE llm_ledger')
    getDb().exec('DROP TABLE agent_llm_budget')
    expect(() => appendLlmLedgerRow({ agentId: 'x', taskType: 'y', provider: 'local', ok: true })).toThrow()

    // The redeploy after a rollback: re-run the initialiser on the SAME file.
    initDatabase(path)
    const restored = getDb()
    expect(restored.prepare(`SELECT name FROM sqlite_master WHERE name='llm_ledger'`).get()).toBeTruthy()
    expect(restored.prepare(`SELECT name FROM sqlite_master WHERE name='agent_llm_budget'`).get()).toBeTruthy()
    // Pre-existing, unrelated data survived -- this really is the same store recovering, not a
    // fresh database that happens to also pass the same assertions.
    expect(restored.prepare(`SELECT id FROM kanban_cards WHERE id='c-pre'`).get()).toEqual({ id: 'c-pre' })
    // The down-migration loses only THIS table's own prior rows (a brand-new table with no
    // prior-release content to preserve) -- but the tables themselves are functional again.
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

  // card 1a3c6459 (F1): PUT now requires an authenticated session/device principal -- `call()`'s
  // bare RouteContext has no `auth` at all, so these helpers attach one explicitly per case.
  function withAuth(ctx: RouteContext, auth: RouteContext['auth']): RouteContext {
    return { ...ctx, auth }
  }
  async function putAs(auth: RouteContext['auth'], agent: string, body: unknown) {
    const { ctx, out } = call('PUT', `/api/llm-ledger/budget/${agent}`, body)
    expect(await tryHandleLlmLedger(withAuth(ctx, auth))).toBe(true)
    return out
  }
  const SESSION = { kind: 'session', user: 'peti' } as const
  const DEVICE = { kind: 'device', device: 'bridge-1' } as const
  const TOKEN = { kind: 'token', agent: 'backend3' } as const

  it('GET returns the platform default when unset, PUT (as a session) sets an override GET then reflects', async () => {
    const before = await route('GET', '/api/llm-ledger/budget/backend3')
    expect(before.body.source).toBe('platform')
    const put = await putAs(SESSION, 'backend3', { daily_budget: 8000 })
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({ ok: true, agent_id: 'backend3', daily_budget: 8000 })
    const after = await route('GET', '/api/llm-ledger/budget/backend3')
    expect(after.body).toEqual({ daily_budget: 8000, source: 'override' })
  })

  it('PUT rejects a non-integer, negative, non-finite, or above-platform-max budget (400), red on the pre-fix 3e1152142 code', async () => {
    const platformMax = Number(getSettingDefinition('LLM_LEDGER_DEFAULT_DAILY_BUDGET')!.max)
    expect((await putAs(SESSION, 'backend3', { daily_budget: -1 })).status).toBe(400)
    expect((await putAs(SESSION, 'backend3', { daily_budget: 1.5 })).status).toBe(400)
    expect((await putAs(SESSION, 'backend3', { daily_budget: 'lots' })).status).toBe(400)
    expect((await putAs(SESSION, 'backend3', { daily_budget: Number.NaN })).status).toBe(400)
    expect((await putAs(SESSION, 'backend3', { daily_budget: Number.POSITIVE_INFINITY })).status).toBe(400)
    // The 3e1152142 defect, measured live by WhiteHat2: 1e300, 1e15 and a value one past the
    // platform max were all accepted because Number.isInteger(1e300) is true and there was no
    // upper bound at all.
    expect((await putAs(SESSION, 'backend3', { daily_budget: 1e300 })).status).toBe(400)
    expect((await putAs(SESSION, 'backend3', { daily_budget: platformMax + 1 })).status).toBe(400)
    const atMax = await putAs(SESSION, 'backend3', { daily_budget: platformMax })
    expect(atMax.status).toBe(200)
  })

  it('PUT refuses a shared fleet token (403) -- only a session or device principal may write (F1)', async () => {
    const asToken = await putAs(TOKEN, 'backend3', { daily_budget: 100 })
    expect(asToken.status).toBe(403)
    expect(getAgentLlmBudget('backend3').source).toBe('platform') // nothing written
    const asDevice = await putAs(DEVICE, 'backend3', { daily_budget: 100 })
    expect(asDevice.status).toBe(200)
  })

  it('PUT takes updated_by from the authenticated principal, never from the request body (F1)', async () => {
    await putAs(SESSION, 'backend3', { daily_budget: 100, actor: 'mikrob (forged)' })
    const row = getDb().prepare('SELECT updated_by FROM agent_llm_budget WHERE agent_id = ?').get('backend3') as { updated_by: string }
    expect(row.updated_by).toBe('peti')
    await putAs(DEVICE, 'fron-ted', { daily_budget: 200, actor: 'anyone' })
    const row2 = getDb().prepare('SELECT updated_by FROM agent_llm_budget WHERE agent_id = ?').get('fron-ted') as { updated_by: string }
    expect(row2.updated_by).toBe('bridge-1')
  })

  it('GET and PUT refuse an unknown agent id (404) and an over-length id never reaches isKnownAgent (F2)', async () => {
    expect((await route('GET', '/api/llm-ledger/budget/no-such-agent-xyz')).status).toBe(404)
    expect((await putAs(SESSION, 'no-such-agent-xyz', { daily_budget: 100 })).status).toBe(404)
    const longId = 'a'.repeat(5000)
    expect((await route('GET', `/api/llm-ledger/budget/${longId}`)).status).toBe(404)
  })

  it('PUT rejects an oversized body (413) and stops reading the stream well under the body size (F2)', async () => {
    // process.memoryUsage().rss is too noisy for this (GC timing, and the TEST's own fixture
    // construction dwarfs anything the route does) -- so this measures the actual guarantee
    // directly: how many bytes the route's readBody() PULLS from the stream before giving up.
    // A generator yields 1MB chunks lazily (never materializing the full body at once); if
    // readBody buffered the whole thing before rejecting, bytesPulled would reach the full 20MB.
    const CHUNK = 1024 * 1024
    const TOTAL_CHUNKS = 20
    let bytesPulled = 0
    async function* chunks() {
      for (let i = 0; i < TOTAL_CHUNKS; i++) {
        bytesPulled += CHUNK
        yield Buffer.alloc(CHUNK, 'x')
      }
    }
    const out: { status: number; body: any } = { status: 200, body: null }
    const res: any = {
      writeHead(status: number) { out.status = status; return res },
      setHeader() { return res },
      end(chunk?: string | Buffer) { if (chunk) out.body = JSON.parse(chunk.toString()) },
    }
    const req: any = Readable.from(chunks())
    req.headers = {}
    const url = new URL('http://localhost:3420/api/llm-ledger/budget/backend3')
    const ctx = withAuth({ req, res, path: url.pathname, method: 'PUT', url } as RouteContext, SESSION)
    expect(await tryHandleLlmLedger(ctx)).toBe(true)
    expect(out.status).toBe(413)
    // No budget row should have been written off a refused oversized body.
    expect(getAgentLlmBudget('backend3').source).toBe('platform')
    // BUDGET_BODY_MAX_BYTES is 4KB; readBody destroys the stream on the chunk that crosses it, so
    // at most ~1 chunk (1MB) is ever pulled, nowhere near the full 20MB body.
    expect(bytesPulled).toBeLessThan(2 * CHUNK)
  })
})

describe('llm_ledger: negative counts refused at the DB layer (F3, 1a3c6459)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a negative latency_ms, prompt_chars, response_chars or claude_token_equiv throws, nothing is stored', () => {
    expect(() => appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true, latencyMs: -5 })).toThrow()
    expect(() => appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true, promptChars: -1 })).toThrow()
    expect(() => appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true, responseChars: -1 })).toThrow()
    expect(() => appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true, claudeTokenEquiv: -99_999_999 })).toThrow()
    expect(getLlmLedgerSummary(7).totals.calls).toBe(0)
  })

  it('a NULL (omitted) numeric field is still accepted -- the CHECK does not require every column', () => {
    expect(() => appendLlmLedgerRow({ agentId: 'backend3', taskType: 'code', provider: 'local', ok: true })).not.toThrow()
    expect(getLlmLedgerSummary(7).totals.calls).toBe(1)
  })
})
