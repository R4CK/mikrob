// String-contract guard for card 29b68fba (Cybersec LOW/INFO, a05c39c9 gate): the installed-
// models "Használd" button used to POST straight to /api/local-llm/model with its own inline
// handler (llmSwapModel) and just toast a raw 403 -- but that endpoint is the SAME trust-gated
// resource the Recommendations "Use" button hits (card fa8959cd/eb843c46's two-door fix), so an
// untrusted-publisher model already sitting in the installed list hit the confirm-required
// message with no control to type the confirmation into (rule 12). Follows the house idiom (see
// local-llm-catalog-ui-wiring.test.ts): app.js read as a string, asserted against short,
// formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_CORE = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const LLM_MODULE = readFileSync(join(__dirname, '../../web/app-local-llm.js'), 'utf-8')
const APP = APP_CORE + '\n' + LLM_MODULE

function fnBody(source: string, startMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nfunction ', start + startMarker.length)
  const nextAsyncFn = source.indexOf('\nasync function ', start + startMarker.length)
  const candidates = [nextFn, nextAsyncFn].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + 5000
  return source.slice(start, end)
}

describe('installed-models "Használd" button routes through the trust gate', () => {
  it('llmSwapModel no longer exists -- it is not a second copy of the activation flow', () => {
    expect(APP).not.toContain('async function llmSwapModel')
    expect(APP).not.toMatch(/\bllmSwapModel\(/)
  })

  it('the .llm-use-btn click handler calls llmActivateModelClick, the same function the Recommendations "Use" button uses', () => {
    const idx = APP.indexOf("modelsEl.querySelectorAll('.llm-use-btn')")
    expect(idx).toBeGreaterThan(-1)
    const slice = APP.slice(idx, idx + 200)
    expect(slice).toContain('llmActivateModelClick(b.dataset.model, b)')
  })

  it('an untrusted-publisher model reaches the SAME confirm modal from this entry point (shared code, not a parallel implementation)', () => {
    const body = fnBody(APP, 'async function llmActivateModelClick(model, btn)')
    expect(body).toContain("status === 403 && data.code === 'publisher_not_trusted' && data.requiresConfirmation")
    expect(body).toContain('openLlmTrustConfirm(model, data, btn)')
  })

  it('a successful activation still shows the confirmation toast (moved into the shared function, not lost)', () => {
    const body = fnBody(APP, 'async function llmActivateModelClick(model, btn)')
    expect(body).toContain("t('localLlm.models.swapped', { model })")
  })
})

describe('llmTile: documented caller-escaping contract (Cybersec LOW/INFO, card 29b68fba)', () => {
  it('states the contract directly above the function -- caller must escape, not the tile itself', () => {
    const idx = APP.indexOf('function llmTile(label, value, kind, note, role)')
    expect(idx).toBeGreaterThan(-1)
    const before = APP.slice(Math.max(0, idx - 600), idx)
    expect(before).toMatch(/CALLER MUST ESCAPE/)
  })

  it('every current call site passes i18n text, escapeHtml()-wrapped values, or numbers -- never raw server strings', () => {
    // Spot-check the two call sites that previously carried raw-looking dynamic data
    // (active_model / embed_model / gpu.name) -- they must go through escapeHtml.
    const statusBody = fnBody(APP, 'async function llmRefreshStatus()')
    expect(statusBody).toContain('escapeHtml(d.active_model)')
    expect(statusBody).toContain('escapeHtml(d.embed_model)')
    expect(statusBody).toContain('escapeHtml(d.gpu.name)')
  })
})
