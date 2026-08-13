// String-contract guard for the GPU-filtered model catalogue UI (card 61a4a85f, EPIC ebc7b4dd
// T4). Follows the house idiom (see agent-hud-ui-wiring.test.ts): app.js is a single global
// script with no module boundary, so the frontend files are read as strings and asserted
// against short, formatting-proof fragments. Pairs with local-llm-catalog-route.test.ts, which
// covers the backend GET /api/local-llm/catalog this UI consumes.
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
  const candidates = [nextFn, nextAsyncFn].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + 5000
  return source.slice(start, end)
}

describe('model catalogue shell (index.html)', () => {
  it('reuses the existing "Ajánlott modellek" section -- no new page or duplicated section', () => {
    expect(HTML).toContain('id="llmRecsGpuHint"')
    expect(HTML).toContain('id="llmRecsStaleBanner"')
    expect(HTML).toContain('id="llmRecs"')
    // the stale banner and GPU hint live inside the SAME llm-section as llmRecs, not a new one
    const secStart = HTML.lastIndexOf('<div class="llm-section">', HTML.indexOf('id="llmRecs"'))
    const secSlice = HTML.slice(secStart, HTML.indexOf('id="llmRecs"'))
    expect(secSlice).toContain('id="llmRecsGpuHint"')
    expect(secSlice).toContain('id="llmRecsStaleBanner"')
  })
})

describe('llmRefreshRecs (GET /api/local-llm/catalog)', () => {
  it('fetches the new catalogue endpoint, not the old static recommendations one', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain("fetch('/api/local-llm/catalog')")
    expect(body).not.toContain('/api/local-llm/model-recommendations')
  })

  it('fetches live status in parallel to know which model is active/installed', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain("fetch('/api/local-llm/status')")
    expect(body).toMatch(/Promise\.all\(\[/)
  })

  it('renders a dynamic GPU hint from the response, with a distinct CPU-only branch', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain("t('localLlm.rec.gpu_hint'")
    expect(body).toContain("t('localLlm.rec.cpu_only_hint')")
    expect(body).toContain('gpu.cpuOnly')
  })

  it('shows the stale banner only when the envelope says stale, hides it otherwise', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain('if (d.stale)')
    expect(body).toContain('staleBanner.hidden = false')
    expect(body).toContain('staleBanner.hidden = true')
  })

  it('never truncates installRef -- the full string is both the pull target and the displayed ref', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain('data-model="${escapeHtml(m.installRef)}"')
    expect(body).toContain('class="llm-rec-installref">${escapeHtml(m.installRef || \'\')}')
  })

  it('renders a trust badge from trusted/trustReason, distinct from the fit-tier badge', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toMatch(/llm-trust-badge \$\{m\.trusted \? 'trusted' : 'unverified'\}/)
    expect(body).toContain("t(m.trusted ? 'localLlm.rec.trust.trusted' : 'localLlm.rec.trust.unverified')")
  })

  it('SECURITY: the digest shown is ONLY an 8-char prefix of parts[0].sha256, never the full hash or other fields', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain('m.parts[0].sha256).slice(0, 8)')
  })

  it('three distinct action states -- active (badge, no button) / installed-not-active (activate) / not installed (pull)', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain('if (isActive) {')
    expect(body).toContain("t('localLlm.models.active')")
    expect(body).toContain('} else if (isInstalled) {')
    expect(body).toContain('llm-rec-use-btn')
    expect(body).toContain('llm-rec-pull-btn')
  })

  it('the pull button reuses the EXISTING llmStartPull (install-trigger + progress), not new machinery', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain('llmStartPull(b.dataset.model)')
  })

  it('activation is its own explicit POST /api/local-llm/model -- a download never silently becomes active', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain("fetch('/api/local-llm/model'")
    expect(body).toContain("method: 'POST'")
    expect(body).toContain('JSON.stringify({ model: b.dataset.model })')
  })

  it('an empty catalogue (0 models fitting this GPU) gets its own message, not the generic load-error text', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain("t('localLlm.rec.empty')")
  })

  it('a failed fetch shows the localized load-error text, never a raw exception (rule 12)', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain("t('localLlm.rec.load_error')")
    expect(body).not.toMatch(/err\.message/)
  })
})

describe('model catalogue i18n (HU+EN parity, rule 12)', () => {
  const KEYS = [
    'localLlm.rec.gpu_hint', 'localLlm.rec.gpu_unknown', 'localLlm.rec.cpu_only_hint',
    'localLlm.rec.stale_banner', 'localLlm.rec.empty', 'localLlm.rec.use_btn',
    'localLlm.rec.activate_error', 'localLlm.rec.trust.trusted', 'localLlm.rec.trust.trusted_tip',
    'localLlm.rec.trust.unverified', 'localLlm.rec.trust.unverified_tip',
    'localLlm.rec.downloads_tip', 'localLlm.rec.digest_tip',
  ]
  it.each(KEYS)('%s exists in hu.js', (key) => {
    expect(HU).toContain(`'${key}':`)
  })
  it.each(KEYS)('%s exists in en.js', (key) => {
    expect(EN).toContain(`'${key}':`)
  })
})

describe('model catalogue CSS', () => {
  it('defines the trust badge (trusted/unverified) and the partial-tier fit badge', () => {
    expect(CSS).toContain('.llm-trust-badge.trusted {')
    expect(CSS).toContain('.llm-trust-badge.unverified {')
    expect(CSS).toContain('.llm-fit-badge.partial {')
  })

  it('the installRef line wraps instead of forcing horizontal scroll (rule 13)', () => {
    const idx = CSS.indexOf('.llm-rec-installref {')
    const body = CSS.slice(idx, idx + 200)
    expect(body).toContain('overflow-wrap: anywhere;')
  })
})
