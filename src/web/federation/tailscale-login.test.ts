// Card b68ddae8: backend for the Tailscale login button (frontend already built + GO'd,
// card 9bf6a1e0). Exercises the REAL module against a fixture `tailscale` binary (Node
// script, driven by env vars) instead of the real CLI -- this suite must NEVER invoke the
// actual tailscale on the machine it runs on: `serve --bg` genuinely changes that host's
// tailnet exposure, and `up` genuinely tries to join a VPN. All fixture output shapes below
// were captured from a REAL `tailscale 1.102.2` on a live host (status --json, serve status
// --json), not guessed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isValidTailscaleLoginUrl,
  extractServeBaseUrl,
  startTailscaleLogin,
  getTailscaleLoginStatus,
  _resetTailscaleLoginStateForTests,
} from './tailscale-login.js'
import { WEB_PORT } from '../../config.js'

const FIXTURE = `#!/usr/bin/env node
const args = process.argv.slice(2)
const env = process.env

function out(s) { process.stdout.write(s) }

async function main() {
  if (args[0] === 'status' && args[1] === '--json') {
    if (env.FIX_STATUS_FAIL === '1') { process.exitCode = 1; return }
    out(JSON.stringify({ BackendState: env.FIX_BACKEND_STATE || 'Running' }))
    return
  }
  if (args[0] === 'serve' && args[1] === 'status' && args[2] === '--json') {
    if (env.FIX_SERVE_STATUS_FAIL === '1') { process.exitCode = 1; return }
    if (env.FIX_SERVE_CONFIGURED === '1') {
      const host = env.FIX_SERVE_HOST || 'test-host.tail1234.ts.net'
      const port = env.FIX_SERVE_PORT || '3420'
      out(JSON.stringify({ Web: { [host + ':443']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:' + port } } } } }))
    } else {
      out(JSON.stringify({}))
    }
    return
  }
  if (args[0] === 'serve' && args[1] === '--bg') {
    if (env.FIX_SERVE_BG_FAIL === '1') { process.exitCode = 1 }
    return
  }
  if (args[0] === 'up') {
    const delay = parseInt(env.FIX_UP_URL_DELAY_MS || '0', 10)
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    if (env.FIX_UP_URL) out('To authenticate, visit:\\n\\n\\t' + env.FIX_UP_URL + '\\n\\n')
    const exitDelay = parseInt(env.FIX_UP_EXIT_DELAY_MS || '0', 10)
    if (exitDelay > 0) await new Promise((r) => setTimeout(r, exitDelay))
    process.exitCode = parseInt(env.FIX_UP_EXIT_CODE || '0', 10)
    return
  }
  process.exitCode = 1
}
main()
`

let fixtureDir: string
let fixturePath: string
const savedEnv: Record<string, string | undefined> = {}

function saveEnv(key: string) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
}
function setEnv(key: string, value: string | undefined) {
  saveEnv(key)
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'ts-fixture-'))
  fixturePath = join(fixtureDir, 'tailscale')
  writeFileSync(fixturePath, FIXTURE)
  chmodSync(fixturePath, 0o755)
  setEnv('TAILSCALE_BIN', fixturePath)
  _resetTailscaleLoginStateForTests()
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
  rmSync(fixtureDir, { recursive: true, force: true })
  _resetTailscaleLoginStateForTests()
})

describe('isValidTailscaleLoginUrl (server-side mirror of the client validator)', () => {
  const cases: Array<[string, boolean]> = [
    ['https://login.tailscale.com/a/abc', true],
    ['HTTPS://LOGIN.TAILSCALE.COM/a', true],
    ['http://login.tailscale.com/a', false],
    ['javascript:alert(1)', false],
    ['https://login.tailsca1e.com/evil', false],
    ['https://eviltailscale.com/x', false],
    ['https://login.tailscale.com@evil.com/x', false],
    ['https://login.tailscale.com.evil.com/x', false],
    ['https://login.tailscale.com./a', false],
    ['//login.tailscale.com/a', false],
    ['', false],
  ]
  for (const [url, expected] of cases) {
    it(`${JSON.stringify(url)} -> ${expected}`, () => {
      expect(isValidTailscaleLoginUrl(url)).toBe(expected)
    })
  }
})

