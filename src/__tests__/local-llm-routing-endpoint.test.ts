// GET /api/local-llm/routing (card ecf38e5a, pair-FE e5fc1fb4, Peti's Local-LLM page redesign): the
// task-routing decisions the dashboard had no way to SEE -- store/local-llm-model-routing.json's
// per-task overrides, src/local-llm-router.ts's always-online categories, and the last
// store/card-build-route.log build-time LOCAL/ONLINE verdicts. Read-only: no new storage, no new
// write endpoint.
//
// Uses the same sandbox-STORE_DIR isolation as local-llm-bench-state.test.ts: this route reads real
// files under STORE_DIR (routing config, active-model file, the decision log), so a plain import
// would read/depend on the LIVE install's actual state instead of a controlled fixture.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'
import type { RouteContext } from '../web/routes/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'llm-routing-endpoint-'))
const SANDBOX_STORE = join(tmpRoot, 'store')
const SKILLS_DIR = join(SANDBOX_STORE, 'local-llm-skills')
mkdirSync(SKILLS_DIR, { recursive: true })
writeFileSync(join(SKILLS_DIR, 'code.txt'), 'placeholder\n')
writeFileSync(join(SKILLS_DIR, 'daily-log.txt'), 'placeholder\n')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot, STORE_DIR: SANDBOX_STORE }
})

const {
  readRoutingOverrides,
  readRecentDecisions,
  RoutingConfigUnreadableError,
  tryHandleLocalLlm,
} = await import('../web/routes/local-llm.js')

const ROUTING_FILE = join(SANDBOX_STORE, 'local-llm-model-routing.json')
const MODEL_FILE = join(SANDBOX_STORE, 'local-llm-model')
const LOG_FILE = join(SANDBOX_STORE, 'card-build-route.log')

function rm(...paths: string[]) {
  for (const p of paths) rmSync(p, { recursive: true, force: true })
}

beforeEach(() => {
  rm(ROUTING_FILE, MODEL_FILE, LOG_FILE)
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

// --- readRoutingOverrides ------------------------------------------------------------------------

describe('readRoutingOverrides', () => {
  it('a missing file is the normal state: {}', () => {
    expect(readRoutingOverrides(ROUTING_FILE)).toEqual({})
  })

  it('reads the overrides map verbatim', () => {
    writeFileSync(ROUTING_FILE, JSON.stringify({ overrides: { 'daily-log': 'model-a', code: 'model-b' } }))
    expect(readRoutingOverrides(ROUTING_FILE)).toEqual({ 'daily-log': 'model-a', code: 'model-b' })
  })

  it('throws RoutingConfigUnreadableError on invalid JSON -- fail-closed, same direction as the disabled-model file', () => {
    writeFileSync(ROUTING_FILE, 'not json at all')
    expect(() => readRoutingOverrides(ROUTING_FILE)).toThrow(RoutingConfigUnreadableError)
  })

  it('a missing/wrongly-shaped "overrides" field is NOT a parse failure -- falls back to {} (this is a display, not a safety switch)', () => {
    writeFileSync(ROUTING_FILE, JSON.stringify({ _comment: 'no overrides key here' }))
    expect(readRoutingOverrides(ROUTING_FILE)).toEqual({})
    writeFileSync(ROUTING_FILE, JSON.stringify({ overrides: ['not', 'an', 'object'] }))
    expect(readRoutingOverrides(ROUTING_FILE)).toEqual({})
  })

  it('drops a non-string override value rather than passing it through', () => {
    writeFileSync(ROUTING_FILE, JSON.stringify({ overrides: { code: 42, 'daily-log': 'real-model' } }))
    expect(readRoutingOverrides(ROUTING_FILE)).toEqual({ 'daily-log': 'real-model' })
  })
})

// --- readRecentDecisions --------------------------------------------------------------------------

describe('readRecentDecisions', () => {
  it('a missing log is the normal "nothing has run yet" state: [] but available:true', () => {
    expect(readRecentDecisions(LOG_FILE)).toEqual({ rows: [], available: true })
  })

  it('a log that cannot be READ (not merely absent) reports available:false', () => {
    // A directory at the log's path throws EISDIR on read -- "exists but unreadable", distinct from
    // "does not exist".
    mkdirSync(LOG_FILE)
    expect(readRecentDecisions(LOG_FILE)).toEqual({ rows: [], available: false })
  })

  it('parses a verbatim line exactly as card-build-route.sh writes it, newest first', () => {
    writeFileSync(
      LOG_FILE,
      [
        '2026-09-06 07:55:46\tcbea986c\tONLINE\tpriority-high\tcalls=0\tchars=2765',
        '2026-09-06 20:26:06\teb70cb13\tLOCAL\tdeterministic-multi-decision\tcalls=1\tchars=669',
      ].join('\n') + '\n',
    )
    const { rows, available } = readRecentDecisions(LOG_FILE)
    expect(available).toBe(true)
    expect(rows).toHaveLength(2)
    // Newest first: the second file line (20:26:06) comes back first.
    expect(rows[0]).toMatchObject({
      cardId: 'eb70cb13',
      verdict: 'LOCAL',
      reason: 'deterministic-multi-decision',
      modelCalls: 1,
      chars: 669,
    })
    expect(typeof rows[0]!.ts).toBe('number')
    expect(rows[1]).toMatchObject({ cardId: 'cbea986c', verdict: 'ONLINE', reason: 'priority-high', modelCalls: 0, chars: 2765 })
    // NEVER carries card text -- the log format has nowhere to put it, and this reader adds no field
    // beyond what the log stores.
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['cardId', 'chars', 'modelCalls', 'reason', 'ts', 'verdict'])
  })

  it('a malformed line is skipped, not fatal to the whole read', () => {
    writeFileSync(
      LOG_FILE,
      ['this is not a log line', '2026-09-06 07:55:46\tcbea986c\tONLINE\tpriority-high\tcalls=0\tchars=2765'].join('\n') + '\n',
    )
    const { rows, available } = readRecentDecisions(LOG_FILE)
    expect(available).toBe(true)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cardId).toBe('cbea986c')
  })

  it('respects the limit and keeps only the NEWEST N', () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      `2026-09-06 00:00:0${i}\tcard${i}\tONLINE\tr\tcalls=0\tchars=1`)
    writeFileSync(LOG_FILE, lines.join('\n') + '\n')
    const { rows } = readRecentDecisions(LOG_FILE, 2)
    expect(rows.map((r) => r.cardId)).toEqual(['card4', 'card3'])
  })

  it('an unrecognised verdict token defaults to ONLINE, the fail-closed reading (LOCAL must be explicit)', () => {
    writeFileSync(LOG_FILE, '2026-09-06 00:00:00\tcardx\tWEIRD\tr\tcalls=0\tchars=1\n')
    expect(readRecentDecisions(LOG_FILE).rows[0]!.verdict).toBe('ONLINE')
  })
})

