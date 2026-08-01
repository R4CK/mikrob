import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { hardRestartMarveenChannels } from './channel-monitor.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  listAgentNames,
  readAgentRemoteHost,
  readAgentModel,
  writeAgentModel,
  resolveModelId,
  isValidModelId,
  InvalidModelIdError,
  DEFAULT_MODEL,
} from './agent-config.js'
import {
  agentRunState,
  agentSessionName,
  restartAgentProcess,
  capturePane,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { paneLooksIdle } from '../pane-state.js'
import { readModelFallbackConfig } from './model-fallback-store.js'
import { ladderIndexOf, weeklyTargetModel, buildAgentTierRows, type AgentTierRow } from '../model-catalog.js'
import {
  readBaselineModel,
  recordBaselineIfAbsent,
  clearBaseline,
} from './model-tier-baseline-store.js'
import {
  detectsUsageLimit,
  decideModelAction,
  weeklyTierIndex,
  type ModelFallbackConfig,
} from '../model-fallback.js'
import { readHardStop } from '../costops/weekly-hard-stop.js'

// Drives the model-fallback-on-limit feature (see src/model-fallback.ts for the
// why and the pure decision logic). Mirrors the auto-restart runner: a 60s
// sweep, offset from the other watchers so tmux calls do not pile onto one tick.
//
// Per agent each tick: capture the pane, detect a plan usage-limit banner, ask
// the pure decision function what to do, and -- only when the pane is idle --
// rewrite the agent's model and respawn the session (keeping the conversation)
// so the new model takes effect. A revert climbs back to the primary once the
// agent has been limit-free past the configured window.

const INITIAL_DELAY_MS = 50_000
const INTERVAL_MS = 60_000

// agent name -> when we last downgraded it (ms). Absent => currently on primary.
// In-memory: a dashboard restart loses this, so a downgraded agent would not be
// auto-reverted until the next downgrade cycle. Acceptable; the agent keeps
// working on the fallback model, and the operator can revert manually.
const downgradedAt = new Map<string, number>()

// The fleet's current WEEKLY tier (0 primary / 1 / 2), held across sweeps so the
// hysteresis in weeklyTierIndex() has the previous tier to compare against. This
// is fleet-global on purpose: the weekly % is one number for the whole fleet, so
// every agent shares one weekly tier (unlike the per-agent banner downgrade).
let weeklyTier = 0

const MAIN_SETTINGS_PATH = join(PROJECT_ROOT, '.claude', 'settings.json')

function readMainModel(): string {
  try {
    const cfg = JSON.parse(readFileSync(MAIN_SETTINGS_PATH, 'utf-8'))
    return resolveModelId((cfg && typeof cfg.model === 'string' && cfg.model) || DEFAULT_MODEL)
  } catch {
    return DEFAULT_MODEL
  }
}

function writeMainModel(model: string): void {
  // Validate BEFORE the write chokepoint, mirroring writeAgentModel's guard (card 6610edff): no
  // code path to a persisted model id may bypass the allowlist, even though this one only reaches
  // .claude/settings.json (not a shell sink) and today only receives already-validated ramp values.
  if (!isValidModelId(model)) throw new InvalidModelIdError(model)
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(readFileSync(MAIN_SETTINGS_PATH, 'utf-8')) } catch {}
  cfg.model = model
  atomicWriteFileSync(MAIN_SETTINGS_PATH, JSON.stringify(cfg, null, 2))
}

function readModelFor(name: string): string {
  return name === MAIN_AGENT_ID ? readMainModel() : readAgentModel(name)
}

function writeModelFor(name: string, model: string): void {
  if (name === MAIN_AGENT_ID) writeMainModel(model)
  else writeAgentModel(name, model)
}

function sessionFor(name: string): string {
  return name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
}

function restartFor(name: string): void {
  if (name === MAIN_AGENT_ID) {
    // A fresh main relaunch re-reads .claude/settings.json (and thus the new
    // model). channels.sh always starts fresh for main, so a conversation is
    // not preserved here -- the model swap is what matters.
    //
    // Was a hardcoded `/bin/launchctl kickstart` (macOS-only), so on Linux the
    // usage-limit fallback could never actually swap main's model: it threw
    // ENOENT into the caller's catch. hardRestartMarveenChannels() keeps the
    // launchd path for macOS installs and its Linux respawn-pane path re-reads
    // settings.json the same way.
    const res = hardRestartMarveenChannels()
    if (!res.ok) throw new Error(res.error ?? 'main channels hard restart failed')
  } else {
    // 'continue' (fresh: false) re-spawns with --continue so the conversation
    // survives the model swap.
    restartAgentProcess(name, { fresh: false })
  }
}

