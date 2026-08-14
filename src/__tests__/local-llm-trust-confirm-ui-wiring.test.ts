// String-contract guard for the publisher-trust confirmation modal (card fa8959cd, paired with
// backend gate eb843c46's POST /api/local-llm/model 403 publisher_not_trusted contract). Follows
// the house idiom (see local-llm-catalog-ui-wiring.test.ts): app.js is a single global script
// with no module boundary, so the frontend files are read as strings and asserted against short,
// formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

function fnBody(source: string, startMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nfunction ', start + startMarker.length)
  const nextAsyncFn = source.indexOf('\nasync function ', start + startMarker.length)
  const nextIife = source.indexOf('\n;(function ', start + startMarker.length)
  const candidates = [nextFn, nextAsyncFn, nextIife].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + 4000
  return source.slice(start, end)
}

describe('trust-confirm modal shell (index.html)', () => {
  it('is a proper accessible dialog, hidden by default', () => {
    const idx = HTML.indexOf('id="llmTrustConfirmOverlay"')
    expect(idx).toBeGreaterThan(-1)
    const tagStart = HTML.lastIndexOf('<div', idx)
    const tag = HTML.slice(tagStart, HTML.indexOf('>', idx) + 1)
    expect(tag).toContain('hidden')
    expect(tag).toContain('role="dialog"')
    expect(tag).toContain('aria-modal="true"')
    expect(tag).toContain('aria-labelledby="llmTrustConfirmTitle"')
  })

  it('has the basis container, a required text input, and an inline (not toast-only) error slot', () => {
    expect(HTML).toContain('id="llmTrustConfirmBasis"')
    expect(HTML).toContain('id="llmTrustConfirmInput"')
    expect(HTML).toContain('id="llmTrustConfirmInputLabel"')
    const errIdx = HTML.indexOf('id="llmTrustConfirmError"')
    expect(errIdx).toBeGreaterThan(-1)
    const tagStart = HTML.lastIndexOf('<p', errIdx)
    const tag = HTML.slice(tagStart, HTML.indexOf('>', errIdx) + 1)
    expect(tag).toContain('hidden')
    expect(tag).toContain('role="alert"')
  })

  it('reuses the existing modal-close/cancel/submit button convention (btn-text/btn-loading)', () => {
    expect(HTML).toContain('id="llmTrustConfirmClose"')
    expect(HTML).toContain('id="llmTrustConfirmCancel"')
    expect(HTML).toContain('id="llmTrustConfirmSubmit"')
    const submitIdx = HTML.indexOf('id="llmTrustConfirmSubmit"')
    const slice = HTML.slice(submitIdx, submitIdx + 300)
    expect(slice).toContain('btn-text')
    expect(slice).toContain('btn-loading')
  })
})

describe('llm-rec-use-btn routes through the trust gate (llmActivateModelClick)', () => {
  it('the use button click handler calls llmActivateModelClick, not an inline fetch', () => {
    const body = fnBody(APP, 'el.querySelectorAll(\'.llm-rec-use-btn\')')
    expect(body).toContain('llmActivateModelClick(b.dataset.model, b)')
  })

  it('POSTs without iTrust on the first attempt', () => {
    const body = fnBody(APP, 'async function llmActivateModelClick(model, btn)')
    expect(body).toContain('llmPostActivateModel(model)')
  })

  it('a plain success refreshes the list and status, same as before', () => {
    const body = fnBody(APP, 'async function llmActivateModelClick(model, btn)')
    expect(body).toContain('await llmRefreshRecs()')
    expect(body).toContain('await llmRefreshStatus()')
  })

  it('403 publisher_not_trusted opens the confirm modal instead of a toast', () => {
    const body = fnBody(APP, 'async function llmActivateModelClick(model, btn)')
    expect(body).toMatch(/status === 403 && data\.code === 'publisher_not_trusted' && data\.requiresConfirmation/)
    expect(body).toContain('openLlmTrustConfirm(model, data, btn)')
  })

  it('every other failure (digest mismatch, not installed, ollama down) shows the curated backend message, never a generic-only string', () => {
    const body = fnBody(APP, 'async function llmActivateModelClick(model, btn)')
    expect(body).toContain("showToast(data.error || t('localLlm.rec.activate_error'))")
  })
})

