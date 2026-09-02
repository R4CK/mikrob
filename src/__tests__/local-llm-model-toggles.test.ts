import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Card 5dd4a211 (pair-BE 5d151091): per-model enable/disable switches on the Local LLM page,
// built contract-first against GET/POST /api/local-llm/models[...] with a 404 -> "no switches"
// fallback. String-contract tests in the house idiom: read the sources, assert the fragments.

const WEB = join(__dirname, '..', '..', 'web')
const JS = readFileSync(join(WEB, 'app-local-llm.js'), 'utf8')
const CSS = readFileSync(join(WEB, 'style.css'), 'utf8')
const HU = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')

const NEW_KEYS = [
  'localLlm.models.disabled_badge',
  'localLlm.models.toggle.enable',
  'localLlm.models.toggle.disable',
  'localLlm.models.toggle.enable_tip',
  'localLlm.models.toggle.disable_tip',
  'localLlm.models.toggle.saved_on',
  'localLlm.models.toggle.saved_off',
  'localLlm.models.toggle.error',
  'localLlm.models.toggle.load_error',
  'localLlm.models.toggle.use_blocked',
  'localLlm.status.active_disabled',
]

describe('local-llm model toggles: JS contract (card 5dd4a211)', () => {
  it('loads the flags from GET /api/local-llm/models and treats 404 as "feature absent" (no switches)', () => {
    expect(JS).toContain('async function llmLoadModelFlags()')
    expect(JS).toContain("fetch('/api/local-llm/models')")
    const fn = JS.slice(JS.indexOf('async function llmLoadModelFlags()'), JS.indexOf('function llmModelDisabled('))
    expect(fn).toContain('res.status === 404')
    expect(fn).toContain('_llmModelFlags = null; return null')
    // a non-404 failure speaks (rule 12) instead of guessing "enabled"
    expect(fn).toContain("showToast(t('localLlm.models.toggle.load_error'), 'error')")
  })

  it('reads the contract shape: models[].name + enabled (false = disabled), disabledAt optional', () => {
    const fn = JS.slice(JS.indexOf('async function llmLoadModelFlags()'), JS.indexOf('function llmModelDisabled('))
    expect(fn).toContain('Array.isArray(d.models)')
    expect(fn).toContain('enabled: m.enabled !== false')
    expect(fn).toContain('disabledAt: m.disabledAt ?? null')
  })

  it('is fetched together with status + catalog in llmRefreshStatus (one refresh, one repaint)', () => {
    const fn = JS.slice(JS.indexOf('async function llmRefreshStatus()'), JS.indexOf('// Status tiles'))
    expect(fn).toContain("fetch('/api/local-llm/status')")
    expect(fn).toContain('llmLoadModelFlags()')
  })

  it('POSTs to /api/local-llm/models/<encoded name>/enable|disable and re-renders on success', () => {
    const fn = JS.slice(JS.indexOf('async function llmToggleModel('), JS.indexOf('async function llmRefreshStatus()'))
    expect(fn).toContain("'/api/local-llm/models/' + encodeURIComponent(name) + (enable ? '/enable' : '/disable')")
    expect(fn).toContain("method: 'POST'")
    expect(fn).toContain('await llmRefreshStatus()')
    expect(fn).toContain("'localLlm.models.toggle.saved_on' : 'localLlm.models.toggle.saved_off'")
    // failure: toast + the button becomes usable again (never stuck aria-busy)
    expect(fn).toContain("showToast(t('localLlm.models.toggle.error'), 'error')")
    expect(fn).toContain("btn.removeAttribute('aria-busy')")
  })

  it('renders a switch per model ONLY when the flags API answered, with aria-pressed and data-enable', () => {
    const rows = JS.slice(JS.indexOf('// Models list'), JS.indexOf("'models', 'llm-model-row')"))
    expect(rows).toContain('const hasFlags = _llmModelFlags !== null')
    expect(rows).toContain('const toggleHtml = hasFlags')
    expect(rows).toContain('class="llm-model-toggle ${disabled ? \'off\' : \'on\'}"')
    expect(rows).toContain('aria-pressed="${disabled ? \'false\' : \'true\'}"')
    expect(rows).toContain('data-enable="${disabled ? \'1\' : \'0\'}"')
    expect(rows).toContain('${toggleHtml}')
  })

  it('marks a disabled model on its row (class + badge) and blocks "Use" on it', () => {
    const rows = JS.slice(JS.indexOf('// Models list'), JS.indexOf("'models', 'llm-model-row')"))
    expect(rows).toContain("${disabled ? ' disabled' : ''}")
    expect(rows).toContain("t('localLlm.models.disabled_badge')")
    expect(rows).toContain("t('localLlm.models.toggle.use_blocked')")
    expect(rows).toContain('${disabledBadge}')
  })

  it('wires the click of every .llm-model-toggle to llmToggleModel', () => {
    expect(JS).toContain("modelsEl.querySelectorAll('.llm-model-toggle').forEach(b =>")
    expect(JS).toContain("llmToggleModel(b.dataset.model, b.dataset.enable === '1', b)")
  })

  it('the routed (active) model being disabled turns the code-model tile to warn with a named reason', () => {
    const tiles = JS.slice(JS.indexOf('// Status tiles'), JS.indexOf('// Models list'))
    expect(tiles).toContain('const activeDisabled = !!d.active_model && llmModelDisabled(d.active_model)')
    expect(tiles).toContain("activeDisabled ? 'warn'")
    expect(tiles).toContain("t('localLlm.status.active_disabled')")
  })
})