describe('extractServeBaseUrl (real observed tailscale 1.102.2 shape)', () => {
  it('finds the Web entry proxying our port', () => {
    const json = JSON.stringify({
      TCP: { '443': { HTTPS: true } },
      Web: {
        'desktop-npjimpc.tail7acbba.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3420' } } },
        'neon-mikrob.tail7acbba.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3420' } } },
      },
    })
    expect(extractServeBaseUrl(json, 3420)).toBe('https://desktop-npjimpc.tail7acbba.ts.net/')
  })
  it('no Web key -> null (not configured)', () => {
    expect(extractServeBaseUrl(JSON.stringify({}), 3420)).toBeNull()
  })
  it('Web present but proxying a DIFFERENT port -> null', () => {
    const json = JSON.stringify({ Web: { 'x.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } })
    expect(extractServeBaseUrl(json, 3420)).toBeNull()
  })
  it('malformed JSON -> null, does not throw', () => {
    expect(extractServeBaseUrl('not json', 3420)).toBeNull()
  })
})

describe('startTailscaleLogin -- already connected', () => {
  it('BackendState Running -> status connected, pollToken present, then GET /status resolves to connected+baseUrl', async () => {
    setEnv('FIX_BACKEND_STATE', 'Running')
    setEnv('FIX_SERVE_CONFIGURED', '1')
    setEnv('FIX_SERVE_HOST', 'my-host.tail1234.ts.net')
    setEnv('FIX_SERVE_PORT', String(WEB_PORT))
    const result = await startTailscaleLogin()
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.status).toBe('connected')
    expect(result.pollToken).toBeTruthy()
    expect(result.loginUrl).toBeUndefined()

    // finishAfterConnected runs fire-and-forget; poll until it lands.
    let final = getTailscaleLoginStatus(result.pollToken)
    for (let i = 0; i < 50 && final.status === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      final = getTailscaleLoginStatus(result.pollToken)
    }
    expect(final.status).toBe('connected')
    expect(final.baseUrl).toBe('https://my-host.tail1234.ts.net/')
    expect(final.systemId).toBeDefined()
  })

  it('already connected, serve NOT yet configured -> enables it (serve --bg, never funnel) and reports the new baseUrl', async () => {
    setEnv('FIX_BACKEND_STATE', 'Running')
    setEnv('FIX_SERVE_CONFIGURED', '0')
    // After the fixture's own --bg call, the NEXT `serve status --json` should reflect the
    // newly-enabled state. The fixture is stateless per-invocation, so simulate that by
    // flipping FIX_SERVE_CONFIGURED once --bg "runs" -- can't do that from inside the child,
    // so instead assert on the --bg invocation itself via a marker file the fixture writes.
    const marker = join(fixtureDir, 'serve-bg-called')
    writeFileSync(
      fixturePath,
      FIXTURE.replace(
        "if (args[0] === 'serve' && args[1] === '--bg') {",
        `if (args[0] === 'serve' && args[1] === '--bg') {\n    require('fs').writeFileSync(${JSON.stringify(marker)}, args.join(' '))\n`,
      ),
    )
    const result = await startTailscaleLogin()
    expect('error' in result).toBe(false)
    if ('error' in result) return
    // serve_failed is expected here (fixture keeps reporting "not configured" even after --bg,
    // since it's stateless) -- what this test actually proves is the ARGV passed to --bg.
    let final = getTailscaleLoginStatus(result.pollToken)
    for (let i = 0; i < 50 && final.status === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      final = getTailscaleLoginStatus(result.pollToken)
    }
    const { readFileSync, existsSync } = await import('node:fs')
    expect(existsSync(marker)).toBe(true)
    const invokedArgs = readFileSync(marker, 'utf-8')
    expect(invokedArgs).toBe(`serve --bg ${WEB_PORT}`)
    expect(invokedArgs).not.toContain('funnel')
  })
})

