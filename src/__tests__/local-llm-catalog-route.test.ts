// Functional tests for GET /api/local-llm/catalog (card 61a4a85f, EPIC ebc7b4dd T4).
//
// The route is a thin three-tier reader in front of store/llm-catalog.py: fresh cache file ->
// live refresh -> the script's own --offline (cache-or-bundled, stale-marked) fallback -> a
// last-resort empty envelope this route synthesizes itself. Since the real script does live
// HuggingFace network calls, these tests substitute a STUB script at the mocked STORE_DIR
// location -- same spawn/parse path as production, controlled behaviour instead of a real
// network dependency (see research-routes.test.ts for the same STORE_DIR-redirection pattern).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, mkdtempSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RouteContext } from '../web/routes/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'llm-catalog-route-'))
const SANDBOX_STORE = join(tmpRoot, 'store')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot, STORE_DIR: SANDBOX_STORE }
})

const { tryHandleLocalLlm } = await import('../web/routes/local-llm.js')

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

const CACHE_FILE = join(SANDBOX_STORE, 'llm-catalog-cache.json')
const SCRIPT_FILE = join(SANDBOX_STORE, 'llm-catalog.py')
const MARKER_FILE = join(SANDBOX_STORE, 'stub-invocations.log')

// One stub, branching on env vars the test sets before each call:
//   LLM_CATALOG_STUB_BEHAVIOR: 'live_ok' | 'live_fail_offline_ok' | 'always_fail'
// Every invocation appends its argv to MARKER_FILE first, so a test can assert the script was
// (or was NOT) invoked at all -- the fresh-cache-serves-without-spawning case depends on that.
const STUB = `#!/usr/bin/env python3
import json, os, sys
with open(${JSON.stringify(MARKER_FILE)}, 'a') as f:
    f.write(' '.join(sys.argv[1:]) + '\\n')
behavior = os.environ.get('LLM_CATALOG_STUB_BEHAVIOR', 'live_ok')
offline = '--offline' in sys.argv[1:]
def envelope(source, stale):
    return {
        "schemaVersion": 1, "generatedAt": "2026-08-13T21:00:00Z", "source": source,
        "stale": stale, "host": {"gpu": {"vramTotalMib": 6144, "cpuOnly": False}, "ramTotalMib": 24000},
        "models": [], "warnings": [],
    }
if behavior == 'always_fail':
    sys.exit(1)
if behavior == 'live_fail_offline_ok':
    if not offline:
        sys.exit(1)
    print(json.dumps(envelope('cache', True)))
    sys.exit(0)
# live_ok
print(json.dumps(envelope('huggingface', offline)))
sys.exit(0)
`

beforeEach(() => {
  rmSync(SANDBOX_STORE, { recursive: true, force: true })
  mkdirSync(SANDBOX_STORE, { recursive: true })
  writeFileSync(SCRIPT_FILE, STUB)
  chmodSync(SCRIPT_FILE, 0o755)
  delete process.env.LLM_CATALOG_STUB_BEHAVIOR
})
afterEach(() => {
  delete process.env.LLM_CATALOG_STUB_BEHAVIOR
})

describe('GET /api/local-llm/catalog', () => {
  it('serves the cache file directly when it is fresh, without spawning the script at all', async () => {
    writeFileSync(CACHE_FILE, JSON.stringify({
      schemaVersion: 1, generatedAt: new Date().toISOString(), source: 'huggingface',
      stale: false, host: { gpu: { vramTotalMib: 6144, cpuOnly: false }, ramTotalMib: 24000 },
      models: [{ id: 'cached-model' }], warnings: [],
    }))
    const { ctx, out } = fakeCtx('/api/local-llm/catalog')
    await tryHandleLocalLlm(ctx)
    expect(out.status).toBe(200)
    expect(out.body.models[0].id).toBe('cached-model')
    expect(existsSync(MARKER_FILE)).toBe(false) // the stub was never invoked
  })

  it('runs a live refresh when there is no cache file yet', async () => {
    process.env.LLM_CATALOG_STUB_BEHAVIOR = 'live_ok'
    const { ctx, out } = fakeCtx('/api/local-llm/catalog')
    await tryHandleLocalLlm(ctx)
    expect(out.status).toBe(200)
    expect(out.body.source).toBe('huggingface')
    expect(out.body.stale).toBe(false)
    expect(readFileSync(MARKER_FILE, 'utf-8').trim()).toBe('') // called with no extra args
  })

  it('runs a live refresh when the cache file is older than the TTL, even though it parses fine', async () => {
    writeFileSync(CACHE_FILE, JSON.stringify({
      schemaVersion: 1, generatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      source: 'huggingface', stale: false, host: {}, models: [{ id: 'stale-cached' }], warnings: [],
    }))
    process.env.LLM_CATALOG_STUB_BEHAVIOR = 'live_ok'
    const { ctx, out } = fakeCtx('/api/local-llm/catalog')
    await tryHandleLocalLlm(ctx)
    expect(out.body.source).toBe('huggingface')
    expect(out.body.models).toEqual([]) // the LIVE stub's output, not the 24h-old cache's
  })

  it('falls back to --offline when the live refresh fails, and serves the resulting stale doc', async () => {
    process.env.LLM_CATALOG_STUB_BEHAVIOR = 'live_fail_offline_ok'
    const { ctx, out } = fakeCtx('/api/local-llm/catalog')
    await tryHandleLocalLlm(ctx)
    expect(out.status).toBe(200)
    expect(out.body.source).toBe('cache')
    expect(out.body.stale).toBe(true)
    // Each write ends with '\n' (including the live call's empty-argv line), so split on '\n'
    // and drop only the trailing empty entry the final newline produces -- .trim() would also
    // eat the leading empty-argv line and hide the live attempt.
    const raw = readFileSync(MARKER_FILE, 'utf-8').split('\n')
    const calls = raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw
    expect(calls).toEqual(['', '--offline']) // live attempt first, then the offline fallback
  })

  it('never surfaces a raw error: when live AND --offline both fail, still returns a valid envelope', async () => {
    process.env.LLM_CATALOG_STUB_BEHAVIOR = 'always_fail'
    const { ctx, out } = fakeCtx('/api/local-llm/catalog')
    await tryHandleLocalLlm(ctx)
    expect(out.status).toBe(200)
    expect(out.body.stale).toBe(true)
    expect(Array.isArray(out.body.models)).toBe(true)
    expect(out.body.models).toEqual([])
    expect(JSON.stringify(out.body)).not.toMatch(/Traceback|Error:|ENOENT/)
  })

  it('a corrupt cache file is treated as absent, not as a 500', async () => {
    writeFileSync(CACHE_FILE, '{ this is not valid json')
    process.env.LLM_CATALOG_STUB_BEHAVIOR = 'live_ok'
    const { ctx, out } = fakeCtx('/api/local-llm/catalog')
    await tryHandleLocalLlm(ctx)
    expect(out.status).toBe(200)
    expect(out.body.source).toBe('huggingface')
  })
})
