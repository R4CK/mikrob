#!/usr/bin/env node
// Single source of truth for the "does this agent need the fleet's shared
// CLAUDE_CODE_OAUTH_TOKEN" decision, used by BOTH launch sites.
//
// Card 3ae2411d, round 2 (MikroB msg_id:16839, WhiteHat2 F1): the previous fix
// gave scripts/watchdog.sh a SECOND, hand-written Python copy of
// needsFleetOauthFor (scripts/lib/oauth_token_file_check.py's own
// needs_fleet_oauth). That copy read the raw `model` string instead of
// resolving it the way src/web/agent-process.ts actually does (MODEL_ALIASES
// via resolveModelId, modelProfile via resolveAgentModelFromConfig, the
// openrouter-auto tier via resolveOpenRouterModel) -- so a model ALIAS
// ("sonnet") or a modelProfile-only config could decide differently on the
// watchdog path than on the dashboard launch path. "One single source"
// (the card's own fix line) means there must be exactly one PLACE this
// decision is computed, not two call sites kept in sync by hand.
//
// This script IS that one place for a shell caller: it dynamically imports
// the compiled dist (mirrors scripts/main-agent-isolated-config.mjs's own
// "single source of truth via dynamic import" pattern) and calls the exact
// same functions src/web/agent-process.ts calls at its own launch site, in
// the same order, on a freshly-read agent-config.json -- never a
// reimplementation of what isClaude/authMode/isOwnTeam mean.
//
// Usage: node scripts/needs-fleet-oauth.mjs <agent-dir>
// Exit 0 = fleet oauth token needed, 1 = not needed, 2 = usage/import/read error.
//
// Fail-closed on error (2): the caller (watchdog.sh) only exports the fleet
// token on exit 0 inside an `&&` chain, so any non-zero exit -- missing
// node, missing dist build, unreadable config -- means no export, never a
// silent fallback to exporting the token. This is a deliberate tightening
// vs. the retired Python predicate, which defaulted to "needed" (exit 0) on
// any crash; this card is specifically about NOT over-exporting the fleet
// token, so an undecidable case must lean the other way.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const agentDir = process.argv[2]
if (!agentDir) {
  console.error('usage: needs-fleet-oauth.mjs <agent-dir>')
  process.exit(2)
}

function readConfig(dir) {
  let raw = '{}'
  try {
    raw = readFileSync(join(dir, 'agent-config.json'), 'utf-8')
  } catch {
    raw = '{}' // missing file: same "first write" default as readFileOr in agent-config.ts
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {} // unparseable: resolveAgentModelDetailed's own catch also falls back to {}
  }
}

const VALID_AUTH_MODES = new Set(['shared', 'own_team', 'api'])

try {
  const { resolveAgentModelFromConfig } = await import(join(projectRoot, 'dist', 'model-profiles.js'))
  const { readModelProfileMap, resolveModelId, DEFAULT_MODEL } = await import(
    join(projectRoot, 'dist', 'web', 'agent-config.js')
  )
  const { resolveOpenRouterModel } = await import(join(projectRoot, 'dist', 'web', 'openrouter-models.js'))
  const { needsFleetOauthFor } = await import(join(projectRoot, 'dist', 'web', 'agent-process.js'))

  const config = readConfig(agentDir)

  // Mirrors agent-process.ts's own launch-site computation (startAgentProcessUnlocked), in the
  // same order: resolve the model through the SAME alias/profile chain, then resolveOpenRouterModel
  // for the openrouter-auto:<tier> indirection, then the isClaude/isOwnTeam predicates exactly as
  // written there (see agent-process.ts:2532-2546, 2878).
  const resolved = resolveAgentModelFromConfig(config, readModelProfileMap(), DEFAULT_MODEL, resolveModelId)
  const model = resolveOpenRouterModel(resolved.model)
  const customProviderId =
    typeof config.customProvider === 'string' && config.customProvider.trim() ? config.customProvider.trim() : null
  const authMode =
    typeof config.authMode === 'string' && VALID_AUTH_MODES.has(config.authMode) ? config.authMode : 'shared'
  const isClaude = !customProviderId && model.startsWith('claude-')
  const isOwnTeam = isClaude && authMode === 'own_team'

  process.exit(needsFleetOauthFor(isClaude, authMode, isOwnTeam, customProviderId) ? 0 : 1)
} catch (err) {
  console.error(String((err && err.stack) || err))
  process.exit(2)
}
