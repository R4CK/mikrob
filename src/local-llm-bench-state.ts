// "Installed" and "measured on this hardware" are different claims about a local model.
//
// Card d730070e: the catalogue schema has carried `installedAt` and `benchmarkedAt` since it was
// written, and both were hardcoded to null -- the selftest even asserted they always would be. So
// the field existed, the state behind it did not, and the UI could not tell a model that has been
// benchmarked from one that was downloaded ten seconds ago. That matters because the card's point
// is precisely that "the download finished" is not evidence the model produces usable code.
//
// Two different sources, deliberately:
//   installedAt   -- ollama's own `modified_at` from /api/tags. No new writer, and it is right even
//                    for a model somebody pulled by hand outside any of our scripts.
//   benchmarkedAt -- store/local-llm-model-state.json, written by store/local-llm-bench.sh when a
//                    run actually succeeds. Nothing else may write it: a file that claims a
//                    measurement happened must only be touched by the thing that measures.
//
// NOT merged into `trusted`. That flag answers whether the PUBLISHER is on the reviewed list, and
// letting a successful benchmark flip it would mean an unreviewed publisher's model could turn
// "trusted" by being fast -- one flag answering two questions, which is the defect class this
// epic just spent a morning removing.
import { readFileSync } from 'node:fs'

export interface BenchRecord {
  /** ISO timestamp of the last successful benchmark run for this model. */
  benchmarkedAt: string
  /** Generation throughput measured then, tokens/sec. Null when the run reported none. */
  evalTps: number | null
  /** Context size the measurement was taken at -- a tok/s figure without it is not comparable. */
  ctx: number | null
  /** The run's --label, so a reader can find the row in the CSV output. */
  label: string | null
}

export type BenchState = Record<string, BenchRecord>

export function readBenchState(file: string): BenchState {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf-8')) as { models?: unknown }
    const models = doc?.models
    if (!models || typeof models !== 'object' || Array.isArray(models)) return {}
    const out: BenchState = {}
    for (const [name, raw] of Object.entries(models as Record<string, unknown>)) {
      const r = raw as Partial<BenchRecord>
      // A record without a timestamp is not a measurement, whatever else it carries.
      if (!r || typeof r.benchmarkedAt !== 'string' || !r.benchmarkedAt) continue
      out[name] = {
        benchmarkedAt: r.benchmarkedAt,
        evalTps: typeof r.evalTps === 'number' && Number.isFinite(r.evalTps) ? r.evalTps : null,
        ctx: typeof r.ctx === 'number' && Number.isFinite(r.ctx) ? r.ctx : null,
        label: typeof r.label === 'string' ? r.label : null,
      }
    }
    return out
  } catch {
    // No file yet (the normal case before anything has been benchmarked), or unreadable. Absence of
    // evidence is reported as "not benchmarked", never as benchmarked.
    return {}
  }
}

export interface BenchInfo {
  benchmarked: boolean
  benchmarkedAt: string | null
  evalTps: number | null
  benchCtx: number | null
}

export function benchInfoFor(state: BenchState, model: string): BenchInfo {
  const r = state[model]
  if (!r) return { benchmarked: false, benchmarkedAt: null, evalTps: null, benchCtx: null }
  return { benchmarked: true, benchmarkedAt: r.benchmarkedAt, evalTps: r.evalTps, benchCtx: r.ctx }
}
