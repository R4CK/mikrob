// Card 21fbc293 (Gemini-orch 2/4): the per-card local-LLM draft loop, driving the EXISTING
// offload-dispatch.sh engine in the order 1/4 proposed, with decision B's file-sink env var.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let killSwitchEnabled = false
let fallbackRoute: 'claude' | 'gemini' = 'claude'

vi.mock('../gemini-orchestrator.js', () => ({
  isGeminiOrchestratorEnabled: vi.fn(() => killSwitchEnabled),
  readFallbackRoute: vi.fn(() => fallbackRoute),
}))

let queueJson: string | null = null

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return {
    ...real,
    readFileSync: vi.fn((path: string, ...rest: unknown[]) => {
      const p = String(path)
      if (p.endsWith('gemini-orchestrator-queue.json')) {
        if (queueJson === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return queueJson
      }
      return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)
    }),
  }
})

import {
  readQueueOrder,
  runDraftForCard,
  runGeminiOrchestratorDraftSweep,
  runAsEntryPoint,
} from '../gemini-orchestrator-draft.js'

beforeEach(() => {
  killSwitchEnabled = false
  fallbackRoute = 'claude'
  queueJson = null
  vi.clearAllMocks()
})

// ── readQueueOrder: fail-closed on anything but a well-formed queue ─────────────────────────
describe('readQueueOrder() (card 21fbc293)', () => {
  it('returns null when the queue file does not exist', () => {
    queueJson = null
    expect(readQueueOrder()).toBeNull()
  })

  it('returns null on corrupt JSON', () => {
    queueJson = '{ not valid json'
    expect(readQueueOrder()).toBeNull()
  })

  it('returns null when "order" is missing', () => {
    queueJson = JSON.stringify({ decidedAt: 123 })
    expect(readQueueOrder()).toBeNull()
  })

  it('returns null when "order" is not an array of strings', () => {
    queueJson = JSON.stringify({ order: ['a', 2, 'c'], decidedAt: 123 })
    expect(readQueueOrder()).toBeNull()
  })

  it('returns null when "order" is not an array at all', () => {
    queueJson = JSON.stringify({ order: 'a,b,c', decidedAt: 123 })
    expect(readQueueOrder()).toBeNull()
  })

  it('returns null when "decidedAt" is missing or not a number', () => {
    queueJson = JSON.stringify({ order: ['a', 'b'] })
    expect(readQueueOrder()).toBeNull()
  })

  it('parses a well-formed queue', () => {
    queueJson = JSON.stringify({ order: ['cardA', 'cardB', 'cardC'], decidedAt: 999 })
    expect(readQueueOrder()).toEqual({ order: ['cardA', 'cardB', 'cardC'], decidedAt: 999 })
  })

  it('accepts an empty order array as well-formed (distinct from "no queue")', () => {
    queueJson = JSON.stringify({ order: [], decidedAt: 999 })
    expect(readQueueOrder()).toEqual({ order: [], decidedAt: 999 })
  })
})

// ── runDraftForCard: drives offload-dispatch.sh with the file-sink env var, fail-closed ─────
describe('runDraftForCard() (card 21fbc293, decision B)', () => {
  it('calls bash on offload-dispatch.sh with the card id as the sole argument', () => {
    const spawn = vi.fn((..._args: any[]) => ({ status: 0, error: undefined }) as any)
    runDraftForCard('cardXYZ', spawn)
    expect(spawn).toHaveBeenCalledTimes(1)
    const [cmd, args] = spawn.mock.calls[0] as [string, string[], unknown]
    expect(cmd).toBe('bash')
    expect(args[0]).toMatch(/offload-dispatch\.sh$/)
    expect(args[1]).toBe('cardXYZ')
  })

  it('sets OFFLOAD_DRAFT_SINK=file in the subprocess env (decision B)', () => {
    const spawn = vi.fn((..._args: any[]) => ({ status: 0, error: undefined }) as any)
    runDraftForCard('cardXYZ', spawn)
    const [, , opts] = spawn.mock.calls[0] as [string, string[], { env?: Record<string, string> }]
    expect(opts.env?.OFFLOAD_DRAFT_SINK).toBe('file')
  })

  it('sets a bounded timeout (fail-closed on a wedged subprocess)', () => {
    const spawn = vi.fn((..._args: any[]) => ({ status: 0, error: undefined }) as any)
    runDraftForCard('cardXYZ', spawn)
    const [, , opts] = spawn.mock.calls[0] as [string, string[], { timeout?: number }]
    expect(typeof opts.timeout).toBe('number')
    expect(opts.timeout).toBeGreaterThan(0)
  })

  it('reports ok:true on a clean exit 0', () => {
    const spawn = vi.fn(() => ({ status: 0, error: undefined }) as any)
    expect(runDraftForCard('cardXYZ', spawn)).toEqual({ id: 'cardXYZ', ok: true })
  })

  it('reports ok:false with a reason on a non-zero exit', () => {
    const spawn = vi.fn(() => ({ status: 1, error: undefined }) as any)
    const r = runDraftForCard('cardXYZ', spawn)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('exit_1')
  })

  it('reports ok:false on a timeout (status null)', () => {
    const spawn = vi.fn(() => ({ status: null, error: undefined }) as any)
    const r = runDraftForCard('cardXYZ', spawn)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('exit_null')
  })

  it('reports ok:false on a spawn error (e.g. ENOENT)', () => {
    const spawn = vi.fn(() => ({ status: null, error: new Error('spawn ENOENT') }) as any)
    const r = runDraftForCard('cardXYZ', spawn)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('ENOENT')
  })

  it('never throws, even on a spawn error', () => {
    const spawn = vi.fn(() => ({ status: null, error: new Error('boom') }) as any)
    expect(() => runDraftForCard('cardXYZ', spawn)).not.toThrow()
  })
})

