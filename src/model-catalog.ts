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
 * Fable 5 > Opus 5 > Opus 4.8 (1M) > Sonnet 5 > Sonnet 4.6 > Haiku 4.5.
 *
 * CORRECTED 2026-08-02 (Peti caught it): Fable 5 was placed LAST here by a prior session with no
 * verified basis -- an unbenchmarked guess, likely from the name sounding lighter/creative-writing.
 * Anthropic's own pricing puts Fable 5 ABOVE Opus 5 ($10/$50 per MTok vs Opus 5's $5/$25) and
 * describes it as "Anthropic's most capable widely released model" -- i.e. the most expensive AND
 * most capable rung, not the cheapest. Moved to the front. Every relative step already tested
 * (Opus 5 -> Opus 4.8 -> Sonnet 5 -> Sonnet 4.6 -> Haiku 4.5) is unchanged; only Fable moved.
 *
 * Also implements Peti's stepping policy (2026-08-02): within one model FAMILY, step down VERSION
 * first (Opus 5 -> Opus 4.8) before jumping to a lower-capability family (-> Sonnet); only jump
 * families once the family has no lower version left on the ladder. See applyNoHaikuFloor below for
 * the companion rule: coding agents may never be stepped all the way down to Haiku.
 */
export const MODEL_LADDER: readonly string[] = [
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8[1m]',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]

/**
 * Agents whose job is primarily writing/reviewing code. Peti policy (2026-08-02): the weekly ramp
 * must never step one of these all the way down to Haiku 4.5 -- Haiku is not reliable enough for
 * Backend/Backend2/Cybered/Cybersec/fullstack coding work, so their floor is the SECOND-cheapest
 * rung (currently Sonnet 4.6), never the cheapest.
 */
export const NO_HAIKU_AGENTS: ReadonlySet<string> = new Set([
  'backend',
  'backend2',
  'cybered',
  'cybersec',
  'fullstack',
])

/**
 * Clamp a weekly-ramp target so a NO_HAIKU_AGENTS agent never lands on the ladder's cheapest rung --
 * it holds at the next rung up instead. No-op for every other agent, and a no-op if the target isn't
 * actually the bottom rung.
 */
export function applyNoHaikuFloor(agentName: string, targetModel: string): string {
  if (!NO_HAIKU_AGENTS.has(agentName)) return targetModel
  const bottomIdx = MODEL_LADDER.length - 1
  if (ladderIndexOf(targetModel) < bottomIdx) return targetModel
  return MODEL_LADDER[bottomIdx - 1] ?? targetModel
}

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
  // An OFF-CATALOG base (Ollama / DeepSeek / OpenRouter -- a deliberate local or cheap choice) is not
  // on the Claude cost ladder, so the weekly Claude-ramp must LEAVE IT ALONE. Without this guard the
  // step would REWRITE such an agent onto a paid Claude model: ladderIndexOf(off-catalog) is 0 (the
  // top rung), so weeklyTargetModel(base, tier>=1) returned MODEL_LADDER[tier] (Opus 4.8, then Sonnet
  // 5) -- burning the very quota the ramp exists to protect and undoing the operator's offload
  // (Cybered HIGH, card 5d2002b5; see [[weekly-limit-is-offload-not-park]]). An off-ladder base's
  // weekly target is always itself; only ladder models step down the ladder.
  if (!isLadderModel(baseModel)) return baseModel
  const from = ladderIndexOf(baseModel)
  const steps = Number.isFinite(tier) && tier > 0 ? Math.floor(tier) : 0
  const target = Math.min(from + steps, MODEL_LADDER.length - 1)
  return MODEL_LADDER[target] ?? baseModel
}

/** The operator-facing label for a model id, or the id itself for an off-catalog model (an
 *  OpenRouter id, a manual entry) so the read-only display never shows a blank. */
export function labelForModel(model: string): string {
  return CLAUDE_MODELS.find((m) => m.id === model)?.label ?? model
}

