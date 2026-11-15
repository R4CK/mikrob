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

  it('ON (switch file present, {"enabled":true}): routes GENERATION through the gateway, not Ollama directly -- but still verifies the model against what Ollama has actually pulled (F1 fix, Cybersec MEDIUM, comment 29593)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
    const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
    writeFileSync(switchFile, '{"enabled": true}')
    try {
      let tagsHit = false
      let generateHit = false
      const ollamaPort = await startServer((req, res) => {
        if (req.url === '/api/tags') {
          tagsHit = true
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ models: [{ name: 'test-model' }] }))
          return
        }
        if (req.url === '/api/generate') {
          generateHit = true
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ response: 'should-not-be-used', eval_count: 1, prompt_eval_count: 1 }))
          return
        }
        res.writeHead(404); res.end()
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
      // The GUARANTEE this test pins: generation never bypasses the gateway by calling Ollama's
      // native /api/generate directly. A lightweight /api/tags verification call IS now expected
      // (the F1 fix below) -- that is not a bypass, it never runs the model.
      expect(generateHit).toBe(false)
      expect(tagsHit).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ON, --model is NOT one Ollama has pulled (e.g. a catalog/cloud id like "auto"): refuses before any gateway request (F1 fix, Cybersec MEDIUM, comment 29593 -- live-measured: gateway mode used to forward "auto" straight to freellmapi, which routed it to openrouter)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
    const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
    writeFileSync(switchFile, '{"enabled": true}')
    try {
      const ollamaPort = await startServer((req, res) => {
        if (req.url === '/api/tags') {
          // "auto" is deliberately absent -- only "test-model" (a DIFFERENT model than the one
          // requested below) is pulled.
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ models: [{ name: 'test-model' }] }))
          return
        }
        res.writeHead(404); res.end()
      })
      let gatewayHit = false
      const gatewayPort = await startServer((_req, res) => {
        gatewayHit = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'should-not-be-used' } }], usage: {} }))
      })
      const tokenFile = join(tmpDir, 'auth-token')
      writeFileSync(tokenFile, 'test-token-value\n')

      const r = await run(baseEnv({
        OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
        LOCAL_LLM_GATEWAY_SWITCH: switchFile,
        LOCAL_LLM_GATEWAY_API_BASE: `http://127.0.0.1:${gatewayPort}`,
        LOCAL_LLM_GATEWAY_AUTH_TOKEN_FILE: tokenFile,
      }), ['--model', 'auto', 'hello'])
      expect(r.status).toBe(3)
      expect(gatewayHit).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ON, Ollama is unreachable: fails closed (die 2) rather than trusting an unverifiable model, never calls the gateway (F1 fix)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
    const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
    writeFileSync(switchFile, '{"enabled": true}')
    try {
      let gatewayHit = false
      const gatewayPort = await startServer((_req, res) => {
        gatewayHit = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'should-not-be-used' } }], usage: {} }))
      })
      const tokenFile = join(tmpDir, 'auth-token')
      writeFileSync(tokenFile, 'test-token-value\n')

      const r = await run(baseEnv({
        OLLAMA_HOST: 'http://127.0.0.1:1',
        LOCAL_LLM_GATEWAY_SWITCH: switchFile,
        LOCAL_LLM_GATEWAY_API_BASE: `http://127.0.0.1:${gatewayPort}`,
        LOCAL_LLM_GATEWAY_AUTH_TOKEN_FILE: tokenFile,
      }))
      expect(r.status).toBe(2)
      expect(gatewayHit).toBe(false)
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

  it('ON, Ollama has pulled a model whose name CONTAINS "auto" as a substring (e.g. "starcoder2-autocomplete"): requesting --model auto still refuses -- exact match, not substring (Cybersec GO 29776 F-A / Cybered NO-GO 29789 F-B, card cdde2666: the old `grep -q "${MODEL%%:*}"` check forwarded "auto" to the gateway under exactly this ordinary local-install shape, and freellmapi routes "auto" straight to a cloud provider)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
    const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
    writeFileSync(switchFile, '{"enabled": true}')
    try {
      const ollamaPort = await startServer((req, res) => {
        if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ models: [{ name: 'test-model' }, { name: 'starcoder2-autocomplete' }] }))
          return
        }
        res.writeHead(404); res.end()
      })
      let gatewayHit = false
      const gatewayPort = await startServer((_req, res) => {
        gatewayHit = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'should-not-be-used' } }], usage: {} }))
      })
      const tokenFile = join(tmpDir, 'auth-token')
      writeFileSync(tokenFile, 'test-token-value\n')

      const base = {
        OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
        LOCAL_LLM_GATEWAY_SWITCH: switchFile,
        LOCAL_LLM_GATEWAY_API_BASE: `http://127.0.0.1:${gatewayPort}`,
        LOCAL_LLM_GATEWAY_AUTH_TOKEN_FILE: tokenFile,
      }
      const rAuto = await run(baseEnv(base), ['--model', 'auto', 'hello'])
      expect(rAuto.status).toBe(3)
      const rAutoColon = await run(baseEnv(base), ['--model', 'auto:x', 'hello'])
      expect(rAutoColon.status).toBe(3)
      expect(gatewayHit).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ON, a pulled model name CONTAINS the requested canon as a substring (not equal to it): refuses -- exact set membership, not substring-of-pulled-name (card 9b25cc84 G2, Cybersec GO 29890: `canon in n` for each pulled n would wrongly accept this, only `canon in names` as a set does not)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
    const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
    writeFileSync(switchFile, '{"enabled": true}')
    try {
      const ollamaPort = await startServer((req, res) => {
        if (req.url === '/api/tags') {
          // "myqwen:latest" contains "qwen:latest" as a literal substring starting at index 2,
          // but is NOT equal to it -- a per-name substring test (`canon in n`) would match this;
          // exact set membership correctly does not, since "qwen:latest" was never pulled.
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ models: [{ name: 'myqwen:latest' }] }))
          return
        }
        res.writeHead(404); res.end()
      })
      let gatewayHit = false
      const gatewayPort = await startServer((_req, res) => {
        gatewayHit = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'should-not-be-used' } }], usage: {} }))
      })
      const tokenFile = join(tmpDir, 'auth-token')
      writeFileSync(tokenFile, 'test-token-value\n')

      const r = await run(baseEnv({
        OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
        LOCAL_LLM_GATEWAY_SWITCH: switchFile,
        LOCAL_LLM_GATEWAY_API_BASE: `http://127.0.0.1:${gatewayPort}`,
        LOCAL_LLM_GATEWAY_AUTH_TOKEN_FILE: tokenFile,
      }), ['--model', 'qwen', 'hello'])
      expect(r.status).toBe(3)
      expect(gatewayHit).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ON, the requested model name contains a character outside the safe set: refuses even when a pulled model is byte-identical to it (card 9b25cc84 G2, Cybersec GO 29890: the character whitelist is defense in depth independent of what Ollama happens to have pulled -- without it, this exact-match-on-an-unsafe-name would wrongly pass)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
    const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
    writeFileSync(switchFile, '{"enabled": true}')
    try {
      const ollamaPort = await startServer((req, res) => {
        if (req.url === '/api/tags') {
          // Pulled name is BYTE-IDENTICAL to the requested model below (including the unsafe
          // char) -- removing the character whitelist would make this an exact-match ACCEPT.
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ models: [{ name: 'qwen;rm:latest' }] }))
          return
        }
        res.writeHead(404); res.end()
      })
      let gatewayHit = false
      const gatewayPort = await startServer((_req, res) => {
        gatewayHit = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'should-not-be-used' } }], usage: {} }))
      })
      const tokenFile = join(tmpDir, 'auth-token')
      writeFileSync(tokenFile, 'test-token-value\n')

      const r = await run(baseEnv({
        OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
        LOCAL_LLM_GATEWAY_SWITCH: switchFile,
        LOCAL_LLM_GATEWAY_API_BASE: `http://127.0.0.1:${gatewayPort}`,
        LOCAL_LLM_GATEWAY_AUTH_TOKEN_FILE: tokenFile,
      }), ['--model', 'qwen;rm', 'hello'])
      expect(r.status).toBe(3)
      expect(gatewayHit).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // H3 (card 29ceef23, RedHat standing condition on Cybered GO 30273 / card 9b25cc84): a pulled
  // name that STARTS WITH the requested canon, but is not EQUAL to it, is a different mutant than
  // the substring-anywhere case above (`canon in n` vs `n.startswith(canon)`) -- "qwen:latest" is
  // a prefix of "qwen:latest-extra" even though it never appears anywhere else in that string, so
  // a prefix-membership check would wrongly accept it where the substring check above would not.
  it('ON, a pulled model name STARTS WITH the requested canon but is longer (not equal to it): refuses -- exact set membership, not prefix-of-pulled-name (H3)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
    const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
    writeFileSync(switchFile, '{"enabled": true}')
    try {
      const ollamaPort = await startServer((req, res) => {
        if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ models: [{ name: 'qwen:latest-extra' }] }))
          return
        }
        res.writeHead(404); res.end()
      })
      let gatewayHit = false
      const gatewayPort = await startServer((_req, res) => {
        gatewayHit = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'should-not-be-used' } }], usage: {} }))
      })
      const tokenFile = join(tmpDir, 'auth-token')
      writeFileSync(tokenFile, 'test-token-value\n')

      const r = await run(baseEnv({
        OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
        LOCAL_LLM_GATEWAY_SWITCH: switchFile,
        LOCAL_LLM_GATEWAY_API_BASE: `http://127.0.0.1:${gatewayPort}`,
        LOCAL_LLM_GATEWAY_AUTH_TOKEN_FILE: tokenFile,
      }), ['--model', 'qwen', 'hello'])
      expect(r.status).toBe(3)
      expect(gatewayHit).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // H6 (card 29ceef23, RedHat standing condition on Cybered GO 30273 / card 9b25cc84): model_pulled()
  // already fails CLOSED (`except Exception: sys.exit(1)`) on an unparseable /api/tags body -- this
  // test PINS that behaviour so a future regression (e.g. flipping that handler to exit 0) is
  // caught; nothing in this file exercised a malformed-body response before. ollama_up() only
  // checks curl's transport success, not the body, so a 200 with garbage JSON still passes it and
  // reaches model_pulled(), exactly the path a real Ollama returning a truncated/corrupt response
  // would take.
  it('ON, /api/tags returns a 200 with an UNPARSEABLE (non-JSON) body: refuses (fails closed), never calls the gateway (H6)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
    const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
    writeFileSync(switchFile, '{"enabled": true}')
    try {
      const ollamaPort = await startServer((req, res) => {
        if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{not valid json at all')
          return
        }
        res.writeHead(404); res.end()
      })
      let gatewayHit = false
      const gatewayPort = await startServer((_req, res) => {
        gatewayHit = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'should-not-be-used' } }], usage: {} }))
      })
      const tokenFile = join(tmpDir, 'auth-token')
      writeFileSync(tokenFile, 'test-token-value\n')

      const r = await run(baseEnv({
        OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
        LOCAL_LLM_GATEWAY_SWITCH: switchFile,
        LOCAL_LLM_GATEWAY_API_BASE: `http://127.0.0.1:${gatewayPort}`,
        LOCAL_LLM_GATEWAY_AUTH_TOKEN_FILE: tokenFile,
      }), ['--model', 'test-model', 'hello'])
      expect(r.status).toBe(3)
      expect(gatewayHit).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // card 29ceef23 (RedHat standing condition on Cybered GO 30273 / card 9b25cc84): the G3 gap --
  // a pulled model literally named like a needsKey catalog id (qwen3-coder, command-r) or
  // freellmapi's own virtual-model strings (auto, auto:*, fusion, fusion:*) passes model_pulled
  // and used to go to the gateway VERBATIM, where freellmapi's router could resolve it as
  // something other than our own Ollama -- is now closed STRUCTURALLY: every gateway request's
  // wire "model" field is prefixed "custom:" (freellmapi's own endpoint-qualified-id syntax),
  // which neither isAutoModel/isFusionModel nor any catalog platform id can match, live-verified
  // against the running freellmapi (X-Routed-Via header) in the REVIEW/DECISIONS. This covers
  // every possible collision, not a named few, including names no one has thought to deny yet.
  // 'fusion:chain' added per QA FAIL 30293: freellmapi's isFusionModel (fusion.ts:30-33) is the
  // SAME lower === 'fusion' || lower.startswith('fusion:') shape as isAutoModel -- the round-1
  // denylist added an explicit auto: prefix rule but not the symmetric fusion: one, so a pulled
  // model literally named "fusion:chain" passed unrefused. The custom: prefix fix in this round
  // closes it structurally (neither check can match "custom:fusion:chain"), and this case is
  // included explicitly so the test suite proves it, not just implies it.
  it.each(['auto', 'auto:chain', 'fusion', 'fusion:chain', 'qwen3-coder', 'command-r', 'command-a', 'mistral-nemo'])(
    'every gateway request for %s is forwarded with the wire model id prefixed "custom:" (card 29ceef23)',
    async (collisionName) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
      const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
      writeFileSync(switchFile, '{"enabled": true}')
      try {
        const ollamaPort = await startServer((req, res) => {
          if (req.url === '/api/tags') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ models: [{ name: collisionName }] }))
            return
          }
          res.writeHead(404); res.end()
        })
        let forwardedModel: unknown
        const gatewayPort = await startServer((req, res) => {
          let body = ''
          req.on('data', (c) => { body += c })
          req.on('end', () => {
            forwardedModel = JSON.parse(body).model
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ choices: [{ message: { content: 'gateway-reply' } }], usage: {} }))
          })
        })
        const tokenFile = join(tmpDir, 'auth-token')
        writeFileSync(tokenFile, 'test-token-value\n')

        const r = await run(baseEnv({
          OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
          LOCAL_LLM_GATEWAY_SWITCH: switchFile,
          LOCAL_LLM_GATEWAY_API_BASE: `http://127.0.0.1:${gatewayPort}`,
          LOCAL_LLM_GATEWAY_AUTH_TOKEN_FILE: tokenFile,
        }), ['--model', collisionName, 'hello'])
        expect(r.status).toBe(0)
        expect(forwardedModel).toBe(`custom:${collisionName}`)
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )

  // Case-fold pin (MikroB dispatch msg 17997, after QA FAIL 30293): freellmapi's own
  // isAutoModel/isFusionModel lower-case the string before comparing, so "Auto" and "FUSION" are
  // ALSO virtual-model strings there, not just the exact-lowercase spelling. The custom: prefix
  // closes this the same way it closes everything else -- "custom:Auto" cannot match either
  // check regardless of what case the suffix is in -- but pinning it explicitly proves that
  // rather than leaving it implied.
  it.each(['Auto', 'FUSION', 'Qwen3-Coder'])(
    'mixed-case collision name %s is forwarded with the custom: prefix, case preserved (card 29ceef23)',
    async (mixedCaseName) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
      const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
      writeFileSync(switchFile, '{"enabled": true}')
      try {
        const ollamaPort = await startServer((req, res) => {
          if (req.url === '/api/tags') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ models: [{ name: mixedCaseName }] }))
            return
          }
          res.writeHead(404); res.end()
        })
        let forwardedModel: unknown
        const gatewayPort = await startServer((req, res) => {
          let body = ''
          req.on('data', (c) => { body += c })
          req.on('end', () => {
            forwardedModel = JSON.parse(body).model
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ choices: [{ message: { content: 'gateway-reply' } }], usage: {} }))
          })
        })
        const tokenFile = join(tmpDir, 'auth-token')
        writeFileSync(tokenFile, 'test-token-value\n')

        const r = await run(baseEnv({
          OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
          LOCAL_LLM_GATEWAY_SWITCH: switchFile,
          LOCAL_LLM_GATEWAY_API_BASE: `http://127.0.0.1:${gatewayPort}`,
          LOCAL_LLM_GATEWAY_AUTH_TOKEN_FILE: tokenFile,
        }), ['--model', mixedCaseName, 'hello'])
        expect(r.status).toBe(0)
        expect(forwardedModel).toBe(`custom:${mixedCaseName}`)
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )

  it('a model name that merely CONTAINS "qwen3-coder" (not equal to it) is still forwarded with the custom: prefix (card 29ceef23)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
    const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
    writeFileSync(switchFile, '{"enabled": true}')
    try {
      const ollamaPort = await startServer((req, res) => {
        if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ models: [{ name: 'myqwen3-coder-finetune:latest' }] }))
          return
        }
        res.writeHead(404); res.end()
      })
      let forwardedModel: unknown
      const gatewayPort = await startServer((req, res) => {
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => {
          forwardedModel = JSON.parse(body).model
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: 'gateway-reply' } }], usage: {} }))
        })
      })
      const tokenFile = join(tmpDir, 'auth-token')
      writeFileSync(tokenFile, 'test-token-value\n')

      const r = await run(baseEnv({
        OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
        LOCAL_LLM_GATEWAY_SWITCH: switchFile,
        LOCAL_LLM_GATEWAY_API_BASE: `http://127.0.0.1:${gatewayPort}`,
        LOCAL_LLM_GATEWAY_AUTH_TOKEN_FILE: tokenFile,
      }), ['--model', 'myqwen3-coder-finetune', 'hello'])
      expect(r.status).toBe(0)
      expect(forwardedModel).toBe('custom:myqwen3-coder-finetune')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ON, --model is empty or a bare "." : refuses before any gateway request, even though both used to match every /api/tags response as a substring needle', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'local-llm-gateway-'))
    const switchFile = join(tmpDir, 'local-llm-gateway-enabled.json')
    writeFileSync(switchFile, '{"enabled": true}')
    try {
      const ollamaPort = await startServer((req, res) => {
        if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ models: [{ name: 'test-model' }] }))
          return
        }
        res.writeHead(404); res.end()
      })
      let gatewayHit = false
      const gatewayPort = await startServer((_req, res) => {
        gatewayHit = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'should-not-be-used' } }], usage: {} }))
      })
      const tokenFile = join(tmpDir, 'auth-token')
      writeFileSync(tokenFile, 'test-token-value\n')

      const base = {
        OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
        LOCAL_LLM_GATEWAY_SWITCH: switchFile,
        LOCAL_LLM_GATEWAY_API_BASE: `http://127.0.0.1:${gatewayPort}`,
        LOCAL_LLM_GATEWAY_AUTH_TOKEN_FILE: tokenFile,
      }
      const rDot = await run(baseEnv(base), ['--model', '.', 'hello'])
      expect(rDot.status).toBe(3)
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

  it('the default gateway base is pinned static text, not left to drift unnoticed (Cybered NO-GO 29789 F-B, mutant G5: every other test here overrides LOCAL_LLM_GATEWAY_API_BASE, so a changed default was caught by nothing)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(SCRIPT, 'utf-8')
    expect(src).toContain('GATEWAY_API_BASE="${LOCAL_LLM_GATEWAY_API_BASE:-http://127.0.0.1:3001/v1}"')
  })
})
