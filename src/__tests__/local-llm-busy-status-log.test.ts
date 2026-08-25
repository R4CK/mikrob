// store/local-llm.sh: log_usage records 'busy' (not 'err') when the GPU lock could not be
// acquired (card b8fff0fe, Cybersec finding on 71188a2a).
//
// WHY THIS MATTERS. flock -w N exits 1, and ONLY 1, exactly when it could not acquire the lock
// within the wait -- the local model never even started on this task, so it is GPU contention,
// not a generation failure. Before this fix log_usage wrote the same 'err' status either way, so
// the usage log itself could never answer "how often does contention happen", the exact question
// card 71188a2a asked and could not.
//
// END TO END, not source-level: the script is copied into a sandbox so `$HERE` -- and with it the
// usage log it appends to -- is isolated per test file (same pattern as
// local-llm-log-task-label.test.ts). The GPU lock path and wait are overridden via the script's own
// LOCAL_LLM_GPU_LOCK_PATH / LOCAL_LLM_LOCK_WAIT env vars so the test can force real contention (a
// background `flock` holding the same lock file) deterministically, in under a second rather than
// the real 600s default. spawnSync blocks this thread's event loop, so an in-process stub could not
// answer concurrently -- same reasoning as local-llm-log-task-label.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync, mkdtempSync, copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let sandbox: string
let server: ChildProcess
let host: string

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'llm-busy-'))
  copyFileSync(join(ROOT, 'store', 'local-llm.sh'), join(sandbox, 'local-llm.sh'))
  mkdirSync(join(sandbox, 'local-llm-skills'))
  writeFileSync(join(sandbox, 'local-llm-model'), 'stub-model:latest\n')

  // A real ollama server is needed for ollama_up()'s /api/tags check to pass BEFORE the generate
  // call is attempted -- the busy path is about losing the GPU-lock race, not about ollama being
  // unreachable, and those two failure modes must stay distinguishable. /api/tags always lists
  // stub-model, so a request naming the deliberately-unknown model still passes ollama_up() and
  // reaches the generate call -- which the stub then fails with a real HTTP error, the shape a
  // genuine ollama-side failure (not GPU contention) takes.
  const stub = join(sandbox, 'stub.js')
  writeFileSync(
    stub,
    `const http = require('node:http')
const s = http.createServer((req, res) => {
  if (req.url.startsWith('/api/tags')) {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ models: [{ name: 'stub-model:latest' }] }))
  }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (body.includes('does-not-exist')) {
      res.statusCode = 500
      res.end('stub: simulated ollama-side failure')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ response: 'drafted', eval_count: 7, prompt_eval_count: 3 }))
  })
})
s.listen(0, '127.0.0.1', () => console.log(String(s.address().port)))
`,
  )
  server = spawn('node', [stub], { stdio: ['ignore', 'pipe', 'inherit'] })
  host = await new Promise((resolve) => {
    server.stdout?.once('data', (d) => resolve(`http://127.0.0.1:${String(d).trim()}`))
  })
})

afterAll(() => { server?.kill() })

/** The last usage row as columns: epoch, caller, task, model, ms, status, source, in, out. */
function lastRow(logPath: string): string[] {
  if (!existsSync(logPath)) return []
  const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
  return lines[lines.length - 1]!.split('\t')
}

describe("local-llm.sh: gpu-lock contention logs status='busy', not 'err' (card b8fff0fe)", () => {
  it('a lock held by someone else for longer than the wait logs busy and exits 6', () => {
    const lockPath = join(sandbox, `gpu-${Date.now()}.lock`)
    // Hold the lock for 3s in a background process (spawn, not spawnSync -- a sync call would
    // block this thread until the holder exits, defeating the point). The script's own wait is
    // set to 1s below, so it must fail to acquire well before the holder releases it.
    const bgHolder = spawn('flock', [lockPath, 'sleep', '3'], { stdio: 'ignore' })
    try {
      // Give the holder a moment to actually acquire the lock before the script races it --
      // spawnSync of `sleep` blocks synchronously without a busy-wait loop.
      spawnSync('sleep', ['0.2'])

      const r = spawnSync(
        'bash',
        [join(sandbox, 'local-llm.sh'), '--caller', 'backend2', '--source', 'test', 'draft this'],
        {
          encoding: 'utf-8',
          timeout: 30_000,
          env: {
            ...process.env,
            OLLAMA_HOST: host,
            LOCAL_LLM_GPU_LOCK_PATH: lockPath,
            LOCAL_LLM_LOCK_WAIT: '1',
          },
        },
      )
      const row = lastRow(join(sandbox, 'local-llm-usage.log'))
      expect(r.status).toBe(6) // die 6 -- gpu lock busy
      expect(row[5]).toBe('busy') // column 6 (0-indexed 5): status
    } finally {
      bgHolder.kill()
    }
  })

  it('CONTROL: a real ollama-side failure (unknown model) still logs err, not busy', () => {
    const r = spawnSync(
      'bash',
      [join(sandbox, 'local-llm.sh'), '--model', 'does-not-exist:latest', 'draft this'],
      { encoding: 'utf-8', timeout: 30_000, env: { ...process.env, OLLAMA_HOST: host } },
    )
    expect(r.status).not.toBe(0)
    const row = lastRow(join(sandbox, 'local-llm-usage.log'))
    expect(row[5]).toBe('err')
  })
})
