// Card 3ae2411d round 2 (MikroB msg_id:16839, WhiteHat2 F1): QA PASS 28737 + WhiteHat2 GO both
// held for what they measured, but the card's own fix line promises "the same predicate ... from
// a single source" -- WhiteHat2 then measured that scripts/watchdog.sh's needs-fleet-oauth check
// was a HAND-PORTED Python copy of needsFleetOauthFor that already drifted from it: a model ALIAS
// ("sonnet") or a modelProfile-only config decided differently there than on the dashboard launch
// path (src/web/agent-process.ts). Round 2 replaced that copy with scripts/needs-fleet-oauth.mjs,
// which dynamically imports the compiled dist and calls the EXACT functions agent-process.ts
// calls at its own launch site -- no second hand-written copy.
//
// This test feeds the same fixture set through BOTH paths and asserts identical decisions:
//   - "ground truth": this test's own computation, from the TS SOURCE, using the identical
//     function chain and order as startAgentProcessUnlocked's own launch-site computation
//     (agent-process.ts:2532-2546, 2878, 2892) -- resolveAgentModelFromConfig -> resolveModelId ->
//     resolveOpenRouterModel -> isClaude/isOwnTeam -> needsFleetOauthFor.
//   - "watchdog path": spawning `node scripts/needs-fleet-oauth.mjs <agent-dir>` against a real
//     agent-config.json on disk (dist-based, exactly as watchdog.sh invokes it).
//
// Must be RED on commit a1ebf6bca (the retired Python predicate): verified by hand against that
// commit's scripts/lib/oauth_token_file_check.py --needs-fleet-oauth -- it returns exit 1 (no
// token) for {"model":"sonnet"}, where the correct decision (and this test) is exit 0 (needed),
// because "sonnet" resolves via MODEL_ALIASES to "claude-sonnet-5".
import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveOpenRouterModel } from '../web/openrouter-models.js'
import { readModelProfileMap, resolveModelId, DEFAULT_MODEL, invalidateModelProfileMapCache } from '../web/agent-config.js'
import { needsFleetOauthFor, isClaudeAgent } from '../web/agent-process.js'
import { resolveAgentModelFromConfig, type AgentModelConfig } from '../model-profiles.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'needs-fleet-oauth.mjs')
const PROFILE_MAP_PATH = join(REPO_ROOT, 'store', 'model-profile-map.json')

// AgentModelConfig (model-profiles.ts) only names `model`/`modelProfile` -- it is deliberately
// scoped to the model-resolution layer. customProvider/authMode are separate, sibling fields on
// the SAME agent-config.json read by their own functions elsewhere (readAgentCustomProvider/
// readAgentAuthMode) -- this fixture type is the superset this test actually writes to disk.
type FixtureConfig = AgentModelConfig & { customProvider?: string; authMode?: string }

function groundTruth(config: FixtureConfig): boolean {
  const resolved = resolveAgentModelFromConfig(config, readModelProfileMap(), DEFAULT_MODEL, resolveModelId)
  const model = resolveOpenRouterModel(resolved.model)
  const customProviderId =
    typeof config.customProvider === 'string' && config.customProvider.trim() ? config.customProvider.trim() : null
  const authMode =
    typeof config.authMode === 'string' && ['shared', 'own_team', 'api'].includes(config.authMode)
      ? (config.authMode as 'shared' | 'own_team' | 'api')
      : 'shared'
  // Card 313c8a71 F1 (WhiteHat2, comment 28768): this used to retype `!customProviderId &&
  // model.startsWith('claude-')` a THIRD time (the launch site and needs-fleet-oauth.mjs each had
  // their own copy too) -- a mutation to the real launch site's expression left this "ground
  // truth" green because it was its own, independent computation, not actually grounded in the
  // launch site's logic. Now imported from the TS source directly, same function the launch site
  // and the dist-based CLI both call.
  const isClaude = isClaudeAgent(model, customProviderId)
  const isOwnTeam = isClaude && authMode === 'own_team'
  return needsFleetOauthFor(isClaude, authMode, isOwnTeam, customProviderId)
}

function watchdogPath(dir: string): boolean {
  try {
    execFileSync(process.execPath, [SCRIPT, dir], { stdio: 'pipe' })
    return true
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 1) return false
    throw err // 2 or signal: a real error, not a decision -- let the test surface it
  }
}

describe('needs-fleet-oauth parity: ground truth (TS source) vs watchdog path (dist CLI)', () => {
  let profileMapExisted: boolean
  let profileMapBackup: Buffer | undefined

  const FIXTURES: { name: string; config: FixtureConfig; expected: boolean }[] = [
    { name: 'explicit claude model, authMode shared (baseline true)', config: { model: 'claude-sonnet-5', authMode: 'shared' }, expected: true },
    { name: 'model alias "sonnet" resolves to claude- (round-2 repro)', config: { model: 'sonnet' }, expected: true },
    { name: 'customProvider set, no explicit model', config: { customProvider: 'my-litellm-proxy' }, expected: false },
    { name: 'customProvider set TOGETHER WITH a claude- model string (WhiteHat2 F1)', config: { customProvider: 'my-litellm-proxy', model: 'claude-sonnet-5' }, expected: false },
    { name: 'authMode own_team', config: { model: 'claude-sonnet-5', authMode: 'own_team' }, expected: false },
    { name: 'authMode api', config: { model: 'claude-sonnet-5', authMode: 'api' }, expected: false },
    { name: 'non-claude explicit model, no customProvider', config: { model: 'deepseek-chat' }, expected: false },
    { name: 'no config fields at all', config: {}, expected: true },
    { name: 'modelProfile-only, resolves to a non-claude model via the profile map', config: { modelProfile: 'routine_lowcost' }, expected: false },
    { name: 'modelProfile-only, resolves to a claude model via the profile map', config: { modelProfile: 'build_strong' }, expected: true },
  ]

  beforeAll(() => {
    // A fixture model-profile-map.json so the modelProfile-only fixtures are decidable --
    // store/ is gitignored and deployment-local, so this deployment may have none at all
    // (confirmed: absent here). Backed up and restored, never left mutated for other tests.
    profileMapExisted = existsSync(PROFILE_MAP_PATH)
    if (profileMapExisted) {
      profileMapBackup = readFileSync(PROFILE_MAP_PATH)
    }
    writeFileSync(
      PROFILE_MAP_PATH,
      JSON.stringify({
        profiles: {
          premium_reasoning: 'claude-opus-5',
          build_strong: 'claude-sonnet-5',
          analysis_efficient: 'claude-haiku-5-5',
          routine_lowcost: 'deepseek/deepseek-chat-v3.1',
        },
      }),
    )
    invalidateModelProfileMapCache()
  })

  afterAll(() => {
    if (profileMapExisted && profileMapBackup) {
      writeFileSync(PROFILE_MAP_PATH, profileMapBackup)
    } else {
      rmSync(PROFILE_MAP_PATH, { force: true })
    }
    invalidateModelProfileMapCache()
  })

  it.each(FIXTURES)('$name', ({ config, expected }) => {
    const tmp = mkdtempSync(join(tmpdir(), 'needs-fleet-oauth-parity-'))
    try {
      writeFileSync(join(tmp, 'agent-config.json'), JSON.stringify(config))

      const truth = groundTruth(config)
      const watchdog = watchdogPath(tmp)

      expect(truth).toBe(expected)
      expect(watchdog).toBe(expected)
      expect(watchdog).toBe(truth) // the actual parity assertion, independent of the `expected` column above
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
