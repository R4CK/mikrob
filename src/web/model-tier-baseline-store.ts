// Durable per-agent BASE model, for the weekly-tier stepdown (card 5d2002b5, Peti: "EZ A LEGFONTOSABB").
//
// The tier ramp steps each agent DOWN from its own base model, and reverts it back UP to that base
// once the weekly % falls. The base therefore has to OUTLIVE a dashboard restart: the previous
// design kept it only in the runner's in-memory `downgradedAt` map, so a restart mid-ramp lost every
// base -- and a stepped-down agent then reverted to the global chain[0], or got stuck on the cheap
// model, instead of climbing back to the model it actually started on.
//
// So the base is written HERE, to store/model-tier-baseline.json, the first time an agent is stepped
// down (its then-current model is, by definition, its base). Memory holds only the revert TIMING;
// the base is read from disk. A record is cleared when the agent is back on its base, so the file
// tracks exactly the currently-downgraded set.

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

const STORE_PATH = join(PROJECT_ROOT, 'store', 'model-tier-baseline.json')

/** agentId -> the model it ran on BEFORE the weekly ramp first stepped it down. */
type BaselineMap = Record<string, string>

function readAll(): BaselineMap {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: BaselineMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Only string ids survive: a corrupt entry must not become a base nobody ever ran.
      if (typeof v === 'string' && v.length > 0) out[k] = v
    }
    return out
  } catch {
    return {} // absent / unreadable / malformed -> no recorded bases, which is the safe empty state
  }
}

/** The recorded base for an agent, or null if it has never been stepped down (or is back on base). */
export function readBaselineModel(agent: string): string | null {
  return readAll()[agent] ?? null
}

/**
 * Record `model` as `agent`'s base, but ONLY if none is recorded yet. Idempotent by design: the base
 * is whatever the agent ran on the FIRST time it was stepped down, and a later step (tier 1 -> tier 2)
 * must not overwrite it with the already-cheaper current model.
 */
export function recordBaselineIfAbsent(agent: string, model: string): void {
  if (typeof model !== 'string' || model.length === 0) return
  const all = readAll()
  if (all[agent] !== undefined) return
  all[agent] = model
  atomicWriteFileSync(STORE_PATH, JSON.stringify(all, null, 2))
}

/** Drop an agent's recorded base -- called once it is back on that base (tier 0). */
export function clearBaseline(agent: string): void {
  const all = readAll()
  if (all[agent] === undefined) return
  delete all[agent]
  atomicWriteFileSync(STORE_PATH, JSON.stringify(all, null, 2))
}

/** The whole map, for the read-only dashboard display. */
export function readAllBaselines(): BaselineMap {
  return readAll()
}