describe('openLlmTrustConfirm renders the full decision basis', () => {
  it('shows owner and downloads from the response, not invented values', () => {
    const body = fnBody(APP, 'function openLlmTrustConfirm(model, data, useBtn)')
    expect(body).toContain('basis.owner')
    expect(body).toContain('basis.downloads')
  })

  it('SECURITY: renders the FULL sha256 per part, never a truncated/sliced prefix', () => {
    const body = fnBody(APP, 'function openLlmTrustConfirm(model, data, useBtn)')
    expect(body).toContain('p.sha256')
    expect(body).not.toMatch(/sha256\)?\.slice\(/)
  })

  it('the modal description reuses the backend-curated error text (rule 12), not a client-invented one', () => {
    const body = fnBody(APP, 'function openLlmTrustConfirm(model, data, useBtn)')
    expect(body).toContain("document.getElementById('llmTrustConfirmDesc').textContent = data.error")
  })

  it('resets the input, clears any stale error, and opens by clearing hidden', () => {
    const body = fnBody(APP, 'function openLlmTrustConfirm(model, data, useBtn)')
    expect(body).toContain("input.value = ''")
    expect(body).toContain('errEl.hidden = true')
    expect(body).toContain("document.getElementById('llmTrustConfirmOverlay').hidden = false")
  })

  it('remembers which button to re-enable on cancel, keyed per-open (not a single global stale ref)', () => {
    const body = fnBody(APP, 'function openLlmTrustConfirm(model, data, useBtn)')
    expect(body).toContain('_llmTrustConfirmCtx = { model, useBtn }')
  })
})

