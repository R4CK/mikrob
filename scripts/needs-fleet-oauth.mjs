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

// Card 313c8a71 F3 (WhiteHat2 + QA2 FAIL 28874): a PRESENT but corrupt agent-config.json (non-JSON
// text, truncated JSON, a UTF-8 BOM, a JSON array) used to default to {} the same way a genuinely
// MISSING file does -- and {} resolves to the install default model, which is almost always
// claude-*, so a corrupt config restarted the agent WITH the fleet token instead of refusing. A
// missing file is a legitimate "first write hasn't happened yet" case (same as agent-config.ts's
// own readFileOr default); a present-but-unreadable one is not a default, it is undecidable, and
// must reach the outer catch (exit 2) like any other undecidable case -- never a silent {}.
function readConfig(dir) {
  let raw
  try {
    raw = readFileSync(join(dir, 'agent-config.json'), 'utf-8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return {}
    throw err
  }
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('agent-config.json did not parse to a JSON object')
  }
  return parsed
}

const VALID_AUTH_MODES = new Set(['shared', 'own_team', 'api'])

try {
  const { resolveAgentModelFromConfig } = await import(join(projectRoot, 'dist', 'model-profiles.js'))
  const { readModelProfileMap, resolveModelId, DEFAULT_MODEL } = await import(
    join(projectRoot, 'dist', 'web', 'agent-config.js')
  )
  const { resolveOpenRouterModel } = await import(join(projectRoot, 'dist', 'web', 'openrouter-models.js'))
  const { needsFleetOauthFor, isClaudeAgent } = await import(join(projectRoot, 'dist', 'web', 'agent-process.js'))

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
  // Card 313c8a71 F1: isClaudeAgent is the single source for this expression, imported from the
  // SAME dist module as needsFleetOauthFor -- not a retyped copy (see that function's doc comment
  // in agent-process.ts for why that mattered).
  const isClaude = isClaudeAgent(model, customProviderId)
  const isOwnTeam = isClaude && authMode === 'own_team'

  // Card 313c8a71 F2 (WhiteHat2): a missing/deleted script file, or one with a syntax error,
  // never reaches this line at all -- node's own module loader fails first and exits 1, the EXACT
  // same code this script's own "not needed" decision uses. A caller reading only the exit code
  // cannot tell "this agent genuinely does not need the token" from "the script could not even
  // run" -- and the watchdog's own fail-closed posture only protects it from exit 2, not from a
  // silent exit 1 that looks identical to a real decision. The stdout sentinel proves THIS CODE
  // actually ran and reached a verdict; its absence on exit 1 means the caller never got here.
  const needed = needsFleetOauthFor(isClaude, authMode, isOwnTeam, customProviderId)
  process.stdout.write(needed ? 'needed\n' : 'not-needed\n')
  process.exit(needed ? 0 : 1)
} catch (err) {
  console.error(String((err && err.stack) || err))
  process.exit(2)
}
