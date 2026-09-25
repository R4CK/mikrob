import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

// Card 6dc50a41 (fd2b2c4a chain): the legacy SDK-fallback path in agent.ts
// used to omit `options.env` entirely when the caller passed none, so the
// spawned `claude` child inherited the FULL parent process.env -- including
// the default (unset) CLAUDE_CONFIG_DIR, which resolves to ~/.claude with
// every globally enabled plugin (Telegram among them). That produced an
// orphan `bun server.ts` poller on the shared bot token (409 Conflict, see
// fd2b2c4a). We don't spawn a real `claude` binary here (unsafe, heavy) --
// instead we mock the SDK's `query()` and assert on the `options.env` it
// actually received, which is the exact seam the fix touches. A guaranteed
// plugin-free config dir is the structural proof that no server.ts poller
// can load, without spawning the real (unsafe-to-execute) binary.
let capturedOptions: any
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: any) => {
    capturedOptions = args.options
    return (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'ok' }
    })()
  }),
}))

import { runAgent } from '../agent.js'

const ISOLATED_DIR_CANDIDATES = [
  join(homedir(), '.claude', 'tmp', 'marveen-sdk-fallback-config'),
  join(tmpdir(), 'marveen-sdk-fallback-config'),
]

describe('runAgent legacy SDK-fallback path: CLAUDE_CONFIG_DIR isolation (card 6dc50a41)', () => {
  const prevBackend = process.env.MARVEEN_AGENT_BACKEND
  beforeEach(() => {
    // Skip the worker branch, exercise the legacy SDK path directly (this
    // IS the rollback route real callers hit whenever the worker's auth is
    // unrecoverable -- see runAgent's authFailed fallthrough).
    process.env.MARVEEN_AGENT_BACKEND = 'sdk'
    capturedOptions = undefined
  })
  afterEach(() => {
    if (prevBackend === undefined) delete process.env.MARVEEN_AGENT_BACKEND
    else process.env.MARVEEN_AGENT_BACKEND = prevBackend
  })

  it('a caller passing NO env still gets an isolated, plugin-free CLAUDE_CONFIG_DIR (not the real default)', async () => {
    await runAgent('hello')
    expect(capturedOptions.env).toBeDefined()
    const dir: string = capturedOptions.env.CLAUDE_CONFIG_DIR
    expect(dir).toBeTruthy()
    expect(ISOLATED_DIR_CANDIDATES).toContain(dir)
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'))
    expect(settings.enabledPlugins).toEqual({})
  })

  it('a caller-supplied CLAUDE_CONFIG_DIR (heartbeat.ts/memory.ts pattern) still wins over the default', async () => {
    const ownDir = join(tmpdir(), 'agent-sdk-isolation-test-own-config')
    await runAgent('hello', undefined, undefined, false, undefined, { CLAUDE_CONFIG_DIR: ownDir })
    expect(capturedOptions.env.CLAUDE_CONFIG_DIR).toBe(ownDir)
  })

  it('KNOWN-POSITIVE for the pin: the pre-fix options builder omitted env entirely for an unprotected caller', () => {
    const preFixOptionsBuilder = (env?: Record<string, string>) => ({
      ...(env ? { env: { ...process.env, ...env } } : {}),
    })
    // No `env` key at all -> the SDK falls back to its own default env
    // resolution, i.e. the full, unmodified process.env with whatever
    // (unset) CLAUDE_CONFIG_DIR that process happens to carry. This is the
    // exact shape llm-breakdown.ts / agent-scaffold.ts / schedules.ts /
    // the federation capability runner used to produce.
    expect(preFixOptionsBuilder(undefined)).toEqual({})
  })
})
