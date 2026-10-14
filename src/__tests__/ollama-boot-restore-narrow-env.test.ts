// Card 39b958a4 (Cybersec F2, GO b9a657e6 comment 5821; RedHat NO-GO F-RH3, comment 19024):
// runOllamaBootRestore() spawns ollama-boot-restore.sh, which detaches a long-lived `ollama serve`
// daemon via `setsid nohup`. That daemon inherits whatever env execFileSync hands the wrapping bash
// process -- passing the full inherited process.env (this dashboard process's own environment,
// including CLAUDE_CODE_MESSAGING_TOKEN) would put it in that daemon's /proc/<pid>/environ
// indefinitely.
//
// RedHat measured (19024) that the PREVIOUS version of this test was a source-grep, and that three
// distinct real-shaped mutants all pass it while still leaking the full environment:
//   E1: env: process.env                                          (full passthrough)
//   E2: builder is Object.assign({ PATH: ..., HOME: ... }, process.env)  (spreads AFTER narrowing)
//   E4: Object.assign({}, process.env, buildOllamaRestoreEnv())    (spreads BEFORE narrowing, at the
//       call site -- this is exactly the shape of the rejected local-llm draft, 17059/18969)
// A regex on the source text cannot tell these apart from the real fix, because the forbidden
// `...process.env` token is simply absent in E2/E4's own spelling. This version instead calls the
// REAL functions and inspects what execFileSync actually receives -- no source text is read.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET_ENV_KEYS = [
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'ANTHROPIC_API_KEY',
  'DASHBOARD_TOKEN',
  'TELEGRAM_BOT_TOKEN',
] as const

const h = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; options: unknown }>,
}))

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((file: string, args: string[], options: unknown) => {
    h.calls.push({ file, args, options })
    return ''
  }),
}))

describe('runOllamaBootRestore passes a narrow env, not the inherited process.env (card 39b958a4)', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    h.calls.length = 0
    process.env.PATH = '/usr/bin:/bin'
    process.env.HOME = '/home/neon'
    process.env.OLLAMA_HOST = 'http://127.0.0.1:11434'
    for (const key of SECRET_ENV_KEYS) process.env[key] = `FAKE-${key}-value`
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
    vi.resetModules()
  })

  it('buildOllamaRestoreEnv() returns EXACTLY PATH, HOME, OLLAMA_HOST -- no secret key leaks through', async () => {
    const { buildOllamaRestoreEnv } = await import('../web/channel-monitor.js')
    const env = buildOllamaRestoreEnv()
    expect(Object.keys(env).sort()).toEqual(['HOME', 'OLLAMA_HOST', 'PATH'])
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/home/neon')
    expect(env.OLLAMA_HOST).toBe('http://127.0.0.1:11434')
    for (const key of SECRET_ENV_KEYS) expect(env).not.toHaveProperty(key)
  })

  it('OLLAMA_HOST is omitted (not just blank) when unset in the environment', async () => {
    delete process.env.OLLAMA_HOST
    const { buildOllamaRestoreEnv } = await import('../web/channel-monitor.js')
    const env = buildOllamaRestoreEnv()
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH'])
  })

  it('runOllamaBootRestore() calls execFileSync with an env object carrying ONLY PATH/HOME/OLLAMA_HOST -- the actual call site, not just the builder in isolation', async () => {
    const { runOllamaBootRestore } = await import('../web/channel-monitor.js')
    runOllamaBootRestore()
    expect(h.calls).toHaveLength(1)
    const { file, args, options } = h.calls[0]
    expect(file).toBe('/bin/bash')
    expect(args).toHaveLength(1)
    expect(args[0]).toMatch(/ollama-boot-restore\.sh$/)
    const env = (options as { env?: NodeJS.ProcessEnv }).env
    expect(env, 'execFileSync must be called with an explicit env option').toBeDefined()
    expect(Object.keys(env as object).sort()).toEqual(['HOME', 'OLLAMA_HOST', 'PATH'])
    for (const key of SECRET_ENV_KEYS) expect(env).not.toHaveProperty(key)
  })
})
