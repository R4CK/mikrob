// Card 0291283d (Peti Telegram 14354): Ghost's local-LLM call path, off the Gemini budget.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let forcedExecResult: string | { status: number } | null = null
let forcedSpawnResult: { status: number | null } | null = null

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    execFileSync: vi.fn<(file: string, args?: readonly string[], options?: unknown) => string>(() => {
      if (forcedExecResult === null) throw new Error('forcedExecResult not set in test')
      if (typeof forcedExecResult === 'string') return forcedExecResult
      throw Object.assign(new Error(`exit ${forcedExecResult.status}`), forcedExecResult)
    }),
    spawnSync: vi.fn((...args: Parameters<typeof real.spawnSync>) => {
      if (forcedSpawnResult) return forcedSpawnResult as ReturnType<typeof real.spawnSync>
      return real.spawnSync(...args)
    }),
  }
})

import { callLocalLlmForGhost, alwaysAvailableSlot, recordLocalGhostCallDetail, GHOST_LOCAL_MODEL } from '../gemini-ghost-local.js'

beforeEach(() => {
  forcedExecResult = null
  forcedSpawnResult = null
})

describe('GHOST_LOCAL_MODEL', () => {
  it('defaults to the pinned Qwen3.5-9b-Sushi-Coder model (Peti Telegram 14354)', () => {
    expect(GHOST_LOCAL_MODEL).toBe('hf.co/bigatuna/Qwen3.5-9b-Sushi-Coder-RL-GGUF:Q4_K_M')
  })
})

describe('callLocalLlmForGhost()', () => {
  it('local-llm.sh succeeds with output: returns ok:true with the trimmed text', async () => {
    forcedExecResult = '  ["a","b"]  \n'
    const result = await callLocalLlmForGhost({ apiKey: null, prompt: 'order these' })
    expect(result).toEqual({ ok: true, text: '["a","b"]' })
  })

  it('local-llm.sh succeeds with EMPTY output: fails closed, never treated as success', async () => {
    forcedExecResult = '   \n'
    const result = await callLocalLlmForGhost({ apiKey: null, prompt: 'order these' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('bad_response')
  })

  it('local-llm.sh exits 6 (GPU lock busy): returns reason gpu_busy, not a Gemini-style failure', async () => {
    forcedExecResult = { status: 6 }
    const result = await callLocalLlmForGhost({ apiKey: null, prompt: 'order these' })
    expect(result).toEqual({ ok: false, reason: 'gpu_busy', detail: 'local-llm.sh GPU lock busy' })
  })

  it('local-llm.sh exits 3 (model missing): returns reason model_missing', async () => {
    forcedExecResult = { status: 3 }
    const result = await callLocalLlmForGhost({ apiKey: null, prompt: 'order these' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('model_missing')
  })

  it('local-llm.sh exits 2 (ollama down): returns reason network', async () => {
    forcedExecResult = { status: 2 }
    const result = await callLocalLlmForGhost({ apiKey: null, prompt: 'order these' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('network')
  })

  it('an unrecognized exit code still fails closed (bad_response), never thrown out of this function', async () => {
    forcedExecResult = { status: 99 }
    const result = await callLocalLlmForGhost({ apiKey: null, prompt: 'order these' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('bad_response')
  })

  it('passes --model with the pinned model and the prompt as the final argv', async () => {
    forcedExecResult = 'ok'
    await callLocalLlmForGhost({ apiKey: null, prompt: 'the actual prompt text' })
    const { execFileSync } = await import('node:child_process')
    const call = vi.mocked(execFileSync).mock.calls.at(-1)
    expect(String(call?.[0])).toContain('local-llm.sh')
    const argv = call?.[1] as string[]
    expect(argv[argv.indexOf('--model') + 1]).toBe(GHOST_LOCAL_MODEL)
    expect(argv.at(-1)).toBe('the actual prompt text')
  })
})

describe('alwaysAvailableSlot()', () => {
  it('is always true -- local calls are serialized by the GPU flock, not a Gemini budget', () => {
    expect(alwaysAvailableSlot()).toBe(true)
  })
})

describe('recordLocalGhostCallDetail()', () => {
  it('writes to llm_ledger with provider=local and returns true on success', async () => {
    forcedSpawnResult = { status: 0 }
    const ok = recordLocalGhostCallDetail('hivas1', 'card1', {
      model: GHOST_LOCAL_MODEL, durationMs: 1234, outcome: 'ok', taskType: 'ghost-rank',
    })
    expect(ok).toBe(true)
    const { spawnSync } = await import('node:child_process')
    const call = vi.mocked(spawnSync).mock.calls.at(-1)
    const argv = call?.[1] as string[]
    expect(argv.some((a) => a.includes('llm-ledger-append.py'))).toBe(true)
    expect(argv[argv.indexOf('--provider') + 1]).toBe('local')
    expect(argv[argv.indexOf('--model') + 1]).toBe(GHOST_LOCAL_MODEL)
    expect(argv).toContain('--ok')
  })

  it('a failing outcome passes --fail --fail-reason instead of --ok', async () => {
    forcedSpawnResult = { status: 0 }
    recordLocalGhostCallDetail('hivas2', 'card2', {
      model: GHOST_LOCAL_MODEL, durationMs: 50, outcome: 'error', taskType: 'ghost-review',
    })
    const { spawnSync } = await import('node:child_process')
    const argv = vi.mocked(spawnSync).mock.calls.at(-1)?.[1] as string[]
    expect(argv).toContain('--fail')
    expect(argv[argv.indexOf('--fail-reason') + 1]).toBe('error')
  })

  it('a non-zero exit from the ledger script returns false, never throws', () => {
    forcedSpawnResult = { status: 1 }
    const ok = recordLocalGhostCallDetail('hivas3', 'card3', {
      model: GHOST_LOCAL_MODEL, durationMs: 50, outcome: 'ok', taskType: 'ghost-rank',
    })
    expect(ok).toBe(false)
  })
})
