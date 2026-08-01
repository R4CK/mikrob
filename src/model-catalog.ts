// The ONE source of the Claude model list and the weekly-tier ladder (card 5d2002b5, Peti redesign).
//
// Before this, the agent model-picker dropdown (src/web/routes/agents.ts) and the weekly-tier
// stepdown each carried their own hardcoded list, and the tier stepped every agent onto an ABSOLUTE
// chain index -- so a Haiku-based agent and an Opus-based agent both landed on `chain[1]`, ignoring
// where each STARTED. This module is the single list both features read, plus the capability-ordered
// ladder the stepdown walks, plus the pure per-agent target computation.
//
// Adding a model in ONE place (CLAUDE_MODELS, and its rung in MODEL_LADDER) surfaces it in the
// dropdown AND makes it a valid tier target automatically -- no second edit.

/** The Claude models an operator may assign, id + human label. The agent dropdown renders this
 *  verbatim; the ladder below ranks the ids. Display order here is operator-friendly (newest first);
 *  the *ladder* order is capability/price-descending and lives separately, on purpose. */
export const CLAUDE_MODELS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: 'claude-opus-5', label: 'Opus 5 (legújabb Opus)' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M kontextus)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (leggyorsabb)' },
]

/**
 * The tier ladder: capability/price DESCENDING. Stepping one tier down the weekly ramp moves an
 * agent one rung further along this list, starting from where its OWN base model sits. Defined
 * explicitly (not derived from the dropdown order) because "which model is a cheaper substitute for
 * which" is a judgement, not the display order -- but it is defined HERE, next to the list, so a new
 * model is ranked in the same edit that adds it.
 *
 * Opus 5 > Opus 4.8 (1M) > Sonnet 5 > Sonnet 4.6 > Haiku 4.5 > Fable 5.
 */
export const MODEL_LADDER: readonly string[] = [
  'claude-opus-5',
  'claude-opus-4-8[1m]',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-fable-5',
]

/** Every id the ladder knows, for validation. */
export function isLadderModel(model: string): boolean {
  return MODEL_LADDER.includes(model)
}

/**
 * The ladder position of a model. An UNRECOGNISED model (an OpenRouter id, a manual entry, a typo)
 * returns 0 -- the top rung -- so the stepdown treats it as a full-capability base and can only ever
 * move it DOWN from there, never silently promote it. Fail-safe: an unknown base never costs more.
 */
export function ladderIndexOf(model: string): number {
  const i = MODEL_LADDER.indexOf(model)
  return i < 0 ? 0 : i
}

/**
 * The model an agent should run at, given its BASE model and how many tiers down the weekly ramp
 * has pushed the fleet. PURE. `tier` is 0/1/2 from weeklyTierIndex.
 *
 *   target ladder index = ladderIndexOf(base) + tier, clamped to the ladder's end.
 *
 * So a Haiku-based agent at tier 1 stays on Haiku's neighbour (or Haiku itself, if it is already the
 * cheapest), while an Opus-based agent at tier 1 drops one rung from Opus -- each steps from its OWN
 * position, which is the bug this replaces (the old code used tier as an absolute index for everyone).
 */
export function weeklyTargetModel(baseModel: string, tier: number): string {
  const from = ladderIndexOf(baseModel)
  const steps = Number.isFinite(tier) && tier > 0 ? Math.floor(tier) : 0
  const target = Math.min(from + steps, MODEL_LADDER.length - 1)
  return MODEL_LADDER[target] ?? baseModel
}
