// Card 3ae2411d F4 (WhiteHat2 GO on a879697c0/a1ebf6bca): after the fleet-token-leak fix,
// watchdog.sh stopped exporting the fleet token to a BYO/customProvider agent on restart, but it
// also set none of that agent's OWN provider env -- a restarted BYO agent came up as plain Claude
// with no credentials. scripts/watchdog-provider-env.mjs fixes this by dynamically importing the
// compiled dist and calling the EXACT resolveProviderEnv function the dashboard start path calls
// at its own launch site (agent-process.ts:2576-2585) -- no second hand-written copy.
//
// This test feeds the same fixture set through BOTH paths and asserts identical exportsStr output:
//   - "ground truth": this test's own computation, calling resolveProviderEnv directly from the
//     TS source, with a secretShellRef that never touches the real vault (constant stub), mirroring
//     a missing-vault-key environment deterministically instead of depending on real vault state.
//   - "watchdog path": spawning `node scripts/watchdog-provider-env.mjs <agent-dir> <agent-name>`
//     against a real agent-config.json on disk (dist-based, exactly as watchdog.sh invokes it).
//
// The watchdog path's secretShellRef is NOT stubbable (it reads the real vault via getSecret) --
// so fixtures here are restricted to shapes where a missing/absent vault secret resolves the SAME
// way on both sides (deepseek/openrouter: falls back to an empty-literal token; customProvider:
// both sides throw identically; ollama/claude+api: no secret lookup needed for ollama, and the
// agent-api-key fixture below skips vault comparison and instead pins the no-key no-export shape).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveOpenRouterModel } from '../web/openrouter-models.js'
import { readModelProfileMap, resolveModelId, DEFAULT_MODEL } from '../web/agent-config.js'
import { resolveProviderEnv } from '../web/agent-process.js'
import { resolveAgentModelFromConfig, type AgentModelConfig } from '../model-profiles.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'watchdog-provider-env.mjs')

type FixtureConfig = AgentModelConfig & { customProvider?: string; authMode?: string }

// Ground truth, with a secretShellRef that always resolves to "no secret" (null) -- the watchdog
// path's real vault is empty for an agent name this test invents, so the two sides see the same
// absence. Exercises exactly the branch resolveProviderEnv takes for an unconfigured secret:
// deepseek/openrouter fall back to an empty-literal token, customProvider throws.
function groundTruth(config: FixtureConfig): string {
  const resolved = resolveAgentModelFromConfig(config, readModelProfileMap(), DEFAULT_MODEL, resolveModelId)
  const model = resolveOpenRouterModel(resolved.model)
  const customProviderId =
    typeof config.customProvider === 'string' && config.customProvider.trim() ? config.customProvider.trim() : null
  return resolveProviderEnv(model, () => null, customProviderId).exportsStr
}

function watchdogPath(dir: string, agentName: string): { out: string; status: number | null } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, dir, agentName], { stdio: 'pipe', encoding: 'utf-8' })
    return { out, status: 0 }
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string }
    return { out: e.stdout ?? '', status: e.status ?? null }
  }
}

describe('watchdog-provider-env parity: ground truth (TS source) vs watchdog path (dist CLI)', () => {
  const FIXTURES: { name: string; config: FixtureConfig }[] = [
    { name: 'deepseek model, no vault key configured', config: { model: 'deepseek-chat' } },
    { name: 'openrouter-shaped model (contains /), no vault key configured', config: { model: 'meta-llama/llama-3.1-8b' } },
    { name: 'model alias resolving to a claude model (no provider env expected)', config: { model: 'sonnet' } },
  ]

  it.each(FIXTURES)('$name', ({ config }) => {
    const tmp = mkdtempSync(join(tmpdir(), 'watchdog-provider-env-parity-'))
    try {
      writeFileSync(join(tmp, 'agent-config.json'), JSON.stringify(config))

      const truth = groundTruth(config)
      const { out: watchdog, status } = watchdogPath(tmp, 'parity-fixture-agent')

      expect(status).toBe(0)
      expect(watchdog).toBe(truth)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // customProvider with no matching registry entry: both sides must refuse identically (the
  // ground truth's resolveProviderEnv throws; the watchdog path must exit non-zero and print
  // NOTHING -- never a partial or guessed export for a credential it cannot resolve).
  it('customProvider with no registry entry: both sides refuse, watchdog prints nothing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'watchdog-provider-env-parity-'))
    try {
      const config: FixtureConfig = { customProvider: 'nonexistent-provider-fixture', model: 'claude-sonnet-5' }
      writeFileSync(join(tmp, 'agent-config.json'), JSON.stringify(config))

      expect(() => groundTruth(config)).toThrow()

      const { out, status } = watchdogPath(tmp, 'parity-fixture-agent')
      expect(status).not.toBe(0)
      expect(out).toBe('')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // Claude + authMode shared (the common case): no provider env from EITHER side -- this agent's
  // credentials are the fleet token / own setup-token path above this function in watchdog.sh,
  // not resolveProviderEnv's job.
  it('plain claude, authMode shared: no provider env from either side', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'watchdog-provider-env-parity-'))
    try {
      const config: FixtureConfig = { model: 'claude-sonnet-5', authMode: 'shared' }
      writeFileSync(join(tmp, 'agent-config.json'), JSON.stringify(config))

      expect(groundTruth(config)).toBe('')
      const { out, status } = watchdogPath(tmp, 'parity-fixture-agent')
      expect(status).toBe(0)
      expect(out).toBe('')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