describe('local-llm model toggles: CSS', () => {
  it('defines the row state, the badge and a 44px switch with on/off states (rule 13)', () => {
    expect(CSS).toContain('.llm-model-row.disabled {')
    expect(CSS).toContain('.llm-badge-disabled {')
    const toggle = CSS.slice(CSS.indexOf('.llm-model-toggle {'), CSS.indexOf('.llm-model-toggle.on {'))
    expect(toggle).toContain('min-height: 44px')
    expect(toggle).toContain('min-width: 44px')
    expect(CSS).toContain('.llm-model-toggle.on {')
    expect(CSS).toContain('.llm-model-toggle.off {')
    expect(CSS).toContain('.llm-model-toggle:focus-visible {')
  })
  it('has a phone breakpoint for the actions row', () => {
    const idx = CSS.indexOf('.llm-model-toggle:focus-visible {')
    expect(CSS.slice(idx, idx + 400)).toContain('@media (max-width: 480px)')
  })
  it('uses tokens, not hardcoded colours, for the switch', () => {
    const block = CSS.slice(CSS.indexOf('.llm-model-toggle {'), CSS.indexOf('@media (max-width: 480px) {\n  .llm-model-row .llm-model-actions'))
    expect(block).toContain('var(--success)')
    expect(block).toContain('var(--danger)')
    // a hex literal is allowed only as a var() fallback (house pattern: var(--accent, #6366f1))
    expect(block.replace(/var\([^)]*\)/g, '')).not.toMatch(/#[0-9a-f]{6}/i)
  })
})

describe('local-llm model toggles: i18n parity', () => {
  for (const key of NEW_KEYS) {
    it(`hu.js and en.js both define ${key}`, () => {
      expect(HU).toContain(`'${key}':`)
      expect(EN).toContain(`'${key}':`)
    })
  }
  it('every new key referenced from the JS exists in hu.js', () => {
    // keys appear both as t('k') and as t(cond ? 'k1' : 'k2'): match the literals, not the call
    const refs = [...JS.matchAll(/'(localLlm\.models\.toggle\.[a-z_]+|localLlm\.models\.disabled_badge|localLlm\.status\.active_disabled)'/g)].map((m) => m[1])
    const unique = new Set(refs)
    expect(unique.size).toBe(NEW_KEYS.length)
    for (const r of unique) {
      expect(HU).toContain(`'${r}':`)
      expect(EN).toContain(`'${r}':`)
    }
  })
})
