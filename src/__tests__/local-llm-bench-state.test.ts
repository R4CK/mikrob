// "Installed" vs "measured on this hardware" (card d730070e).
//
// The catalogue schema carried installedAt and benchmarkedAt from the start, both hardcoded to null
// -- store/llm-catalog-selftest.py even asserted they always would be. Two fields, no state behind
// them, so nothing could tell a benchmarked model from one downloaded a minute ago. This suite
// covers the state that now backs them, and the three places it has to survive: the writer (bash),
// the reader (module), and the status endpoint the UI actually consumes.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RouteContext } from '../web/routes/types.js'

const ROOT = join(__dirname, '..', '..')
const tmpRoot = mkdtempSync(join(tmpdir(), 'llm-bench-state-'))
const SANDBOX_STORE = join(tmpRoot, 'store')
mkdirSync(SANDBOX_STORE, { recursive: true })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot, STORE_DIR: SANDBOX_STORE }
})

const { readBenchState, benchInfoFor } = await import('../local-llm-bench-state.js')
const { tryHandleLocalLlm } = await import('../web/routes/local-llm.js')

const STATE = join(SANDBOX_STORE, 'local-llm-model-state.json')
const MODEL = 'qwen2.5-coder:7b-instruct-q4_K_M'
const OTHER = 'llama3:8b'

function record(stateFile: string, model: string, tps: string, ctx: string, label: string) {
  return spawnSync('bash', [join(ROOT, 'store', 'local-llm-bench.sh'), '--record', model, tps, ctx, label], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, LOCAL_LLM_STATE_FILE: stateFile },
  })
}

beforeEach(() => {
  rmSync(STATE, { force: true })
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('the bench script is the only writer of the benchmark record', () => {
  it('writes the measurement, with the context it was taken at', () => {
    const r = record(STATE, MODEL, '18.4', '4096', 'baseline')
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
    const doc = JSON.parse(readFileSync(STATE, 'utf-8'))
    expect(doc.models[MODEL].evalTps).toBe(18.4)
    // A tok/s figure without its context size is not comparable to the next one, so the ctx is part
    // of the record rather than something the reader has to assume.
    expect(doc.models[MODEL].ctx).toBe(4096)
    expect(doc.models[MODEL].label).toBe('baseline')
    expect(typeof doc.models[MODEL].benchmarkedAt).toBe('string')
  })

  it('a second model does not clobber the first', () => {
    // The read-modify-write property. A writer that just serialised its own model would silently
    // erase every other measurement, and nothing else in this suite would notice.
    record(STATE, MODEL, '18.4', '4096', 'baseline')
    record(STATE, OTHER, '31.0', '8192', 'run2')
    const doc = JSON.parse(readFileSync(STATE, 'utf-8'))
    expect(Object.keys(doc.models).sort()).toEqual([OTHER, MODEL].sort())
    expect(doc.models[MODEL].evalTps).toBe(18.4)
  })

  it('a corrupt state file is replaced, not appended to', () => {
    writeFileSync(STATE, 'not json at all')
    const r = record(STATE, MODEL, '9.9', '4096', 'x')
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
    expect(JSON.parse(readFileSync(STATE, 'utf-8')).models[MODEL].evalTps).toBe(9.9)
  })

  it('refuses a call with the wrong number of arguments instead of writing junk', () => {
    const r = spawnSync('bash', [join(ROOT, 'store', 'local-llm-bench.sh'), '--record', MODEL], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, LOCAL_LLM_STATE_FILE: STATE },
    })
    expect(r.status).toBe(2)
  })
})

describe('readBenchState', () => {
  it('reports not-benchmarked when there is no file -- absence is never evidence', () => {
    expect(readBenchState(STATE)).toEqual({})
    expect(benchInfoFor({}, MODEL)).toEqual({
      benchmarked: false, benchmarkedAt: null, evalTps: null, benchCtx: null,
    })
  })

  it('ignores a record with no timestamp: that is not a measurement', () => {
    writeFileSync(STATE, JSON.stringify({ models: { [MODEL]: { evalTps: 20 } } }))
    expect(readBenchState(STATE)).toEqual({})
  })

  it('survives a malformed file rather than throwing into the caller', () => {
    writeFileSync(STATE, '{ "models": [1,2,3] }')
    expect(readBenchState(STATE)).toEqual({})
  })

  it('round-trips what the bash writer produced', () => {
    record(STATE, MODEL, '18.4', '4096', 'baseline')
    const info = benchInfoFor(readBenchState(STATE), MODEL)
    expect(info.benchmarked).toBe(true)
    expect(info.evalTps).toBe(18.4)
    expect(info.benchCtx).toBe(4096)
  })
})

describe('GET /api/local-llm/status separates installed from benchmarked', () => {
  function get(): Promise<{ status: number; body: any }> {
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = {
      writeHead(status: number) { out.status = status; return res },
      end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    }
    const url = new URL('http://localhost:3420/api/local-llm/status')
    const ctx = { req: {} as any, res, path: url.pathname, method: 'GET', url } as unknown as RouteContext
    return tryHandleLocalLlm(ctx).then(() => out)
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', async (u: string) => {
      if (String(u).endsWith('/api/tags')) {
        return new Response(JSON.stringify({
          models: [
            { name: MODEL, size: 4_400_000_000, modified_at: '2026-08-10T09:00:00Z' },
            { name: OTHER, size: 4_700_000_000, modified_at: '2026-08-12T11:00:00Z' },
          ],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200 })
    })
  })

  it('installedAt comes from the runtime, so a hand-pulled model is not left blank', async () => {
    const r = await get()
    const m = r.body.models.find((x: any) => x.name === MODEL)
    expect(m.installedAt).toBe('2026-08-10T09:00:00Z')
  })

  it('a downloaded model reads as NOT benchmarked until something measures it', async () => {
    const r = await get()
    for (const m of r.body.models) expect(m.benchmarked).toBe(false)
  })

  it('after a real bench run, only THAT model flips to benchmarked', async () => {
    record(STATE, MODEL, '18.4', '4096', 'baseline')
    const r = await get()
    const measured = r.body.models.find((x: any) => x.name === MODEL)
    const untouched = r.body.models.find((x: any) => x.name === OTHER)
    expect(measured.benchmarked).toBe(true)
    expect(measured.evalTps).toBe(18.4)
    expect(measured.benchCtx).toBe(4096)
    // The control that keeps "benchmarked" from meaning "installed": the other model is equally
    // installed and must stay unmeasured.
    expect(untouched.benchmarked).toBe(false)
  })
})