describe('llmSubmitTrustConfirm (the confirmation itself)', () => {
  it('requires a non-empty answer before ever calling the API', () => {
    const body = fnBody(APP, 'async function llmSubmitTrustConfirm()')
    expect(body).toMatch(/if \(!answer\) \{/)
    expect(body).toContain("t('localLlm.trustConfirm.empty_error')")
  })

  it('sends the typed answer as iTrust, mirroring the CLI --i-trust contract', () => {
    const body = fnBody(APP, 'async function llmSubmitTrustConfirm()')
    expect(body).toContain('llmPostActivateModel(model, answer)')
  })

  it('success closes the modal and refreshes the list, same as the plain-success path', () => {
    const body = fnBody(APP, 'async function llmSubmitTrustConfirm()')
    expect(body).toContain('closeLlmTrustConfirm()')
    expect(body).toContain('await llmRefreshRecs()')
    expect(body).toContain('await llmRefreshStatus()')
  })

  it('a wrong answer (403 again) shows an inline error and does NOT close the modal', () => {
    const body = fnBody(APP, 'async function llmSubmitTrustConfirm()')
    const wrongAnswerBranch = body.slice(
      body.indexOf("status === 403 && data.code === 'publisher_not_trusted'"),
      body.indexOf("status === 403 && data.code === 'publisher_not_trusted'") + 300,
    )
    expect(wrongAnswerBranch).toContain("t('localLlm.trustConfirm.wrong_answer_error')")
    expect(wrongAnswerBranch).toContain('errEl.hidden = false')
    expect(wrongAnswerBranch).not.toContain('closeLlmTrustConfirm()')
  })

  it('SECURITY: a digest mismatch has NO override path -- it closes and reports, it never retries as if confirmable', () => {
    const body = fnBody(APP, 'async function llmSubmitTrustConfirm()')
    // Isolate strictly the fallthrough branch (after the wrong-answer 403 `if` block, before the
    // `catch`) -- NOT the whole tail of the function, which would also contain the catch block's
    // own independent closeLlmTrustConfirm() call and let a missing call in THIS branch pass
    // vacuously.
    const wrongAnswerIfEnd = body.indexOf("data.code === 'publisher_not_trusted') {")
    const fallthroughStart = body.indexOf('\n    }', wrongAnswerIfEnd) + '\n    }'.length
    const fallthroughEnd = body.indexOf('} catch {', fallthroughStart)
    expect(fallthroughStart).toBeGreaterThan(wrongAnswerIfEnd)
    expect(fallthroughEnd).toBeGreaterThan(fallthroughStart)
    const fallthrough = body.slice(fallthroughStart, fallthroughEnd)
    expect(fallthrough).toContain('closeLlmTrustConfirm()')
    expect(fallthrough).toContain('showToast(data.error')
  })

  it('shows a loading state on the submit button while the request is in flight', () => {
    const body = fnBody(APP, 'async function llmSubmitTrustConfirm()')
    expect(body).toContain("submitBtn.querySelector('.btn-text').hidden = true")
    expect(body).toContain("submitBtn.querySelector('.btn-loading').hidden = false")
    expect(body).toContain('finally')
  })
})

describe('modal dismissal (close/cancel/click-outside/Escape) re-enables the original button', () => {
  it('closeLlmTrustConfirm hides the overlay and re-enables the triggering use-btn', () => {
    const body = fnBody(APP, 'function closeLlmTrustConfirm()')
    expect(body).toContain("document.getElementById('llmTrustConfirmOverlay').hidden = true")
    expect(body).toContain('_llmTrustConfirmCtx.useBtn.disabled = false')
    expect(body).toContain('_llmTrustConfirmCtx = null')
  })

  it('wires close button, cancel button, click-outside, and Escape, all to the same cancel path', () => {
    const body = fnBody(APP, 'function initLlmTrustConfirmModal()')
    expect(body).toContain("getElementById('llmTrustConfirmClose').addEventListener('click', cancel)")
    expect(body).toContain("getElementById('llmTrustConfirmCancel').addEventListener('click', cancel)")
    expect(body).toMatch(/llmTrustConfirmOverlay'\)\.addEventListener\('click', \(e\) => \{ if \(e\.target === e\.currentTarget\) cancel\(\) \}\)/)
    expect(body).toMatch(/e\.key === 'Escape' && !document\.getElementById\('llmTrustConfirmOverlay'\)\.hidden/)
  })

  it('Enter in the input submits without requiring a mouse click on the button', () => {
    const body = fnBody(APP, 'function initLlmTrustConfirmModal()')
    expect(body).toContain("e.key === 'Enter'")
    expect(body).toContain('llmSubmitTrustConfirm()')
  })
})

describe('trust-confirm i18n (HU+EN parity, rule 12)', () => {
  const KEYS = [
    'localLlm.trustConfirm.title', 'localLlm.trustConfirm.submit_btn', 'localLlm.trustConfirm.input_label',
    'localLlm.trustConfirm.basis_owner', 'localLlm.trustConfirm.basis_downloads',
    'localLlm.trustConfirm.basis_downloads_unknown', 'localLlm.trustConfirm.basis_parts',
    'localLlm.trustConfirm.digest_missing', 'localLlm.trustConfirm.empty_error',
    'localLlm.trustConfirm.wrong_answer_error',
  ]
  it.each(KEYS)('%s exists in hu.js', (key) => {
    expect(HU).toContain(`'${key}':`)
  })
  it.each(KEYS)('%s exists in en.js', (key) => {
    expect(EN).toContain(`'${key}':`)
  })
})

describe('trust-confirm CSS', () => {
  it('the error paragraph sets no `display` -- it relies on [hidden]/default block, avoiding the recurring cascade trap', () => {
    const idx = CSS.indexOf('.llm-trust-confirm-error {')
    expect(idx).toBeGreaterThan(-1)
    const block = CSS.slice(idx, CSS.indexOf('}', idx) + 1)
    expect(block).not.toMatch(/display\s*:/)
  })

  it('the digest lines wrap instead of forcing horizontal scroll (rule 13)', () => {
    const idx = CSS.indexOf('.llm-trust-confirm-digest {')
    const body = CSS.slice(idx, idx + 200)
    expect(body).toContain('overflow-wrap: anywhere;')
  })
})
