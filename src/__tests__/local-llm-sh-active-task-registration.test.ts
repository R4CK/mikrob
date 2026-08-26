// Card 5dcd9bc8: store/local-llm.sh registers a direct/synchronous call as `running` in the
// local_llm_queue table BEFORE attempting the GPU flock, and marks it complete/fail afterwards --
// so the dashboard's active-task tile finally reflects real concurrent local-LLM activity instead
// of the narrow async offload queue (which real usage never touched).
//
// Behavioural, like local-llm-sh-task-allowlist.test.ts: runs the REAL script against fake Ollama
// and fake dashboard HTTP servers on localhost, so the actual wiring (not a source-text guess) is
// what's under test. baseEnv() below leaves the GPU flock path at its default
// (/tmp/local-llm-gpu.lock) -- intentionally the real, global, unparameterized lock the whole fleet
// shares (see local-llm.sh's own comment on GPU_LOCK). These fake calls resolve in milliseconds, but
// the LOCK ITSELF is real and shared: card 8a6de2ee measured these tests timing out at ~5009ms under
// genuine fleet contention (a concurrent fleet agent's own local-llm.sh call holding that same global
// lock), while isolated runs were 8/8 green. LOCAL_LLM_LOCK_WAIT=60 below is intentional patience for
// exactly that -- but vitest's own default 5000ms per-test timeout was SHORTER than that patience
// budget, so it fired first. TEST_TIMEOUT_MS (below) fixes that; the last test in this file proves it
// against a real (throwaway, non-shared) lock held for longer than vitest's old 5000ms default.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'local-llm.sh')

const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-active-task-'))
const TOKEN_FILE = join(tmpDir, 'token')
writeFileSync(TOKEN_FILE, 'test-token\n')
const MISSING_TOKEN_FILE = join(tmpDir, 'no-such-token')

type DashCall = { path: string; method: string; body: unknown }
let dashCalls: DashCall[] = []
let nextId = 1
let ollamaGenerateFails = false

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
  })
}

let ollamaServer: Server
let dashServer: Server
let ollamaPort: number
let dashPort: number