function checkAgent(name: string, nowMs: number, cfg: ModelFallbackConfig, weeklyIdx: number): void {
  // Sub-agents must be up; the main session is launchd-managed (always present).
  if (name !== MAIN_AGENT_ID && agentRunState(name) !== 'running') return

  const chain = cfg.chain
  const session = sessionFor(name)
  const host = name === MAIN_AGENT_ID ? null : readAgentRemoteHost(name)
  const pane = capturePane(session, host)
  if (pane == null) return

  const currentModel = readModelFor(name)
  // An off-chain current model reads as the primary (index 0) for the tier math,
  // matching nextFallbackModel's treatment of an unrecognised model.
  const currentIdx = Math.max(0, chain.indexOf(currentModel))

  // Banner-driven fallback target (index). When the banner feature is off it
  // holds NO floor (0), so the weekly tier is free to revert the agent; when on,
  // decideModelAction owns its own revert-window timing and returns 0 when it
  // wants the primary back.
  let bannerDesired = 0
  if (cfg.enabled) {
    const action = decideModelAction({
      limitDetected: detectsUsageLimit(pane),
      currentModel,
      chain,
      downgradedAt: downgradedAt.get(name) ?? null,
      now: nowMs,
      revertAfterMs: cfg.revertAfterMinutes * 60_000,
    })
    if (action.kind === 'downgrade') bannerDesired = Math.max(0, chain.indexOf(action.model))
    else if (action.kind === 'revert') bannerDesired = 0
    else bannerDesired = currentIdx // 'none' = hold current (e.g. still inside the revert window)
  }

  const bannerModel = chain[Math.max(0, Math.min(bannerDesired, chain.length - 1))] ?? currentModel

  // Weekly-tier target -- PER AGENT, relative to its OWN base (card 5d2002b5, Peti). mikrob-channels
  // (MAIN) is exempt like every other fleet-exempt path, so it never steps down by the weekly %.
  //
  // The base is DURABLE (model-tier-baseline.json): recorded the first time an agent is stepped down
  // (its then-current model IS the base), read back on every sweep, and cleared once the agent is
  // home again. So a dashboard restart mid-ramp no longer loses the base and strand the agent on the
  // cheap model -- it reverts to the model it actually started on. The old code used `weeklyIdx` as
  // an ABSOLUTE chain index, so every agent landed on chain[weeklyIdx] regardless of its base.
  const agentTier = name === MAIN_AGENT_ID ? 0 : Math.max(0, weeklyIdx)
  let weeklyModel = currentModel
  if (agentTier > 0) {
    const base = readBaselineModel(name) ?? currentModel
    weeklyModel = weeklyTargetModel(base, agentTier)
  } else {
    // Tier 0 = the weekly ramp is not pulling this agent down: home is its recorded base if one
    // exists (it is climbing back), else its current model (never stepped).
    weeklyModel = readBaselineModel(name) ?? currentModel
  }

  // Cheaper tier wins: of the banner target and the weekly target, the one FURTHER DOWN THE LADDER
  // stands, so neither axis undoes the other's downgrade. Compared by ladder position, not by two
  // different index spaces.
  const targetModel =
    ladderIndexOf(weeklyModel) >= ladderIndexOf(bannerModel) ? weeklyModel : bannerModel
  if (!targetModel || targetModel === currentModel) {
    // Even with no model change, a fully-reverted agent (home, tier 0, banner clear) must not keep a
    // stale durable base around -- otherwise a later restart would treat the cheap model as the base.
    if (agentTier === 0 && bannerDesired === 0 && readBaselineModel(name) !== null) {
      clearBaseline(name)
      downgradedAt.delete(name)
    }
    return
  }

  // Downgrade may run on a limit-paused pane (which reads idle); revert must not
  // cut a live turn. Both go through restart, so require idle for both.
  if (!paneLooksIdle(pane)) {
    logger.info({ name, from: currentModel, to: targetModel }, 'model-fallback: switch due but pane busy, deferring')
    return
  }

  // Whether this is a step DOWN, for the durable-base + revert-clock bookkeeping.
  const steppingDown = ladderIndexOf(targetModel) > ladderIndexOf(currentModel)

  try {
    // Record the base BEFORE the write, so the durable base is the pre-downgrade model, and only when
    // this step is a weekly-driven step down (the banner axis has its own chain[0] home).
    if (steppingDown && agentTier > 0) recordBaselineIfAbsent(name, currentModel)
    writeModelFor(name, targetModel)
    restartFor(name)
    // downgradedAt drives the banner revert clock. Re-start it on each step DOWN, and once the agent
    // is back on its base (weekly home + banner clear), clear both the clock and the durable base.
    const homeAgain = agentTier === 0 && bannerDesired === 0
    if (homeAgain) {
      downgradedAt.delete(name)
      clearBaseline(name)
    } else if (steppingDown) downgradedAt.set(name, nowMs)
    else if (!downgradedAt.has(name)) downgradedAt.set(name, nowMs)
    logger.info(
      { name, from: currentModel, to: targetModel, bannerModel, weeklyModel, agentTier },
      'model-fallback: switched model',
    )
  } catch (err) {
    logger.warn({ err, name }, 'model-fallback: switch failed')
  }
}

