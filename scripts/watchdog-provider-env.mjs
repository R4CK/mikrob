#!/usr/bin/env node
// Card 3ae2411d F4 (WhiteHat2 CYBERSEC GO on a879697c0/a1ebf6bca): after the fleet-token-leak fix,
// watchdog.sh no longer exports the fleet token to a BYO/customProvider agent on restart -- but it
// also sets NONE of that agent's own provider env, so the restarted agent runs as plain Claude
// with no credentials at all. Mirrors needs-fleet-oauth.mjs's own fix: single source via a dynamic
// import from the compiled dist, so the watchdog restart path builds the EXACT same provider env
// (resolveProviderEnv, agent-process.ts) as the dashboard start path -- no second hand-written copy.
//
// Called only for the case needs-fleet-oauth.mjs already said "not needed" (plain Claude on the
// shared fleet token is handled entirely by watchdog.sh's own fleet-oauth/own-token logic above
// this call; nothing here duplicates that).
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const agentDir = process.argv[2]
const agentName = process.argv[3]
if (!agentDir || !agentName) {
  console.error('usage: watchdog-provider-env.mjs <agent-dir> <agent-name>')
  process.exit(2)
}

// Card 313c8a71 F3 (WhiteHat2 + QA2 FAIL 28874): a PRESENT but corrupt agent-config.json used to
// default to {} the same way a genuinely MISSING file does -- see needs-fleet-oauth.mjs's own
// readConfig for the full reasoning (same fix, same file shape, both scripts read the same file).
// A missing file is a legitimate default; a present-but-unreadable one is undecidable and must
// throw (caught by the outer try/catch below, exit 2), never a silent {}.
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
  const { resolveProviderEnv, launchSecretRef, isClaudeAgent } = await import(
    join(projectRoot, 'dist', 'web', 'agent-process.js')
  )
  const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))

  const config = readConfig(agentDir)
  const resolved = resolveAgentModelFromConfig(config, readModelProfileMap(), DEFAULT_MODEL, resolveModelId)
  const model = resolveOpenRouterModel(resolved.model)
  const customProviderId =
    typeof config.customProvider === 'string' && config.customProvider.trim() ? config.customProvider.trim() : null
  const authMode =
    typeof config.authMode === 'string' && VALID_AUTH_MODES.has(config.authMode) ? config.authMode : 'shared'
  // Card 313c8a71 F1: single source with the launch site and needs-fleet-oauth.mjs, same function.
  const isClaude = isClaudeAgent(model, customProviderId)

  let out = ''
  if (isClaude && authMode === 'api') {
    // Same shape as agent-process.ts's own apiKeyEnv branch: a Claude agent on its own vault API
    // key instead of OAuth.
    const agentApiKey = (getSecret(`agent-${agentName}-api-key`) ?? '').trim()
    if (agentApiKey) {
      out = `export ANTHROPIC_API_KEY=${launchSecretRef(`agent-${agentName}-api-key`, agentApiKey)} && `
    }
  } else if (!isClaude || customProviderId) {
    out = resolveProviderEnv(
      model,
      (id) => {
        const value = (getSecret(id) ?? '').trim()
        return value ? launchSecretRef(`${agentName}.${id}`, value) : null
      },
      customProviderId,
    ).exportsStr
  }
  process.stdout.write(out)
  process.exit(0)
} catch (err) {
  // Fail closed, same posture as needs-fleet-oauth.mjs: an undecidable case must not export
  // anything, never fall back to a guess.
  console.error(String((err && err.stack) || err))
  process.exit(2)
}