export type ParkedModelAction = { readonly kind: 'none' } | { readonly kind: 'write'; readonly model: string }

/**
 * PURE decision for a PARKED (not running) agent's stored model (Cybered finding, e33af7c4, card
 * a115cd7f). Whether to overwrite `currentModel` with the weekly-tier target, given the durable
 * baseline and the fleet's current tier.
 *
 * "Cheaper tier wins" -- an agent already on a model CHEAPER than the weekly target (e.g. its own
 * banner-fallback axis already dropped it to Haiku, then it got parked) must NOT be written UP to
 * the weekly target while the ramp is still active (agentTier > 0): that would silently undo a
 * cost-saving downgrade and hand the agent a MORE expensive model on its next start -- the exact
 * quota-burn class the ramp exists to prevent, just via the park/start path instead of the sweep.
 * The running-agent path already enforces this via its cheaper-of-banner-vs-weekly merge; this is
 * the parked-path equivalent, expressed as a pure comparison so it is unit-testable without the
 * fs/tmux I/O the runner wraps it in.
 */
export function decideParkedModelUpdate(
  currentModel: string,
  baselineModel: string | null,
  agentTier: number,
  agentName?: string,
): ParkedModelAction {
  const tier = Number.isFinite(agentTier) && agentTier > 0 ? Math.floor(agentTier) : 0
  let weeklyModel = tier > 0 ? weeklyTargetModel(baselineModel ?? currentModel, tier) : (baselineModel ?? currentModel)
  if (tier > 0 && agentName) weeklyModel = applyNoHaikuFloor(agentName, weeklyModel)
  if (!weeklyModel || weeklyModel === currentModel) return { kind: 'none' }
  if (tier > 0 && ladderIndexOf(weeklyModel) < ladderIndexOf(currentModel)) return { kind: 'none' }
  return { kind: 'write', model: weeklyModel }
}

/** One row of the read-only per-agent tier display (card 5d2002b5 redesign, point 4). */
export interface AgentTierRow {
  readonly name: string
  /** mikrob-channels (MAIN) never steps down by the weekly %. */
  readonly exempt: boolean
  /** Effective weekly tier for THIS agent: 0 for an exempt agent, else the fleet tier. */
  readonly tier: number
  readonly baseModel: string
  readonly baseLabel: string
  readonly currentModel: string
  readonly currentLabel: string
  /** Where the weekly ramp wants this agent, from its OWN base + its effective tier. */
  readonly targetModel: string
  readonly targetLabel: string
}

/**
 * Assemble the read-only tier state the dashboard shows. PURE: the caller reads each agent's base +
 * current model and whether it is exempt; this maps them to display rows. An exempt agent is pinned
 * to tier 0 (its base), so the target equals its base. Non-exempt agents step from their OWN base by
 * the fleet tier -- so an Opus base and a Haiku base at the same fleet tier show DIFFERENT targets,
 * which is the per-agent-base fix this whole card is about.
 */
export function buildAgentTierRows(
  agents: ReadonlyArray<{ name: string; baseModel: string; currentModel: string; exempt: boolean }>,
  fleetTier: number,
): AgentTierRow[] {
  const clampedFleet = Number.isFinite(fleetTier) && fleetTier > 0 ? Math.floor(fleetTier) : 0
  return agents.map((a) => {
    const tier = a.exempt ? 0 : clampedFleet
    const targetModel = tier > 0 ? applyNoHaikuFloor(a.name, weeklyTargetModel(a.baseModel, tier)) : weeklyTargetModel(a.baseModel, tier)
    return {
      name: a.name,
      exempt: a.exempt,
      tier,
      baseModel: a.baseModel,
      baseLabel: labelForModel(a.baseModel),
      currentModel: a.currentModel,
      currentLabel: labelForModel(a.currentModel),
      targetModel,
      targetLabel: labelForModel(targetModel),
    }
  })
}