/** The fleet's current weekly tier (0/1/2), for the read-only dashboard display. Held in memory and
 *  advanced by the sweep's hysteresis; used as the previous-tier seed when the display recomputes. */
export function currentWeeklyTier(): number {
  return weeklyTier
}

/**
 * The read-only per-agent tier state the dashboard renders (card 5d2002b5 redesign, point 4).
 * Recomputes the fleet tier from the live weekly % (seeded with the in-memory tier so the hysteresis
 * matches what the sweep will do), then, for every agent, reports its DURABLE base, its actual current
 * model, and where the ramp targets it from its OWN base. mikrob-channels (MAIN) is exempt.
 *
 * The base shown is the durable baseline when the agent has been stepped down, else its current model
 * (never stepped => it IS its own base). No IO beyond reading the same files the sweep reads.
 */
export function readFleetTierState(): {
  weeklyTierEnabled: boolean
  weeklyPercent: number
  fleetTier: number
  agents: AgentTierRow[]
} {
  const cfg = readModelFallbackConfig()
  const percent = readHardStop().percent
  const fleetTier =
    cfg.weeklyTierEnabled && percent >= 0 ? weeklyTierIndex(percent, cfg, weeklyTier) : 0

  const rows: Array<{ name: string; baseModel: string; currentModel: string; exempt: boolean }> = []
  const collect = (name: string, exempt: boolean) => {
    const currentModel = readModelFor(name)
    const baseModel = readBaselineModel(name) ?? currentModel
    rows.push({ name, baseModel, currentModel, exempt })
  }
  collect(MAIN_AGENT_ID, true)
  for (const name of listAgentNames()) collect(name, false)

  return {
    weeklyTierEnabled: cfg.weeklyTierEnabled,
    weeklyPercent: percent,
    fleetTier,
    agents: buildAgentTierRows(rows, fleetTier),
  }
}

export function startModelFallbackRunner(): NodeJS.Timeout {
  function sweep() {
    const cfg = readModelFallbackConfig()
    if (!cfg.enabled && !cfg.weeklyTierEnabled) {
      if (downgradedAt.size > 0) downgradedAt.clear() // re-seed cleanly if re-enabled
      weeklyTier = 0
      return
    }
    const now = Date.now()
    // Recompute the fleet weekly tier from the live weekly % (refreshed every
    // ~30 min by store/weekly-usage-panel-read.sh -> weekly-hard-stop.json, the
    // single weekly-% cadence). A negative/unknown % holds the last tier.
    if (cfg.weeklyTierEnabled) {
      const percent = readHardStop().percent
      if (percent >= 0) weeklyTier = weeklyTierIndex(percent, cfg, weeklyTier)
    } else {
      weeklyTier = 0
    }
    const weeklyIdx = weeklyTier
    try { checkAgent(MAIN_AGENT_ID, now, cfg, weeklyIdx) }
    catch (err) { logger.debug({ err }, 'model-fallback: main check error') }
    for (const name of listAgentNames()) {
      try { checkAgent(name, now, cfg, weeklyIdx) }
      catch (err) { logger.debug({ err, agent: name }, 'model-fallback: agent check error') }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