// --- GET /api/local-llm/routing --------------------------------------------------------------------

function get(pathname: string): Promise<{ status: number; body: any }> {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${pathname}`)
  const ctx = { req: {} as any, res, path: url.pathname, method: 'GET', url } as unknown as RouteContext
  return tryHandleLocalLlm(ctx).then(() => out)
}

describe('GET /api/local-llm/routing', () => {
  it('defaultModel is null when no model has ever been activated', async () => {
    const { status, body } = await get('/api/local-llm/routing')
    expect(status).toBe(200)
    expect(body.defaultModel).toBeNull()
  })

  it('defaultModel reflects store/local-llm-model when set', async () => {
    writeFileSync(MODEL_FILE, 'qwen2.5-coder:7b\n')
    const { body } = await get('/api/local-llm/routing')
    expect(body.defaultModel).toBe('qwen2.5-coder:7b')
  })

  it('overrides is {} verbatim with no routing file, presets fall back to the default model', async () => {
    writeFileSync(MODEL_FILE, 'default-model')
    const { body } = await get('/api/local-llm/routing')
    expect(body.overrides).toEqual({})
    const code = body.presets.find((p: any) => p.task === 'code')
    expect(code).toMatchObject({ task: 'code', model: 'default-model', source: 'default' })
  })

  it('a preset with an override reports source:override and the overridden model, not the default', async () => {
    writeFileSync(MODEL_FILE, 'default-model')
    writeFileSync(ROUTING_FILE, JSON.stringify({ overrides: { 'daily-log': 'special-model' } }))
    const { body } = await get('/api/local-llm/routing')
    expect(body.overrides).toEqual({ 'daily-log': 'special-model' })
    const dailyLog = body.presets.find((p: any) => p.task === 'daily-log')
    expect(dailyLog).toMatchObject({ task: 'daily-log', model: 'special-model', source: 'override' })
    const code = body.presets.find((p: any) => p.task === 'code')
    expect(code).toMatchObject({ model: 'default-model', source: 'default' })
  })

  it('alwaysOnline is CATEGORY_CEILINGS imported from the router, not a copy -- authz/isolation/security-decision/architecture are "never"', async () => {
    const { body } = await get('/api/local-llm/routing')
    expect(body.alwaysOnline).toMatchObject({
      authz: 'never',
      isolation: 'never',
      'security-decision': 'never',
      architecture: 'never',
    })
    expect(typeof body.alwaysOnline['multi-file-wiring']).toBe('string')
  })

  it('recentDecisions is [] with decisionsLogAvailable:true when no log has ever been written', async () => {
    const { body } = await get('/api/local-llm/routing')
    expect(body.recentDecisions).toEqual([])
    expect(body.decisionsLogAvailable).toBe(true)
  })

  it('recentDecisions surfaces parsed log rows, newest first', async () => {
    writeFileSync(
      LOG_FILE,
      [
        '2026-09-06 07:00:00\tcarda\tONLINE\tpriority-high\tcalls=0\tchars=10',
        '2026-09-06 08:00:00\tcardb\tLOCAL\treason-b\tcalls=1\tchars=20',
      ].join('\n') + '\n',
    )
    const { body } = await get('/api/local-llm/routing')
    expect(body.recentDecisions.map((r: any) => r.cardId)).toEqual(['cardb', 'carda'])
    expect(body.decisionsLogAvailable).toBe(true)
  })

  it('decisionsLogAvailable:false when the log exists but cannot be read', async () => {
    mkdirSync(LOG_FILE)
    const { body } = await get('/api/local-llm/routing')
    expect(body.recentDecisions).toEqual([])
    expect(body.decisionsLogAvailable).toBe(false)
  })

  it('a malformed routing config fails CLOSED: 503 routing_unreadable naming the file, not a silent {}', async () => {
    writeFileSync(ROUTING_FILE, 'not json')
    const { status, body } = await get('/api/local-llm/routing')
    expect(status).toBe(503)
    expect(body.error).toBe('routing_unreadable')
    expect(body.message).toContain(ROUTING_FILE)
  })

  it('presets carry usage count/lastTs from listCategories, and every known category is present', async () => {
    const { body } = await get('/api/local-llm/routing')
    const tasks = body.presets.map((p: any) => p.task).sort()
    expect(tasks).toEqual(['code', 'daily-log'])
    for (const p of body.presets) {
      expect(typeof p.enabled).toBe('boolean')
      expect(typeof p.count).toBe('number')
      expect(p.lastTs === null || typeof p.lastTs === 'number').toBe(true)
    }
  })
})
