// GET /api/local-llm/last-generation (card b21deb9a, Peti kep-melleklet 2026-08-21): dashboard row
// showing prompt/output tokens, tokens/s and VRAM for the most recent COMPLETED real generation --
// the equivalent of the LM Studio/llama.cpp console's
// "[generation: prompt=N tokens, output=M tokens, speed=X tokens/s]" + peak-VRAM lines, sourced
// from data local-llm.sh already writes into the usage ledger (column 10, eval_duration_ms) plus a
// live /api/ps VRAM lookup.
import { describe, it, expect } from 'vitest'
import { lastGenerationStats, parseUsageRows, type UsageRow } from '../web/routes/local-llm.js'

/** A ledger line exactly as store/local-llm.sh log_usage now writes it (10 columns). */
const line = (o: Partial<{
  ts: number; caller: string; task: string; model: string; ms: number; status: string; source: string
  evalTokens: number | string; promptTokens: number | string; evalDurationMs: number | string
}> = {}): string =>
  [
    o.ts ?? 1_785_000_000,
    o.caller ?? 'backend',
    o.task ?? 'code',
    o.model ?? 'qwen2.5-coder:7b-instruct-q4_K_M',
    o.ms ?? 1234,
    o.status ?? 'ok',
    o.source ?? 'bare',
    o.evalTokens ?? 47,
    o.promptTokens ?? 16,
    o.evalDurationMs ?? 4712,
  ].join('\t')

describe('parseUsageRows -- eval_duration column', () => {
  it('reads eval_duration_ms from column 10', () => {
    const [row] = parseUsageRows([line({ evalDurationMs: 5000 })])
    expect(row?.evalDurationMs).toBe(5000)
  })

  it('a 9-column row written before this card counts as 0 (speed unknown, never a guess)', () => {
    const legacy = [1_785_000_000, 'backend', 'code', 'm', 900, 'ok', 'bare', 47, 16].join('\t')
    const [row] = parseUsageRows([legacy])
    expect(row?.evalDurationMs).toBe(0)
  })
})

describe('lastGenerationStats', () => {
  it('derives tokens/s from eval_duration, NOT from wall-clock ms (which also counts GPU-lock wait)', () => {
    // 47 output tokens in 4712ms of Ollama-reported generation time = 9.97 tok/s, matching the
    // exact figure in Peti's reference screenshot -- but `ms` (wall time) is 30000, as it would be
    // if this call had queued behind the GPU lock for 25s first. Using `ms` here would report a
    // wildly wrong ~1.6 tok/s.
    const rows = parseUsageRows([line({ ms: 30000, evalTokens: 47, promptTokens: 16, evalDurationMs: 4712 })])
    const stats = lastGenerationStats(rows, null)
    expect(stats?.tokensPerSec).toBeCloseTo(9.975, 2)
    expect(stats?.promptTokens).toBe(16)
    expect(stats?.outputTokens).toBe(47)
  })

  it('reports tokensPerSec: null (not Infinity/NaN) when eval_duration is 0', () => {
    const rows = parseUsageRows([line({ evalDurationMs: 0 })])
    const stats = lastGenerationStats(rows, null)
    expect(stats?.tokensPerSec).toBeNull()
  })

  it('returns null when no real, completed generation has ever happened', () => {
    expect(lastGenerationStats([], null)).toBeNull()
    const onlyFailed = parseUsageRows([line({ status: 'err', evalTokens: 0 })])
    expect(lastGenerationStats(onlyFailed, null)).toBeNull()
    const onlyProbe = parseUsageRows([line({ caller: 'ui-test' })])
    expect(lastGenerationStats(onlyProbe, null)).toBeNull()
  })

  it('picks the NEWEST completed real call, skipping a later failed attempt', () => {
    const rows = parseUsageRows([
      line({ ts: 100, evalTokens: 10, promptTokens: 5, evalDurationMs: 1000 }),
      line({ ts: 200, status: 'err', evalTokens: 0 }),
    ])
    const stats = lastGenerationStats(rows, null)
    expect(stats?.ts).toBe(100)
    expect(stats?.outputTokens).toBe(10)
  })

  it('resolves VRAM from a live /api/ps model list, matching by name (bare or :tag form)', () => {
    const rows = parseUsageRows([line({ model: 'qwen2.5-coder:7b-instruct-q4_K_M' })])
    const ps = [{ name: 'qwen2.5-coder:7b-instruct-q4_K_M', size_vram: 4638040390 }]
    expect(lastGenerationStats(rows, ps)?.vramBytes).toBe(4638040390)
  })

  it('reports vramBytes: null when the model is not currently loaded or Ollama is unreachable', () => {
    const rows = parseUsageRows([line()])
    expect(lastGenerationStats(rows, [])?.vramBytes).toBeNull()
    expect(lastGenerationStats(rows, null)?.vramBytes).toBeNull()
  })
})
