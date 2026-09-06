import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Card 404e8dd6 (pair-BE 75f3c77d). On a day when Ollama is masked (gpu-crashloop-guard) the Local
// LLM page used to show a toast and an EMPTY model list, so the per-model switches (5dd4a211)
// were invisible exactly when the operator wanted them. Contract-first against the re-scoped
// GET /api/local-llm/models: `{ ollamaUp: boolean, models: [...] }` where the list falls back to
// the known models of local-llm-model-state.json when Ollama is down. String-contract tests in
// the house idiom: read the sources, assert the fragments.

const WEB = join(__dirname, '..', '..', 'web')
const JS = readFileSync(join(WEB, 'app-local-llm.js'), 'utf8')
const CSS = readFileSync(join(WEB, 'style.css'), 'utf8')
const HU = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')

const NEW_KEYS = ['localLlm.models.ollama_down_banner']

function fn(from: string, to: string): string {
  const a = JS.indexOf(from)
  const b = JS.indexOf(to, a)
  expect(a, from).toBeGreaterThan(-1)
  expect(b, to).toBeGreaterThan(a)
  return JS.slice(a, b)
}

describe('local-llm Ollama-down fallback: JS contract (card 404e8dd6)', () => {
  it('keeps the flags answer as the fallback list and reads its ollamaUp field (null when absent)', () => {
    const loader = fn('async function llmLoadModelFlags()', 'function llmToggleButtonHtml(')
    expect(loader).toContain("_llmModelList = list.filter(m => m && typeof m.name === 'string')")
    expect(loader).toContain("_llmOllamaUp = typeof d.ollamaUp === 'boolean' ? d.ollamaUp : null")
    // every failure path clears the list: a stale list must not outlive the answer it came from
    expect(loader.match(/_llmModelList = \[\]/g)?.length).toBe(2)
  })

  it('draws the switch through ONE helper, used by the live rows and the fallback rows alike', () => {
    expect(JS).toContain('function llmToggleButtonHtml(name, disabled)')
    const helper = fn('function llmToggleButtonHtml(', 'function llmFallbackModelRowHtml(')
    expect(helper).toContain('aria-pressed="${disabled ? \'false\' : \'true\'}"')
    expect(helper).toContain('data-enable="${disabled ? \'1\' : \'0\'}"')
    expect(helper).toContain('class="llm-model-toggle ${disabled ? \'off\' : \'on\'}"')
    const liveRows = fn('// Models list', "'models', 'llm-model-row')")
    expect(liveRows).toContain('const toggleHtml = hasFlags ? llmToggleButtonHtml(m.name, disabled)')
    const fallback = fn('function llmFallbackModelRowHtml(', 'async function llmRefreshStatus()')
    expect(fallback).toContain('llmToggleButtonHtml(m.name, disabled)')
  })

  it('when Ollama is down and the fallback list is non-empty: banner + rows + wired switches, else the old placeholder', () => {
    const branch = fn('if (!d.ollama_up) {', '} else if (models.length === 0) {')
    expect(branch).toContain('if (_llmModelList.length > 0)')
    expect(branch).toContain('class="llm-models-banner" role="status"')
    expect(branch).toContain("t('localLlm.models.ollama_down_banner')")
    expect(branch).toContain('_llmModelList.map(llmFallbackModelRowHtml)')
    expect(branch).toContain("modelsEl.querySelectorAll('.llm-model-toggle').forEach(b =>")
    expect(branch).toContain("llmToggleModel(b.dataset.model, b.dataset.enable === '1', b)")
    expect(branch).toContain("t('localLlm.status.down')")
  })

  it('a fallback row shows the measured benchmark only (tok/s @ ctx) and NO Use/Update control (rule 9)', () => {
    const fallback = fn('function llmFallbackModelRowHtml(', 'async function llmRefreshStatus()')
    // the live check caught a mutant that substituted a made-up benchmark here; pin the null too
    expect(fallback).toContain("typeof m.benchmark.tokPerSec === 'number' ? m.benchmark : null")
    expect(fallback).toContain("typeof b.ctx === 'number'")
    expect(fallback).toContain("t('localLlm.rec.tps_unmeasured')")
    expect(fallback).toContain("t('localLlm.models.disabled_badge')")
    expect(fallback).not.toContain('llm-use-btn')
    expect(fallback).not.toContain('llm-update-btn')
    expect(fallback).toContain('llm-model-row-offline')
  })

  it('a failed switch still speaks and re-enables the button (retry), unchanged from 5dd4a211', () => {
    const toggle = fn('async function llmToggleModel(', 'async function llmRefreshStatus()')
    expect(toggle).toContain("showToast(t('localLlm.models.toggle.error'), 'error')")
    expect(toggle).toContain("btn.disabled = false; btn.removeAttribute('aria-busy')")
  })
})

describe('local-llm Ollama-down fallback: CSS (rule 13)', () => {
  it('styles the banner with tokens and marks offline rows', () => {
    const banner = CSS.slice(CSS.indexOf('.llm-models-banner {'), CSS.indexOf('.llm-model-row-offline'))
    expect(banner).toContain('var(--warning')
    expect(banner).toContain('var(--radius-sm)')
    expect(CSS).toContain('.llm-model-row-offline { border-style: dashed; }')
  })

  it('the switch keeps its 44px target on the fallback rows too (same class, same rule)', () => {
    const toggle = CSS.slice(CSS.indexOf('.llm-model-toggle {'), CSS.indexOf('.llm-model-toggle.on'))
    expect(toggle).toContain('min-height: 44px')
    expect(toggle).toContain('min-width: 44px')
  })
})

describe('local-llm Ollama-down fallback: i18n parity', () => {
  for (const key of NEW_KEYS) {
    it(`hu.js and en.js both define ${key}`, () => {
      expect(HU).toContain(`'${key}':`)
      expect(EN).toContain(`'${key}':`)
    })
  }
  it('the banner text names the two facts the operator needs: switches work, activation waits', () => {
    const hu = /'localLlm\.models\.ollama_down_banner': '([^']+)'/.exec(HU)?.[1] ?? ''
    expect(hu).toMatch(/kapcsolók működnek/)
    expect(hu).toMatch(/aktiválás/i)
    const en = /'localLlm\.models\.ollama_down_banner': '([^']+)'/.exec(EN)?.[1] ?? ''
    expect(en).toMatch(/switches work/)
    expect(en).toMatch(/activation/i)
  })
})
