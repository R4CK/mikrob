// GET /api/local-llm/model-usage-buckets (card 2ffc0a96, Peti Telegram 2026-09-03): per-model
// swimlane rows + KPI tiles for the paired Fron Ted card d6ecb003. Peti's question behind it is
// "does the task-based routing actually spread work across the two models" -- so the numbers here
// are the answer to a question, not decoration, and a wrong one would be believed.
//
// These tests go through parseUsageRows on REAL ledger lines rather than hand-built objects: the
// contract's riskiest claims are about how the TSV is interpreted, and an object literal would
// simply assert my own assumptions back at me.
import { describe, it, expect } from 'vitest'
import { buildModelUsageSwimlane, parseUsageRows } from '../web/routes/local-llm.js'

/** A ledger line exactly as store/local-llm.sh log_usage writes it (10 columns). */
const line = (o: Partial<{
  ts: number; caller: string; task: string; model: string; ms: number; status: string; source: string
  evalTokens: number | string; promptTokens: number | string; evalDurationMs: number | string
}> = {}): string =>
  [
    o.ts ?? 1_788_000_000,
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

const MODEL_A = 'qwen2.5-coder:7b-instruct-q4_K_M'
const MODEL_B = 'hf.co/empero-ai/Qwen3.8-9B-Distill-GGUF:Q4_K_M'
const NOW_MS = 1_788_000_000_000
const FULL_TAIL = { oldestTs: null as number | null, capped: false }

const build = (lines: string[], tail = FULL_TAIL, hours = 6) =>
  buildModelUsageSwimlane(parseUsageRows(lines), NOW_MS, hours, tail)

/** Same, with an installed-model roster (card 21950f77). `null` -- the default above -- means
 *  "could not read the roster", which is NOT the same as an empty one. */
const buildWithRoster = (lines: string[], roster: readonly string[] | null, hours = 6) =>
  buildModelUsageSwimlane(parseUsageRows(lines), NOW_MS, hours, FULL_TAIL, roster)

describe('buildModelUsageSwimlane -- timestamp direction', () => {
  // THE defect this suite exists for. log_usage captures START_MS at entry and runs `date +%s` at
  // WRITE time, so column 1 is the COMPLETION second. A swimlane that treats it as the start
  // shifts every bar right by its own width -- and the live ledger already contains 86-second
  // rows, so the error is not subtle once it ships.
  it('derives startMs by subtracting the duration from the ledger timestamp', () => {
    const ts = NOW_MS / 1000 - 100 // 100s ago, comfortably inside the window
    const { models } = build([line({ ts, ms: 86_212 })])
    const [task] = models[0]!.tasks

    expect(task!.endMs).toBe(ts * 1000)
    expect(task!.startMs).toBe(ts * 1000 - 86_212)
    // Stated plainly so a refactor cannot "simplify" the two into one:
    expect(task!.endMs - task!.startMs).toBe(task!.durationMs)
  })

  it('places a long task EARLIER than a short one that finished at the same moment', () => {
    // The behavioural consequence of the rule above, independent of arithmetic:
    // two rows completing together did NOT start together.
    const ts = NOW_MS / 1000 - 100
    const { models } = build([
      line({ ts, ms: 60_000, task: 'long', model: MODEL_A }),
      line({ ts, ms: 1_000, task: 'short', model: MODEL_A }),
    ])
    const tasks = models[0]!.tasks
    const long = tasks.find((t) => t.task === 'long')!
    const short = tasks.find((t) => t.task === 'short')!
    expect(long.startMs).toBeLessThan(short.startMs)
  })
})

describe('buildModelUsageSwimlane -- tokens/s is null, never zero', () => {
  it('computes tokens/s from the CLEAN eval time, not the wall time', () => {
    // ms (wall) includes GPU-lock queueing; using it would understate throughput.
    const { models } = build([line({ ts: NOW_MS / 1000 - 10, ms: 60_000, evalTokens: 100, evalDurationMs: 5_000 })])
    expect(models[0]!.tasks[0]!.tokensPerSec).toBe(20) // 100 tokens / 5s, NOT 100/60s
  })

  it.each([
    ['an err row (no token columns)', { status: 'err', evalTokens: 0, evalDurationMs: 0 }],
    ['a busy row (GPU lock, no token columns)', { status: 'busy', evalTokens: 0, evalDurationMs: 0 }],
    ['a legacy row whose eval_duration is zero', { evalDurationMs: 0 }],
  ])('reports tokensPerSec = null for %s', (_label, over) => {
    const { models } = build([line({ ts: NOW_MS / 1000 - 10, ...over })])
    const task = models[0]!.tasks[0]!
    // null means "not measured". A 0 here would be drawn by the chart as a real
    // zero-throughput reading -- the same trap lastGenerationStats already avoids.
    expect(task.tokensPerSec).toBeNull()
    expect(task.tokensPerSec).not.toBe(0)
  })

  it('excludes unmeasured rows from the aggregate tokens/s instead of dragging it down', () => {
    const ts = NOW_MS / 1000 - 10
    const { kpi } = build([
      line({ ts, evalTokens: 100, evalDurationMs: 5_000 }),
      line({ ts, status: 'err', evalTokens: 0, evalDurationMs: 0 }),
    ])
    expect(kpi.tokensPerSec).toBe(20)
  })

  it('reports aggregate tokens/s as null when nothing in the window was measured', () => {
    const { kpi } = build([line({ ts: NOW_MS / 1000 - 10, status: 'err', evalTokens: 0, evalDurationMs: 0 })])
    expect(kpi.tokensPerSec).toBeNull()
  })
})

describe('buildModelUsageSwimlane -- busy is contention, not failure', () => {
  it('counts only err in errorRatePct and reports busy separately', () => {
    const ts = NOW_MS / 1000 - 10
    const { kpi } = build([
      line({ ts, status: 'ok' }),
      line({ ts, status: 'ok' }),
      line({ ts, status: 'err' }),
      line({ ts, status: 'busy' }),
    ])
    expect(kpi.totalRequests).toBe(4)
    expect(kpi.errorRatePct).toBe(25) // 1 err of 4 -- the busy row is NOT an error
    expect(kpi.busyCount).toBe(1)
  })
})

describe('buildModelUsageSwimlane -- which lanes exist', () => {
  it('omits a model with no rows and NO roster to vouch for it', () => {
    // Was "no empty lane, ever" (Peti, card comment 18771). Card 21950f77 reversed that for
    // models the roster knows about; with no roster there is still nothing to draw a lane FROM,
    // which is what this pins -- and it is the state the endpoint falls back to when ollama is
    // unreachable.
    const ts = NOW_MS / 1000 - 10
    const { models, kpi } = build([line({ ts, model: MODEL_A })])
    expect(models.map((m) => m.model)).toEqual([MODEL_A])
    expect(models.some((m) => m.model === MODEL_B)).toBe(false)
    expect(kpi.activeModels).toBe(1)
  })

  it('groups tasks under both models once both have traffic', () => {
    const ts = NOW_MS / 1000 - 10
    const { models, kpi } = build([
      line({ ts, model: MODEL_A }),
      line({ ts, model: MODEL_B, task: 'daily-log' }),
      line({ ts, model: MODEL_A }),
    ])
    expect(kpi.activeModels).toBe(2)
    // Busiest lane first, so the swimlane opens on the model doing the work.
    expect(models[0]!.model).toBe(MODEL_A)
    expect(models[0]!.tasks).toHaveLength(2)
    expect(models[1]!.tasks[0]!.task).toBe('daily-log')
  })

  it('drops dashboard UI probes so they never appear as fleet traffic', () => {
    const ts = NOW_MS / 1000 - 10
    const { models, kpi } = build([
      line({ ts, caller: 'ui-test' }),
      line({ ts, caller: 'backend' }),
    ])
    expect(kpi.totalRequests).toBe(1)
    expect(models[0]!.tasks[0]!.agent).toBe('backend')
  })

  it('keeps only rows inside the requested window', () => {
    const { kpi } = build([
      line({ ts: NOW_MS / 1000 - 60 }), // 1 min ago -- in
      line({ ts: NOW_MS / 1000 - 7 * 3600 }), // 7 h ago -- out of a 6 h window
      line({ ts: NOW_MS / 1000 + 600 }), // future clock skew -- out
    ])
    expect(kpi.totalRequests).toBe(1)
  })

  it('returns an empty, non-NaN payload for an empty window', () => {
    const { models, kpi } = build([])
    expect(models).toEqual([])
    expect(kpi.activeModels).toBe(0)
    expect(kpi.totalRequests).toBe(0)
    expect(kpi.avgLatencyMs).toBeNull()
    expect(kpi.tokensPerSec).toBeNull()
    expect(kpi.errorRatePct).toBe(0)
    // A NaN would serialise to null and read as "not measured" -- it is not.
    expect(Number.isNaN(kpi.errorRatePct)).toBe(false)
  })
})

describe('buildModelUsageSwimlane -- the installed-model roster (card 21950f77)', () => {
  const ts = NOW_MS / 1000 - 10

  it('draws a lane for an installed model with NO traffic, after the busy ones', () => {
    // Peti's actual complaint: in a window where only one model ran, the other one vanished, so
    // "idle" and "not installed at all" looked identical on screen.
    const { models } = buildWithRoster([line({ ts, model: MODEL_A })], [MODEL_A, MODEL_B])
    expect(models.map((m) => m.model)).toEqual([MODEL_A, MODEL_B])
    expect(models[1]!.tasks).toEqual([])
    expect(models[1]!.installed).toBe(true)
  })

  it('keeps every idle lane BELOW every busy lane, whatever the names sort like', () => {
    // 'aaa-idle' sorts before both busy models by name; it must still land last, or a roster of
    // idle models would push the real traffic off the first screen.
    const { models } = buildWithRoster(
      [line({ ts, model: MODEL_B }), line({ ts, model: MODEL_A }), line({ ts, model: MODEL_A })],
      ['aaa-idle:latest', MODEL_A],
    )
    expect(models.map((m) => m.model)).toEqual([MODEL_A, MODEL_B, 'aaa-idle:latest'])
    expect(models.map((m) => m.tasks.length)).toEqual([2, 1, 0])
  })

  it('marks a model that RAN here but is no longer installed', () => {
    const { models, rosterAvailable } = buildWithRoster([line({ ts, model: MODEL_B })], [MODEL_A])
    expect(rosterAvailable).toBe(true)
    const gone = models.find((m) => m.model === MODEL_B)!
    expect(gone.installed).toBe(false)
    expect(gone.tasks).toHaveLength(1)
  })

  it('says the roster is UNAVAILABLE rather than empty when it could not be read', () => {
    // The distinction the UI depends on. With ollama down every lane is installed:false, and a
    // UI that badged them all "no longer installed" would be stating what it could not look up.
    const { models, rosterAvailable } = buildWithRoster([line({ ts, model: MODEL_A })], null)
    expect(rosterAvailable).toBe(false)
    expect(models[0]!.installed).toBe(false)
  })

  it('matches the ledger name to the roster name CANONICALLY, so one model is one lane', () => {
    // The ledger carries whatever the caller typed; ollama always reports a resolved tag. Keyed
    // on the raw string these are two different models and the same one gets drawn twice.
    const { models } = buildWithRoster([line({ ts, model: 'qwen2.5-coder:latest' })], ['qwen2.5-coder'])
    expect(models).toHaveLength(1)
    expect(models[0]!.model).toBe('qwen2.5-coder:latest')
    expect(models[0]!.installed).toBe(true)
    expect(models[0]!.tasks).toHaveLength(1)
  })

  it('emits ONE lane for a roster that names the same model twice', () => {
    const { models } = buildWithRoster([], ['mistral', 'mistral:latest'])
    expect(models).toHaveLength(1)
  })

  it('keeps activeModels counting only models that actually ran', () => {
    // The KPI is labelled "Aktív modellek". Idle roster lanes must not inflate it.
    const { models, kpi } = buildWithRoster([line({ ts, model: MODEL_A })], [MODEL_A, MODEL_B, 'mistral'])
    expect(models).toHaveLength(3)
    expect(kpi.activeModels).toBe(1)
    expect(kpi.totalRequests).toBe(1)
  })
})

describe('buildModelUsageSwimlane -- task ids', () => {
  it('gives distinct ids to rows that share a second', () => {
    // Second-resolution timestamps collide constantly: the live ledger shows the
    // route-classify caller firing repeatedly within one second.
    const ts = NOW_MS / 1000 - 10
    const { models } = build([
      line({ ts, task: 'route-triage' }),
      line({ ts, task: 'route-triage' }),
      line({ ts, task: 'route-triage' }),
    ])
    const ids = models[0]!.tasks.map((t) => t.id)
    expect(new Set(ids).size).toBe(3)
  })
})

describe('buildModelUsageSwimlane -- truncated', () => {
  const ts = NOW_MS / 1000 - 10
  const recentOnly = [line({ ts })]

  it('is FALSE for a young ledger that simply has no older rows', () => {
    // The false positive worth naming: "my oldest row is newer than the window"
    // is the normal state of a fresh or freshly rotated ledger. Nothing is
    // missing, so claiming truncation would tell the FE to distrust a complete
    // answer.
    const out = build(recentOnly, { oldestTs: ts, capped: false })
    expect(out.truncated).toBe(false)
  })

  it('is TRUE only when the tail hit its cap AND stopped inside the window', () => {
    const out = build(recentOnly, { oldestTs: ts, capped: true })
    expect(out.truncated).toBe(true)
  })

  it('is FALSE when the capped tail still reaches back past the window start', () => {
    const out = build(recentOnly, { oldestTs: NOW_MS / 1000 - 10 * 3600, capped: true })
    expect(out.truncated).toBe(false)
  })
})

describe('buildModelUsageSwimlane -- the real ledger shape', () => {
  it('parses a verbatim live row into the contract fields', () => {
    // Copied from store/local-llm-usage.log (2026-09-03), only the timestamp
    // moved into the window: the column meanings are the contract's foundation,
    // so at least one case must be a line nobody in this repo wrote by hand.
    const ts = NOW_MS / 1000 - 200
    const live = `${ts}\tfron-ted\tsubtask-draft\t${MODEL_A}\t86212\tok\tadvisory\t649\t1770\t41293`
    const { models, kpi } = build([live])
    const task = models[0]!.tasks[0]!

    expect(task.agent).toBe('fron-ted')
    expect(task.task).toBe('subtask-draft')
    expect(task.source).toBe('advisory')
    expect(task.durationMs).toBe(86_212)
    expect(task.evalDurationMs).toBe(41_293)
    expect(task.tokensOut).toBe(649) // col 8 = eval_count
    expect(task.tokensIn).toBe(1_770) // col 9 = prompt_eval_count
    expect(task.tokensPerSec).toBe(15.7) // 649 / 41.293s
    expect(kpi.avgLatencyMs).toBe(86_212) // wall time, not eval time
  })
})
