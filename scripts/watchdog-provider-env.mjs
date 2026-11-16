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
import { isCustomProviderFieldUnusable } from './lib/custom-provider-field-check.mjs'

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
  const { readModelProfileMap, resolveModelId, DEFAULT_MODEL, resolveRemoteConfig } = await import(
    join(projectRoot, 'dist', 'web', 'agent-config.js')
  )
  const { resolveOpenRouterModel } = await import(join(projectRoot, 'dist', 'web', 'openrouter-models.js'))
  const { resolveProviderEnv, launchSecretRef, isClaudeAgent } = await import(
    join(projectRoot, 'dist', 'web', 'agent-process.js')
  )
  const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))

  const config = readConfig(agentDir)

  // Card 11c6cab4 R3 (RedHat follow-up on 657b32f2, comment 14986): this is the SECOND launch
  // site (the dashboard start path is agent-process.ts's startAgentProcessUnlocked) that builds a
  // provider env from an agent's config, and until now it knew about neither of the two things
  // that site refuses loudly for. Both checked here, both refuse (exit non-zero, no output) --
  // this script's own existing fail-closed convention, not a new one.
  //
  // (a) customProvider present but not a usable non-empty string (R1's bug, same predicate,
  // via the shared scripts/lib/custom-provider-field-check.mjs classifier -- the real
  // isAgentCustomProviderFieldUnusable()/readAgentCustomProvider() pair in agent-config.ts are
  // path-based (agentDir(name)/agent-config.json) and cannot be reused here: this script is
  // fixture-tested against a TEMP directory distinct from the real agents/ tree
  // (watchdog-provider-env-parity.test.ts), so the customProviderId line below already computes
  // it from `config` directly rather than calling the path-based reader -- same reason this
  // refusal operates on `config` instead of calling the path-based checker too).
  if (isCustomProviderFieldUnusable(config)) {
    console.error('customProvider: field present but not a usable non-empty string -- refusing rather than treating it as unset')
    process.exit(2)
  }

  // (b) a remote (ssh) agent: resolveProviderEnv has no effect on the remote launch path at all
  // (agent-process.ts's own refuseRemoteCustomProvider comment), so this script has nothing
  // correct to export for one -- refuse rather than silently computing a value nothing will use.
  // resolveRemoteConfig is the real, imported validator (host/workdir character-class + parent-
  // traversal checks), not a hand-rolled duplicate -- it takes a raw JSON string, which readConfig
  // above already consumed, so it is re-derived here via JSON.stringify(config) rather than
  // threading a second raw-string return value through readConfig for this one caller.
  if (resolveRemoteConfig(JSON.stringify(config)).host) {
    console.error('remote agent: watchdog-provider-env has no effect on the ssh launch path -- refusing rather than computing an unused value')
    process.exit(2)
  }

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
