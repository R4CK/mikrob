// Per-model operator kill switch (card 5d151091, pair-FE 5dd4a211).
//
// Peti's ask: be able to turn OFF one local model by hand -- a model that misbehaves or eats more
// VRAM than the 6 GB card has -- without uninstalling it and without editing a script. The state
// lives in store/local-llm-model-disabled.json, written by the dashboard API and read back by BOTH
// consumers that can put a model in front of a caller: the HTTP routes (src/web/routes/local-llm.ts)
// and store/local-llm.sh, which is the last step of model selection for every shell caller.
//
// WHY A MAP AND NOT AN ARRAY. `disabledCategories` in local-llm-offload-active.json is a plain
// string array, and this is deliberately not the same shape: the FE contract carries `disabledAt`
// so the operator can see WHEN a model was switched off, and an array has nowhere to put it.
//
// FAIL DIRECTION. A missing file is the normal state (nothing has ever been disabled) and reads as
// "nothing disabled". A file that EXISTS but cannot be parsed is different in kind: it is a state we
// cannot determine, and answering "nothing disabled" there would silently re-enable a model the
// operator switched off -- the exact fail-open class this card names. So a malformed file THROWS,
// and each caller turns that into its own fail-closed answer (503 + a message naming the file on the
// HTTP side; "route this online" on the shell side). Nothing guesses.
import { readFileSync, existsSync } from 'node:fs'

/** name -> epoch-ms of when it was switched off. Keys are always CANONICAL (see below). */
export type DisabledModels = Map<string, number>

/**
 * Ollama reports every model with its tag resolved ("qwen2.5-coder" is listed as
 * "qwen2.5-coder:latest"), but the active-model file, a --model flag and the routing config all
 * carry whatever the operator typed. If the two halves of this feature keyed on the raw string, a
 * model disabled through the dashboard as "qwen2.5-coder:latest" would sail straight past a shell
 * caller that asked for "qwen2.5-coder" -- the switch would look applied and enforce nothing. One
 * canonical form, used for every key and every lookup on both sides, removes that gap.
 */
export function canonicalModelName(name: string): string {
  return name.includes(':') ? name : `${name}:latest`
}

/** Is this model switched off? Canonicalises the argument, so a tagless caller is answered right. */
export function isModelDisabled(models: DisabledModels, name: string): boolean {
  return models.has(canonicalModelName(name))
}

export class DisabledModelsUnreadableError extends Error {
  constructor(
    readonly file: string,
    readonly cause2: unknown,
  ) {
    super(`local-llm disabled-model state is unreadable: ${file}`)
    this.name = 'DisabledModelsUnreadableError'
  }
}

/**
 * Read the disabled-model state.
 *
 * @throws DisabledModelsUnreadableError when the file exists but is not a valid document. See the
 *         fail-direction note above: absent is "nothing disabled", corrupt is "unknown".
 */
export function readDisabledModels(file: string): DisabledModels {
  if (!existsSync(file)) return new Map()
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    throw new DisabledModelsUnreadableError(file, err)
  }
  const models = (doc as { disabledModels?: unknown } | null)?.disabledModels
  if (models === undefined) {
    // A document written by this module always carries the key. Its absence means someone put a
    // different document here, not that nothing is disabled.
    throw new DisabledModelsUnreadableError(file, new Error('missing "disabledModels" key'))
  }
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    throw new DisabledModelsUnreadableError(file, new Error('"disabledModels" is not an object'))
  }
  const out: DisabledModels = new Map()
  for (const [name, raw] of Object.entries(models as Record<string, unknown>)) {
    if (!name) continue
    const at = (raw as { disabledAt?: unknown } | null)?.disabledAt
    // A record with no usable timestamp still means DISABLED -- the switch is the fact, the
    // timestamp is decoration. Reporting 0 is honest ("unknown when"); dropping the entry would
    // silently re-enable the model.
    out.set(canonicalModelName(name), typeof at === 'number' && Number.isFinite(at) ? at : 0)
  }
  return out
}

/** Serialize back to the on-disk document (sorted keys: a stable file diffs cleanly). */
export function serializeDisabledModels(models: DisabledModels): string {
  const obj: Record<string, { disabledAt: number }> = {}
  for (const name of [...models.keys()].sort()) obj[name] = { disabledAt: models.get(name) ?? 0 }
  return JSON.stringify({ disabledModels: obj }, null, 2) + '\n'
}
