// Card f3f4b571 (F2): local-llm.sh gains a gateway mode -- route the generate call through the
// freellmapi custom provider (OpenAI-compatible /chat/completions) registered for the local
// Ollama, instead of calling Ollama's native /api/generate directly. OFF by default (switch
// file absent); F3 is the card that will actually flip it on in production routing.
//
// WHY THESE TESTS EXIST, SPECIFICALLY. Measured during development: the switch-read line itself
// (`GATEWAY_ENABLED="$([[ -f "$SWITCH" ]] && ...)"`) aborted the WHOLE script under this file's
// `set -e` the moment the switch file was ABSENT -- the common case, every call until F3 -- because
// a failed `[[ -f ]]` short-circuits the `&&` chain and that exit status propagates through the
// plain assignment. The already-existing normal-call-path test in
// local-llm-sh-generate-timeout-safety-net.test.ts caught this as a regression; the first test
// below pins it directly so it cannot silently come back.
import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'local-llm.sh')
const execFileP = promisify(execFile)

let servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))))
  servers = []
})

async function startServer(handler: RequestListener): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

function baseEnv(overrides: Record<string, string> = {}) {
  return {
    ...process.env,
    LOCAL_LLM_DASH_TOKEN_FILE: '/nonexistent-token-file-so-the-queue-path-is-skipped',
    LOCAL_LLM_GPU_LOCK_PATH: join(tmpdir(), `local-llm-gateway-test-${process.pid}-${Math.random()}.lock`),
    LOCAL_LLM_LOCK_WAIT: '10',
    LOCAL_LLM_TIMEOUT: '10',
    ...overrides,
  }
}

async function run(env: Record<string, string | undefined>, args: string[] = ['hello']) {
  try {
    const { stdout } = await execFileP('bash', [SCRIPT, '--model', 'test-model', '--caller', 'test-agent', ...args], {
      encoding: 'utf-8',
      env,
    })
    return { status: 0, stdout }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { status: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

describe('local-llm.sh gateway mode (card f3f4b571)', () => {
  it('OFF (no switch file, the default): does not abort the script -- the normal direct-Ollama call still completes', async () => {
    const ollamaPort = await startServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ models: [{ name: 'test-model' }] }))
        return
      }
      if (req.url === '/api/generate') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ response: 'direct-ollama-reply', eval_count: 3, prompt_eval_count: 2 }))
        return
      }
      res.writeHead(404); res.end()
    })
    const r = await run(baseEnv({ OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}` }))
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('direct-ollama-reply')
  })

  it('ON (switch file present, {"enabled":true}): routes through the gateway, not Ollama directly', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
    const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
    writeFileSync(switchFile, '{"enabled": true}')
    try {
      let ollamaHit = false
      const ollamaPort = await startServer((req, res) => {
        ollamaHit = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ response: 'should-not-be-used', eval_count: 1, prompt_eval_count: 1 }))
      })
      const gatewayPort = await startServer((req, res) => {
        if (req.url === '/chat/completions' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            choices: [{ message: { content: 'gateway-reply' } }],
            usage: { completion_tokens: 7, prompt_tokens: 4 },
          }))
          return
        }
        res.writeHead(404); res.end()
      })
      const tokenFile = join(tmpDir, 'auth-token')
      writeFileSync(tokenFile, 'test-token-value\n')

      const r = await run(baseEnv({
        OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
        LOCAL_LLM_GATEWAY_SWITCH: switchFile,
        LOCAL_LLM_GATEWAY_API_BASE: `http://127.0.0.1:${gatewayPort}`,
        LOCAL_LLM_GATEWAY_AUTH_TOKEN_FILE: tokenFile,
      }))
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe('gateway-reply')
      expect(ollamaHit).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ON but the auth token file is missing: fails closed (die 2), never calls the gateway or Ollama', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
    const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
    writeFileSync(switchFile, '{"enabled": true}')
    try {
      let gatewayHit = false
      const gatewayPort = await startServer((_req, res) => {
        gatewayHit = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: {} }))
      })
      const r = await run(baseEnv({
        OLLAMA_HOST: 'http://127.0.0.1:1',
        LOCAL_LLM_GATEWAY_SWITCH: switchFile,
        LOCAL_LLM_GATEWAY_API_BASE: `http://127.0.0.1:${gatewayPort}`,
        LOCAL_LLM_GATEWAY_AUTH_TOKEN_FILE: join(tmpDir, 'no-such-token-file'),
      }))
      expect(r.status).toBe(2)
      expect(gatewayHit).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ON with a malformed switch file ({"enabled": false}): stays OFF, routes direct to Ollama', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
    const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
    writeFileSync(switchFile, '{"enabled": false}')
    try {
      const ollamaPort = await startServer((req, res) => {
        if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ models: [{ name: 'test-model' }] }))
          return
        }
        if (req.url === '/api/generate') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ response: 'direct-reply', eval_count: 1, prompt_eval_count: 1 }))
          return
        }
        res.writeHead(404); res.end()
      })
      const r = await run(baseEnv({
        OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
        LOCAL_LLM_GATEWAY_SWITCH: switchFile,
      }))
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe('direct-reply')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
