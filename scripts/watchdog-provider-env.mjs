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

function readConfig(dir) {
  let raw = '{}'
  try {
    raw = readFileSync(join(dir, 'agent-config.json'), 'utf-8')
  } catch {
    raw = '{}'
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const VALID_AUTH_MODES = new Set(['shared', 'own_team', 'api'])

try {
  const { resolveAgentModelFromConfig } = await import(join(projectRoot, 'dist', 'model-profiles.js'))
  const { readModelProfileMap, resolveModelId, DEFAULT_MODEL } = await import(
    join(projectRoot, 'dist', 'web', 'agent-config.js')
  )
  const { resolveOpenRouterModel } = await import(join(projectRoot, 'dist', 'web', 'openrouter-models.js'))
  const { resolveProviderEnv, launchSecretRef } = await import(join(projectRoot, 'dist', 'web', 'agent-process.js'))
  const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))

  const config = readConfig(agentDir)
  const resolved = resolveAgentModelFromConfig(config, readModelProfileMap(), DEFAULT_MODEL, resolveModelId)
  const model = resolveOpenRouterModel(resolved.model)
  const customProviderId =
    typeof config.customProvider === 'string' && config.customProvider.trim() ? config.customProvider.trim() : null
  const authMode =
    typeof config.authMode === 'string' && VALID_AUTH_MODES.has(config.authMode) ? config.authMode : 'shared'
  const isClaude = !customProviderId && model.startsWith('claude-')

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
