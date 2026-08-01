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

  // Weekly-tier target (index). mikrob-channels (MAIN) is exempt like every other
  // fleet-exempt path, so it never gets stepped down by the weekly %.
  const weeklyDesired = name === MAIN_AGENT_ID ? 0 : Math.min(Math.max(0, weeklyIdx), chain.length - 1)

  // Cheaper tier wins: the more-downgraded of the two never gets undone by the other.
  const desired = Math.max(bannerDesired, weeklyDesired)
  const targetModel = chain[desired]
  if (!targetModel || targetModel === currentModel) return

  // Downgrade may run on a limit-paused pane (which reads idle); revert must not
  // cut a live turn. Both go through restart, so require idle for both.
  if (!paneLooksIdle(pane)) {
    logger.info({ name, from: currentModel, to: targetModel }, 'model-fallback: switch due but pane busy, deferring')
    return
  }

  try {
    writeModelFor(name, targetModel)
    restartFor(name)
    // downgradedAt drives the banner revert clock. Re-start it on each step DOWN
    // (matches the banner-only behaviour), clear it once back on the primary.
    if (desired === 0) downgradedAt.delete(name)
    else if (desired > currentIdx) downgradedAt.set(name, nowMs)
    else if (!downgradedAt.has(name)) downgradedAt.set(name, nowMs)
    logger.info(
      { name, from: currentModel, to: targetModel, bannerDesired, weeklyDesired },
      'model-fallback: switched model',
    )
  } catch (err) {
    logger.warn({ err, name }, 'model-fallback: switch failed')
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
