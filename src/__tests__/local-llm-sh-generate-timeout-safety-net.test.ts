// Card cea524b1: two offload-dispatch calls held the GPU lock ("already in flight") for 20+
// minutes although the caller (route-classify.sh) wrapped the whole script in `timeout 45`.
//
// ROOT CAUSE, reproduced manually outside this suite (not committed as an automated test -- it
// needs a REAL external `timeout` binary process wrapping a REAL hung TCP connection, and the
// exact failure window is a genuine OS-level signal-delivery race, not a deterministic branch;
// unsuitable for CI). A bash process with an EXIT trap installed (the header-file cleanup trap,
// card 5dcd9bc8) that is blocked in a foreground command substitution ($(flock ... curl ...)) can
// fail to act on an external `timeout N`'s SIGTERM until the blocked grandchild finishes on its
// own. Verified directly: `timeout 3 bash outer.sh` (outer.sh: sets an EXIT trap, then blocks in
// `RESP=$(flock -w 600 lock curl -m 120 <hung-server>)`) did not stop the run at 3s -- it kept
// going. With that path defeated, the only real ceiling left was local-llm.sh's own GPU_LOCK_WAIT
// (600s) + TIMEOUT (120s) = up to 720s, not the caller's 45s.
//
// THE FIX (this file's subject): local-llm.sh now wraps its OWN flock+curl chain with an internal
// `timeout -k 5 <deadline>` -- a FRESH, non-bash process, unaffected by the calling bash's trap/
// wait state, so it enforces its deadline regardless of whether an external caller-side wrapper
// works. Verified directly: the same hung-server scenario, wrapped with `timeout -k 2 3 flock ...
// curl ...` with NO caller-side timeout at all, died at 3.1s with zero stragglers, repeatedly.
//
// WHAT THIS TEST CAN AND CANNOT PROVE. A real hung TCP connection (not a mocked Node http server)
// is what actually exercises the trap/wait race, and Node's `execFile` does not reproduce a bash
// script wrapped by an EXTERNAL `timeout` process either. What this test CAN prove, deterministically
// and fast: the documented invariant this card exists to guarantee -- LOCAL_LLM_LOCK_WAIT +
// LOCAL_LLM_TIMEOUT bounds the WHOLE call, including when the model server accepts the connection
// and then never responds -- still holds after the change, with no regression to the already-working
// normal-call path.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'local-llm.sh')
const execFileP = promisify(execFile)

let hangingServer: Server
let hangingPort: number

beforeAll(async () => {
  // Accepts the connection (so ollama_up()'s /api/tags health probe succeeds) but never responds
  // to /api/generate -- the exact shape of the reported incident (lock held, nothing ever replies).
  hangingServer = createServer((req, res) => {
    if (req.url === '/api/tags' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'test-model' }] }))
      return
    }
    // /api/generate: intentionally never respond, never end() -- connection just sits open.
  })
  await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', resolve))
  hangingPort = (hangingServer.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise((resolve) => hangingServer.close(resolve))
})

function baseEnv(overrides: Record<string, string> = {}) {
  return {
    ...process.env,
    OLLAMA_HOST: `http://127.0.0.1:${hangingPort}`,
    LOCAL_LLM_DASH_TOKEN_FILE: '/nonexistent-token-file-so-the-queue-path-is-skipped',
    ...overrides,
  }
}

async function run(env: Record<string, string | undefined>): Promise<{ status: number }> {
  try {
    await execFileP('bash', [SCRIPT, '--model', 'test-model', '--caller', 'test-agent', 'hello'], {
      encoding: 'utf-8',
      env,
    })
    return { status: 0 }
  } catch (e) {
    const err = e as { code?: number }
    return { status: err.code ?? -1 }
  }
}