// ── runGeminiOrchestratorDraftSweep: kill switch + route gated, drives the queue IN ORDER ───
describe('runGeminiOrchestratorDraftSweep() (card 21fbc293)', () => {
  it('kill switch OFF -> no-op, no queue read, no card driven', () => {
    killSwitchEnabled = false
    fallbackRoute = 'gemini'
    const readQueue = vi.fn(() => ({ order: ['a'], decidedAt: 1 }))
    const runOne = vi.fn((id: string) => ({ id, ok: true }))
    const summary = runGeminiOrchestratorDraftSweep(readQueue, runOne)
    expect(summary).toEqual({ ran: false, reason: 'kill_switch_off' })
    expect(readQueue).not.toHaveBeenCalled()
    expect(runOne).not.toHaveBeenCalled()
  })

  it('route is claude (not gemini) -> no-op even with kill switch ON', () => {
    killSwitchEnabled = true
    fallbackRoute = 'claude'
    const readQueue = vi.fn(() => ({ order: ['a'], decidedAt: 1 }))
    const runOne = vi.fn((id: string) => ({ id, ok: true }))
    const summary = runGeminiOrchestratorDraftSweep(readQueue, runOne)
    expect(summary).toEqual({ ran: false, reason: 'not_gemini_route' })
    expect(runOne).not.toHaveBeenCalled()
  })

  it('kill switch ON + route gemini, but no queue available -> no-op', () => {
    killSwitchEnabled = true
    fallbackRoute = 'gemini'
    const readQueue = vi.fn(() => null)
    const runOne = vi.fn((id: string) => ({ id, ok: true }))
    const summary = runGeminiOrchestratorDraftSweep(readQueue, runOne)
    expect(summary).toEqual({ ran: false, reason: 'no_queue' })
    expect(runOne).not.toHaveBeenCalled()
  })

  it('an empty order array -> no-op (nothing to drive, distinct reason from a missing queue)', () => {
    killSwitchEnabled = true
    fallbackRoute = 'gemini'
    const readQueue = vi.fn(() => ({ order: [], decidedAt: 1 }))
    const runOne = vi.fn((id: string) => ({ id, ok: true }))
    const summary = runGeminiOrchestratorDraftSweep(readQueue, runOne)
    expect(summary.ran).toBe(false)
    expect(runOne).not.toHaveBeenCalled()
  })

  it('kill switch ON + route gemini + a real queue -> drives every id IN ORDER', () => {
    killSwitchEnabled = true
    fallbackRoute = 'gemini'
    const readQueue = vi.fn(() => ({ order: ['cardC', 'cardA', 'cardB'], decidedAt: 1 }))
    const calledOrder: string[] = []
    const runOne = vi.fn((id: string) => {
      calledOrder.push(id)
      return { id, ok: true }
    })
    const summary = runGeminiOrchestratorDraftSweep(readQueue, runOne)
    expect(summary.ran).toBe(true)
    expect(calledOrder).toEqual(['cardC', 'cardA', 'cardB'])
    expect(summary.results).toHaveLength(3)
  })

  it('one failing card does not stop the sweep -- later ids still get driven', () => {
    killSwitchEnabled = true
    fallbackRoute = 'gemini'
    const readQueue = vi.fn(() => ({ order: ['cardA', 'cardB', 'cardC'], decidedAt: 1 }))
    const runOne = vi.fn((id: string) =>
      id === 'cardB' ? { id, ok: false, reason: 'exit_1' } : { id, ok: true },
    )
    const summary = runGeminiOrchestratorDraftSweep(readQueue, runOne)
    expect(runOne).toHaveBeenCalledTimes(3)
    expect(summary.results?.map((r) => r.id)).toEqual(['cardA', 'cardB', 'cardC'])
    expect(summary.results?.find((r) => r.id === 'cardB')?.ok).toBe(false)
    expect(summary.results?.find((r) => r.id === 'cardA')?.ok).toBe(true)
    expect(summary.results?.find((r) => r.id === 'cardC')?.ok).toBe(true)
  })
})

// ── runAsEntryPoint: never throws past its own try/catch, exits cleanly either way ──────────
describe('runAsEntryPoint() (card 21fbc293)', () => {
  it('exits 0 on a normal (even no-op) sweep', () => {
    killSwitchEnabled = false
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    runAsEntryPoint()
    expect(exitSpy).toHaveBeenCalledWith(0)
    exitSpy.mockRestore()
  })
})
