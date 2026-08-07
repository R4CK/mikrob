import { describe, it, expect } from 'vitest'
import {
  SETTINGS_REGISTRY,
  getSettingDefinition,
  validateSettingValue,
  DISTRIBUTION_DEFAULT_AGENT_MODEL,
} from '../config-registry.js'
import { DEFAULT_AGENT_MODEL } from '../config.js'
import { DEFAULT_MODEL, MODEL_ALIASES, resolveModelId } from '../web/agent-config.js'
import { defaultChainForInstall } from '../web/model-fallback-store.js'
import { DEFAULT_MODEL_CHAIN } from '../model-fallback.js'

// Every assertion here is RELATIONAL, never "the default is <some model id>":
// these tests run both on a fresh checkout (no .env -> distribution default)
// and on a configured install (DEFAULT_AGENT_MODEL set -> that model), and must
// pass in both.
describe('DEFAULT_AGENT_MODEL', () => {
  it('is registered as a restart-scoped, non-secret agents setting', () => {
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')
    expect(def).toBeDefined()
    expect(def!.type).toBe('string')
    expect(def!.module).toBe('agents')
    expect(def!.secret).toBe(false)
    // Consumed at import time by config.ts, so a change cannot hot-reload.
    expect(def!.requiresRestart).toBe(true)
    expect(SETTINGS_REGISTRY.filter((s) => s.key === 'DEFAULT_AGENT_MODEL')).toHaveLength(1)
  })

  it('keeps the registry default and the boot constant on one literal', () => {
    // The whole point of DISTRIBUTION_DEFAULT_AGENT_MODEL living in the
    // zero-import registry module: these two can never drift.
    expect(getSettingDefinition('DEFAULT_AGENT_MODEL')!.default).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('offers the distribution default among the selectable values', () => {
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')!
    expect(def.valueSet).toBeDefined()
    expect(def.valueSet).toContain(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(def.valueSet).toContain('claude-opus-5')
    // The worker drives the `claude` CLI, so only Claude ids are admissible.
    expect(def.valueSet!.every((m) => m.startsWith('claude-'))).toBe(true)
  })

  it('validates against the value set', () => {
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')!
    expect(validateSettingValue(def, 'claude-opus-5')).toEqual({ ok: true, value: 'claude-opus-5' })
    expect(validateSettingValue(def, 'gpt-4').ok).toBe(false)
  })

  it('resolves to the configured value, defaulting to the distribution literal', () => {
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')!
    // Either an operator set it (then it must be a selectable id), or it fell
    // through to the distribution default.
    expect(def.valueSet).toContain(DEFAULT_AGENT_MODEL)
  })
})

describe('agent-config default wiring', () => {
  it('re-exports the install default under the historical DEFAULT_MODEL name', () => {
    expect(DEFAULT_MODEL).toBe(DEFAULT_AGENT_MODEL)
  })

  it("resolves the 'inherit' alias to the install default", () => {
    expect(resolveModelId('inherit')).toBe(DEFAULT_AGENT_MODEL)
  })

  it("resolves the bare 'opus' alias to the ladder primary, whatever it is", () => {
    // Card d041760b (fork divergence from upstream MODELMIGRATE806). Upstream asserts the literal
    // 'claude-opus-5[1m]' here; this fork asserts the RELATIONSHIP instead, because the literal is
    // not the requirement -- the requirement is that the bare alias and the fallback chain's primary
    // never disagree. If they do, whoever writes 'opus' lands on a model the fallback would
    // immediately "revert up" away from, which is the silent trap upstream's own note describes.
    //
    // Written as an invariant so a future product decision to move the ladder (Peti 2026-08-03
    // phased Opus 4.8 out; the live fleet already runs Opus 5) flips both together or fails here --
    // instead of this test having to be edited every time and quietly rubber-stamping a drift.
    expect(MODEL_ALIASES['opus']).toBe(DEFAULT_MODEL_CHAIN[0])
    expect(resolveModelId('opus')).toBe(DEFAULT_MODEL_CHAIN[0])
  })
})

describe('defaultChainForInstall', () => {
  it('puts the install default first so a revert lands on the model actually run', () => {
    expect(defaultChainForInstall()[0]).toBe(DEFAULT_AGENT_MODEL)
  })

  it('never repeats a model, even when the default is already on the ladder', () => {
    const chain = defaultChainForInstall()
    expect(new Set(chain).size).toBe(chain.length)
  })

  it('keeps a usable ladder: primary plus at least one downgrade target', () => {
    const chain = defaultChainForInstall()
    // normalizeModelFallbackConfig() ignores any chain shorter than 2.
    expect(chain.length).toBeGreaterThanOrEqual(2)
    // Every distribution rung except the promoted primary survives, in order.
    expect(chain.slice(1)).toEqual(DEFAULT_MODEL_CHAIN.filter((m) => m !== DEFAULT_AGENT_MODEL))
  })
})
