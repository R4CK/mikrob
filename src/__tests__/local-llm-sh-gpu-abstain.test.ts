// Card ea931c14 (plan-grilling requirement 2, MikroB komment 14138): GPU-lock contention must not
// count as a used attempt. This proves the FIRST half live -- local-llm.sh exits with the new,
// distinct code 6 when it cannot acquire the GPU flock within GPU_LOCK_WAIT, not the generic "api
// error" code 5 a real generation failure gets. (The second half -- local-llm-worker.sh routing
// exit 6 to /abstain instead of /fail, and the queue reverting the attempt -- is covered by
// local-llm-queue.test.ts's abstain() suite; drain_one() itself is a thin, directly-readable branch
// with no independent test harness in this repo for local-llm-worker.sh, matching its siblings.)
//
// Real flock, throwaway lock file -- NEVER the production GPU_LOCK path (same discipline as
// local-llm-gpu-lock-probe.test.ts). LOCAL_LLM_GPU_LOCK_PATH (added by this card) is what makes
// that possible: local-llm.sh's GPU_LOCK was previously hardcoded to /tmp/local-llm-gpu.lock.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'local-llm.sh')
const execFileP = promisify(execFile)

let server: Server
let port: number

beforeAll(async () => {
  // /api/tags always answers (so ollama_up() and the "model missing?" check both succeed) with
  // `test-model` present. /api/generate answers a fast, real HTTP error -- a genuine call failure,
  // never a hang, so the CONTROL test below is fast and its exit code is unambiguous.
  server = createServer((req, res) => {
    if (req.url === '/api/tags' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'test-model' }] }))
      return
    }
    res.writeHead(500)
    res.end('boom')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

let dir: string
let holder: ChildProcess | null = null

function killHolder(): void {
  if (!holder || holder.pid == null) return
  // Same reasoning as local-llm-gpu-lock-probe.test.ts: `flock <path> -c cmd` forks a /bin/sh -c
  // child that inherits the locked fd, so only killing the flock PID would leave the lock held.
  try {
    process.kill(-holder.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
  holder = null
}

afterEach(() => {
  killHolder()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function holdLockInBackground(lockPath: string, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    holder = spawn('flock', [lockPath, '-c', `echo locked && sleep ${seconds}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    })
    holder.stdout!.once('data', () => resolve())
    holder.once('error', reject)
    setTimeout(() => reject(new Error('flock holder did not report locked in time')), 3000)
  })
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

function baseEnv(lockPath: string, overrides: Record<string, string> = {}) {
  return {
    ...process.env,
    OLLAMA_HOST: `http://127.0.0.1:${port}`,
    LOCAL_LLM_DASH_TOKEN_FILE: '/nonexistent-token-file-so-the-queue-path-is-skipped',
    LOCAL_LLM_GPU_LOCK_PATH: lockPath,
    LOCAL_LLM_LOCK_WAIT: '1',
    LOCAL_LLM_TIMEOUT: '5',
    ...overrides,
  }
}

describe('local-llm.sh GPU-lock-busy exit code (card ea931c14)', () => {
  it('exits 6 (not the generic 5) when the flock cannot be acquired within GPU_LOCK_WAIT', async () => {
    dir = mkdtempSync(join(tmpdir(), 'local-llm-abstain-'))
    const lockPath = join(dir, 'gpu.lock')
    // Hold the lock for well longer than the script's own 1s wait budget below.
    await holdLockInBackground(lockPath, 5)

    const r = await run(baseEnv(lockPath))
    expect(r.status).toBe(6)
  })

  it('CONTROL: an unheld lock does not trip exit 6 -- a real call failure still lands on the generic error code 5', async () => {
    dir = mkdtempSync(join(tmpdir(), 'local-llm-abstain-control-'))
    const lockPath = join(dir, 'gpu.lock')
    // Nobody holds this lock, so flock acquires immediately and curl itself fails against the
    // server's 500 -- this must land on 5 (real error), never 6, proving exit 6 is specific to
    // lock contention and not a generic wrapper-command failure.
    const r = await run(baseEnv(lockPath))
    expect(r.status).toBe(5)
  })
})
