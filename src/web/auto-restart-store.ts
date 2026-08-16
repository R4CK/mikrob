import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  normalizeAutoRestartConfig,
  DEFAULT_AUTO_RESTART,
  type AutoRestartConfig,
} from '../auto-restart.js'

// Per-agent auto-restart config lives in one JSON map keyed by agent name
// (the main orchestrator included, under its agent id). A single file keeps the
// main session and sub-agents uniform and sidesteps the per-agent-dir vs
// PROJECT_ROOT config-path split.
const STORE_PATH = join(PROJECT_ROOT, 'store', 'auto-restart.json')

function readRaw(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** One agent's config, normalized; the disabled default when unset. */
export function readAutoRestartConfig(name: string): AutoRestartConfig {
  const raw = readRaw()
  return name in raw ? normalizeAutoRestartConfig(raw[name]) : { ...DEFAULT_AUTO_RESTART }
}

/** Persist one agent's config (normalized first so the store stays clean). */
export function writeAutoRestartConfig(name: string, cfg: unknown): AutoRestartConfig {
  const normalized = normalizeAutoRestartConfig(cfg)
  const raw = readRaw()
  raw[name] = normalized
  atomicWriteFileSync(STORE_PATH, JSON.stringify(raw, null, 2))
  return normalized
}