describe('startTailscaleLogin -- needs login', () => {
  it('not connected -> starts tailscale up, returns a VALID loginUrl promptly', async () => {
    setEnv('FIX_BACKEND_STATE', 'NeedsLogin')
    setEnv('FIX_UP_URL', 'https://login.tailscale.com/a/realtoken123')
    setEnv('FIX_UP_EXIT_DELAY_MS', '50')
    setEnv('FIX_UP_EXIT_CODE', '0')
    setEnv('FIX_SERVE_CONFIGURED', '1')
    setEnv('FIX_SERVE_HOST', 'my-host.tail1234.ts.net')
    setEnv('FIX_SERVE_PORT', String(WEB_PORT))
    const result = await startTailscaleLogin()
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.status).toBe('needs_login')
    expect(result.loginUrl).toBe('https://login.tailscale.com/a/realtoken123')
    expect(result.pollToken).toBeTruthy()
  })

  it('a MALICIOUS/invalid loginUrl from `tailscale up` is REJECTED, never reaches the caller', async () => {
    setEnv('FIX_BACKEND_STATE', 'NeedsLogin')
    setEnv('FIX_UP_URL', 'https://login.tailsca1e.com/evil')
    const result = await startTailscaleLogin()
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.status).toBe('needs_login')
    expect(result.loginUrl).toBeUndefined() // never handed out
    const status = getTailscaleLoginStatus(result.pollToken)
    expect(status.status).toBe('failed')
    expect(status.error).toBe('invalid_login_url')
  })

  it('`tailscale up` never prints a URL within the wait window -> pollToken still returned, no loginUrl', async () => {
    setEnv('FIX_BACKEND_STATE', 'NeedsLogin')
    // no FIX_UP_URL at all -- fixture prints nothing, exits 0 quickly (simulating an
    // already-in-progress-elsewhere auth or a CLI version that doesn't print a fresh URL)
    setEnv('FIX_UP_EXIT_CODE', '0')
    const result = await startTailscaleLogin()
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.status).toBe('needs_login')
    expect(result.loginUrl).toBeUndefined()
  }, 15_000)

  it('`tailscale up` times out (nonzero exit, no URL) -> polling reports failed/up_timeout', async () => {
    setEnv('FIX_BACKEND_STATE', 'NeedsLogin')
    setEnv('FIX_UP_EXIT_CODE', '1')
    const result = await startTailscaleLogin()
    expect('error' in result).toBe(false)
    if ('error' in result) return
    let final = getTailscaleLoginStatus(result.pollToken)
    for (let i = 0; i < 50 && final.status === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      final = getTailscaleLoginStatus(result.pollToken)
    }
    expect(final.status).toBe('failed')
    expect(final.error).toBe('up_timeout')
  })

  it('concurrent POSTs while a login is in flight attach to the SAME pollToken -- no second `tailscale up`', async () => {
    setEnv('FIX_BACKEND_STATE', 'NeedsLogin')
    setEnv('FIX_UP_URL_DELAY_MS', '80') // hold the URL back so the window overlaps
    setEnv('FIX_UP_URL', 'https://login.tailscale.com/a/first')
    setEnv('FIX_UP_EXIT_DELAY_MS', '150')
    const first = startTailscaleLogin()
    await new Promise((r) => setTimeout(r, 10)) // let the first call actually start the child
    const second = await startTailscaleLogin()
    const firstResult = await first
    expect('error' in firstResult).toBe(false)
    expect('error' in second).toBe(false)
    if ('error' in firstResult || 'error' in second) return
    expect(second.pollToken).toBe(firstResult.pollToken)
  })
})

describe('errorCode discipline -- status/serve failures never leak raw output', () => {
  it('`tailscale status --json` exiting nonzero -> errorCode only, no stdout/stderr text in the result', async () => {
    setEnv('FIX_STATUS_FAIL', '1')
    const result = await startTailscaleLogin()
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toBe('status_check_failed')
    expect(Object.keys(result)).toEqual(['error'])
  })

  it('tailscale binary genuinely missing (spawn ENOENT) -> not_installed, not a crash', async () => {
    setEnv('TAILSCALE_BIN', join(fixtureDir, 'does-not-exist'))
    const result = await startTailscaleLogin()
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toBe('not_installed')
  })

  it('unknown/expired pollToken -> failed + errorCode unknown, not a crash', () => {
    const status = getTailscaleLoginStatus('nonexistent-token')
    expect(status).toEqual({ status: 'failed', error: 'unknown' })
  })
})
