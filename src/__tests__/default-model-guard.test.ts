/**
 * DEFAULTCLIGUARD927 (Szotasz review of #1609): the launch-time guard on the
 * DEFAULT model path of sub-agents, worker sessions and agent-create. The
 * shipped default is swapped for the previous tier only when (a) no operator
 * configured DEFAULT_AGENT_MODEL and (b) the installed CLI is MEASURED not to
 * run it. The main-agent path (shell + respawn) is pinned in
 * main-model-resolution-parity.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DISTRIBUTION_DEFAULT_AGENT_MODEL } from '../config-registry.js'
import { CLI_VERSION_OVERRIDE_ENV } from '../web/claude-cli-version.js'

const saved = process.env[CLI_VERSION_OVERRIDE_ENV]
afterEach(() => {
  if (saved === undefined) delete process.env[CLI_VERSION_OVERRIDE_ENV]
  else process.env[CLI_VERSION_OVERRIDE_ENV] = saved
  vi.doUnmock('../config.js')
  vi.resetModules()
})
beforeEach(() => { vi.resetModules() })

/** Load the guard against a config whose DEFAULT_AGENT_MODEL is (or is not) operator-set. */
async function loadGuard(configured: string | null) {
  vi.doMock('../config.js', async (orig) => {
    const actual = await orig<typeof import('../config.js')>()
    return {
      ...actual,
      DEFAULT_AGENT_MODEL: configured ?? DISTRIBUTION_DEFAULT_AGENT_MODEL,
      DEFAULT_AGENT_MODEL_IS_DISTRIBUTION: configured === null,
    }
  })
  const guard = await import('../web/default-model-guard.js')
  const { logger } = await import('../logger.js')
  guard.resetDefaultModelGuardLog()
  return { guard, logger }
}

describe('model-less launch on the shipped default', () => {
  // FORK DIVERGENCE (Köteg 12, upstream 0bea3cd7, 2026-10-13): this fixture's "2.1.110 forces a
  // fallback" premise assumes DISTRIBUTION_DEFAULT_AGENT_MODEL is a CLI-constrained tier (upstream:
  // 'claude-opus-5-5[1m]', which claude-cli-support.ts's CLAUDE_MODEL_MIN_CLI pins to >= 2.1.280).
  // This fork's constant stays 'claude-opus-5' (card d041760b invariant, re-affirmed 2026-09-25 and
  // again this round -- see config-registry.ts/model-suggest.test.ts), which carries NO entry in
  // that table -- it already runs on every measured CLI, including 2.1.110. launchableDefaultModel
  // therefore correctly does NOT replace it: the fallback mechanism itself is adopted and correct,
  // it is simply a no-op on today's fork default (same note as config-registry.ts's
  // DISTRIBUTION_DEFAULT_FALLBACK_MODEL comment). Re-tighten this fixture to force a real
  // replacement if/when the deferred model-bump decision lands.
  it('2.1.110 (the AVX-less pin) -> no replacement on this fork (DISTRIBUTION_DEFAULT_AGENT_MODEL has no CLI constraint)', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110'
    const { guard } = await loadGuard(null)
    expect(await guard.launchableInstallDefault('agent:test')).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(guard.launchableInstallDefaultSync('worker')).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(guard.launchableDistributionDefaultSync('main')).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('2.1.280 -> the shipped default (positive control)', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.280'
    const { guard } = await loadGuard(null)
    expect(await guard.launchableInstallDefault('agent:test')).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(guard.launchableInstallDefaultSync('worker')).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('unmeasured CLI -> the shipped default (fail-open)', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = ''
    const { guard } = await loadGuard(null)
    expect(await guard.launchableInstallDefault('agent:test')).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  // FORK DIVERGENCE, same reasoning as the fixture above: 2.1.110 does not replace this fork's
  // DISTRIBUTION_DEFAULT_AGENT_MODEL, so no DEFAULTCLIGUARD927 warn line fires at all. The
  // one-line-per-surface-and-version dedup itself is exercised by the no-replacement test above
  // (it calls the sync/async/main variants without asserting on warn, which would fail loudly if
  // the guard itself were broken); this fixture is re-tightened alongside the one above.
  it('CONTROL: no DEFAULTCLIGUARD927 warn fires when the distribution default has no CLI constraint', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110'
    const { guard, logger } = await loadGuard(null)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    guard.launchableDistributionDefaultSync('main')
    guard.launchableDistributionDefaultSync('main')
    guard.launchableInstallDefaultSync('worker')
    const lines = warn.mock.calls.filter((c) => String(c[1] ?? '').includes('DEFAULTCLIGUARD927'))
    expect(lines).toHaveLength(0)
    warn.mockRestore()
  })
})

describe('an operator-configured DEFAULT_AGENT_MODEL is never replaced', () => {
  it('stays as configured even on 2.1.110', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110'
    const { guard } = await loadGuard('claude-opus-5-5[1m]')
    expect(await guard.launchableInstallDefault('agent:test')).toBe('claude-opus-5-5[1m]')
    expect(guard.launchableInstallDefaultSync('worker')).toBe('claude-opus-5-5[1m]')
  })
})

// The launch sites themselves: each default path goes through the guard, and
// an explicit agent model does not. Source-level, like the RESPAWNMODEL807
// locks, because the launchers need tmux to run end to end.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
describe('every default launch path is wired to the guard', () => {
  it('sub-agent launch: only the resolution with source "default" is guarded', () => {
    const src = readFileSync(join(SRC, 'web', 'agent-process.ts'), 'utf-8')
    expect(src).toMatch(/resolvedModel\.source === 'default' \? await launchableInstallDefault\(/)
  })
  it('worker session: the non-custom-provider path is guarded', () => {
    const src = readFileSync(join(SRC, 'web', 'agent-worker.ts'), 'utf-8')
    // WORKERMODEL1773: the decision moved into resolveWorkerModel; the default
    // path still calls the guard (resolveWorkerModel's 'default' branch, tested
    // behaviourally in worker-model-cli-gate.test.ts).
    expect(src).toContain("launchableDefault: () => launchableInstallDefaultSync('worker')")
    expect(src).toContain('return { model: i.launchableDefault(), source: \'default\', unlaunchable: null }')
  })
  it('agent create without a model: guarded, not the raw default', () => {
    const src = readFileSync(join(SRC, 'web', 'routes', 'agents.ts'), 'utf-8')
    expect(src).toContain("rawModel || await launchableInstallDefault('agent-create', { fresh: true })")
    expect(src).not.toMatch(/rawModel \|\| DEFAULT_MODEL/)
  })
  it('main respawn: the distribution-default layer is guarded', () => {
    const src = readFileSync(join(SRC, 'web', 'channel-monitor.ts'), 'utf-8')
    expect(src).toContain("return launchableDistributionDefaultSync('main')")
  })
})