beforeAll(async () => {
  ollamaServer = createServer(async (req, res) => {
    if (req.url === '/api/tags' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'test-model' }] }))
      return
    }
    if (req.url === '/api/generate' && req.method === 'POST') {
      await readBody(req)
      if (ollamaGenerateFails) {
        res.writeHead(500)
        res.end('boom')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ response: 'hi', eval_count: 3, prompt_eval_count: 5 }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  dashServer = createServer(async (req, res) => {
    const bodyRaw = await readBody(req)
    let body: unknown = null
    try { body = bodyRaw ? JSON.parse(bodyRaw) : null } catch { /* ignore */ }
    dashCalls.push({ path: req.url ?? '', method: req.method ?? '', body })
    if (req.url === '/api/local-llm/queue/start' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: nextId++, status: 'running' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => ollamaServer.listen(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => dashServer.listen(0, '127.0.0.1', resolve))
  ollamaPort = (ollamaServer.address() as { port: number }).port
  dashPort = (dashServer.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise((resolve) => ollamaServer.close(resolve))
  await new Promise((resolve) => dashServer.close(resolve))
})

beforeEach(() => {
  dashCalls = []
  ollamaGenerateFails = false
})

function baseEnv(overrides: Record<string, string> = {}) {
  return {
    ...process.env,
    OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
    WEB_PORT: String(dashPort),
    LOCAL_LLM_DASH_TOKEN_FILE: TOKEN_FILE,
    LOCAL_LLM_LOCK_WAIT: '60',
    LOCAL_LLM_TIMEOUT: '10',
    ...overrides,
  }
}

const execFileP = promisify(execFile)

// Card 8a6de2ee: measured timing out at exactly ~5009ms under real fleet contention (isolated runs:
// 8/8 green) -- vitest's default 5000ms per-test timeout is SHORTER than LOCAL_LLM_LOCK_WAIT=60
// above, so a genuinely real, machine-wide wait on the shared /tmp/local-llm-gpu.lock (another
// concurrent local-llm.sh invocation elsewhere on the fleet, e.g. the heartbeat offload-sweep or
// another suite's own local-llm tests) killed the test before the script's OWN configured patience
// budget could resolve it. Every test below runs the real script through that same global lock, so
// all four get the same margin: comfortably past LOCAL_LLM_LOCK_WAIT, not just the two that were
// caught failing this way.
const TEST_TIMEOUT_MS = 65_000

// MUST be async execFile, not execFileSync: execFileSync blocks Node's event loop for the whole
// child run, and the fake Ollama/dashboard servers above are handlers on THIS SAME event loop --
// with a sync exec the child's curl calls back into this process and gets zero bytes until the
// event loop is free again (measured: a hard 5s curl timeout, not a fast, obvious failure).
async function run(args: string[], env: Record<string, string | undefined>): Promise<{ status: number; stdout: string }> {
  try {
    const { stdout } = await execFileP('bash', [SCRIPT, ...args], { encoding: 'utf-8', env })
    return { status: 0, stdout }
  } catch (e) {
    const err = e as { code?: number; stdout?: string }
    return { status: err.code ?? -1, stdout: String(err.stdout ?? '') }
  }
}

describe('local-llm.sh active-task registration (card 5dcd9bc8)', () => {
  it('registers start before the call and complete after, on a direct/bare invocation', async () => {
    const r = await run(
      ['--model', 'test-model', '--caller', 'test-agent', '--log-task', 'test-task', 'hello prompt'],
      baseEnv(),
    )
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('hi')

    const starts = dashCalls.filter((c) => c.path === '/api/local-llm/queue/start')
    expect(starts).toHaveLength(1)
    const startBody = starts[0]!.body as Record<string, unknown>
    expect(startBody.agent).toBe('test-agent')
    expect(startBody.task_type).toBe('test-task')
    expect(startBody.source).toBe('direct-sync')

    const finishes = dashCalls.filter((c) => /\/api\/local-llm\/queue\/\d+\/(complete|fail)$/.test(c.path))
    expect(finishes).toHaveLength(1)
    expect(finishes[0]!.path).toMatch(/\/complete$/)
  }, TEST_TIMEOUT_MS)

  it('marks the row failed when the model call itself fails', async () => {
    ollamaGenerateFails = true
    const r = await run(['--model', 'test-model', '--caller', 'test-agent', 'hello'], baseEnv())
    expect(r.status).not.toBe(0)

    const starts = dashCalls.filter((c) => c.path === '/api/local-llm/queue/start')
    expect(starts).toHaveLength(1)
    const finishes = dashCalls.filter((c) => /\/api\/local-llm\/queue\/\d+\/(complete|fail)$/.test(c.path))
    expect(finishes).toHaveLength(1)
    expect(finishes[0]!.path).toMatch(/\/fail$/)
  }, TEST_TIMEOUT_MS)

  it('--queue-managed (the worker path) registers NOTHING -- the claimed row already exists', async () => {
    const r = await run(
      ['--model', 'test-model', '--caller', 'queue', '--queue-managed', 'hello'],
      baseEnv(),
    )
    expect(r.status).toBe(0)
    expect(dashCalls).toHaveLength(0)
  }, TEST_TIMEOUT_MS)

  it('a missing dashboard token degrades silently -- the model call still succeeds', async () => {
    const r = await run(
      ['--model', 'test-model', '--caller', 'test-agent', 'hello'],
      baseEnv({ LOCAL_LLM_DASH_TOKEN_FILE: MISSING_TOKEN_FILE }),
    )
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('hi')
    expect(dashCalls).toHaveLength(0)
  }, TEST_TIMEOUT_MS)

  // Proves TEST_TIMEOUT_MS is doing real work, not just a bigger number picked on faith. Uses a
  // THROWAWAY lock file (LOCAL_LLM_GPU_LOCK_PATH override), never the real shared
  // /tmp/local-llm-gpu.lock -- holding the real one for this test would itself contend with any
  // other concurrent fleet agent's genuine local-llm.sh call, the exact problem this fix is about.
  it('survives a real GPU-lock wait LONGER than vitest\'s old 5000ms default, via the raised timeout', async () => {
    const lockPath = join(tmpDir, 'gpu-contention.lock')
    // 7s: longer than vitest's old 5000ms default (this would have failed pre-fix), comfortably
    // inside LOCAL_LLM_LOCK_WAIT=60 and TEST_TIMEOUT_MS=65000.
    const holder: ChildProcess = spawn('flock', [lockPath, 'sleep', '7'], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 200)) // let the holder actually acquire first
      const r = await run(
        ['--model', 'test-model', '--caller', 'test-agent', 'hello'],
        baseEnv({ LOCAL_LLM_GPU_LOCK_PATH: lockPath }),
      )
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe('hi')
      const finishes = dashCalls.filter((c) => /\/api\/local-llm\/queue\/\d+\/(complete|fail)$/.test(c.path))
      expect(finishes[0]!.path).toMatch(/\/complete$/)
    } finally {
      holder.kill()
    }
  }, TEST_TIMEOUT_MS)
})