describe('local-llm.sh generate-call timeout safety net (card cea524b1)', () => {
  it('a hung /api/generate call does not exceed LOCK_WAIT + TIMEOUT + a small buffer', async () => {
    const lockWait = 1
    const timeout = 1
    const start = Date.now()
    const r = await run(baseEnv({ LOCAL_LLM_LOCK_WAIT: String(lockWait), LOCAL_LLM_TIMEOUT: String(timeout) }))
    const elapsedMs = Date.now() - start

    expect(r.status).not.toBe(0)
    // Generous ceiling: (lockWait + timeout + 10s internal buffer + 5s kill-after grace) plus room
    // for process-spawn/CI slowness. The regression this guards against is a 720s+ hang, so even a
    // loose bound here catches it -- the point is "bounded", not "exactly N seconds".
    expect(elapsedMs, `took ${elapsedMs}ms, expected well under the old unbounded/720s+ ceiling`).toBeLessThan(
      (lockWait + timeout + 10 + 5 + 15) * 1000,
    )
  }, 40_000)

  // Card 8a6de2ee: this call goes through the real, shared, unparameterized global GPU lock
  // (baseEnv() never overrides LOCAL_LLM_GPU_LOCK_PATH here) with LOCAL_LLM_LOCK_WAIT=30 -- under
  // genuine fleet contention (another concurrent local-llm.sh call elsewhere holding that same
  // lock) this can legitimately take longer than vitest's default 5000ms while still finishing well
  // inside its own configured 30s patience. Same class of gap as
  // local-llm-sh-active-task-registration.test.ts's TEST_TIMEOUT_MS fix, applied here too.
  it('does not regress the already-working normal-call path (no hang, real response)', async () => {
    const okServer = createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ models: [{ name: 'test-model' }] }))
        return
      }
      if (req.url === '/api/generate') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ response: 'hi', eval_count: 1, prompt_eval_count: 1 }))
        return
      }
      res.writeHead(404); res.end()
    })
    await new Promise<void>((resolve) => okServer.listen(0, '127.0.0.1', resolve))
    const port = (okServer.address() as { port: number }).port
    try {
      const { stdout } = await execFileP(
        'bash',
        [SCRIPT, '--model', 'test-model', '--caller', 'test-agent', 'hello'],
        { encoding: 'utf-8', env: baseEnv({ OLLAMA_HOST: `http://127.0.0.1:${port}`, LOCAL_LLM_LOCK_WAIT: '30', LOCAL_LLM_TIMEOUT: '30' }) },
      )
      expect(stdout.trim()).toBe('hi')
    } finally {
      await new Promise((resolve) => okServer.close(resolve))
    }
  }, 35_000)

  it('GEN_CMD wraps the generate call with an internal `timeout -k`, guarded by `command -v`', () => {
    // Structural pin: proves the mechanism this card relies on is actually present in the script,
    // not just described in a comment. Complements the behavioural tests above.
    const src = readFileSync(SCRIPT, 'utf-8')
    expect(src).toMatch(/command -v timeout[^\n]*\n[^\n]*GEN_CMD=\(timeout -k 5/)
    expect(src).toMatch(/RESP=\$\("\$\{GEN_CMD\[@\]\}"/)
  })

  it('route-classify.sh passes a proportionate LOCAL_LLM_LOCK_WAIT/LOCAL_LLM_TIMEOUT, not the 720s default', () => {
    // The bounded-worst-case fix above still leaves local-llm.sh's own default ceiling (600+120=
    // 720s) far larger than route-classify.sh's advertised $TIMEOUT (45s default) -- this is what
    // let two calls hold the GPU lock for 20+ minutes in the reported incident. route-classify.sh
    // must scope its OWN calls to its OWN budget instead of relying on the 720s default.
    const routeClassifySrc = readFileSync(
      join(dirname(SCRIPT), 'route-classify.sh'),
      'utf-8',
    )
    expect(routeClassifySrc).toMatch(/LOCAL_LLM_LOCK_WAIT="\$HALF" LOCAL_LLM_TIMEOUT="\$HALF"/)
  })
})
