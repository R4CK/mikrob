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

  it('an empty catalogue (0 models fitting this GPU) gets its own message, not the generic load-error text', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain("t('localLlm.rec.empty')")
  })

  it('a failed fetch shows the localized load-error text, never a raw exception (rule 12)', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain("t('localLlm.rec.load_error')")
    expect(body).not.toMatch(/err\.message/)
  })

  it('reads the catalogue envelope warnings[] instead of ignoring it (card 335a6a62, Cybered 4117f98e finding)', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain('Array.isArray(d.warnings)')
    expect(body).toContain('llm-rec-warnings')
    expect(body).toContain('llm-rec-warning')
  })

  it('a specific warning (e.g. unsupported catalogue schema, run ./update.sh) shows even when models[] is empty', () => {
    // Before this fix, models.length === 0 short-circuited straight to the generic empty text
    // with no way for the operator to learn the catalogue was stale/unreadable rather than genuinely
    // empty. warningsHtml must be prepended on BOTH branches (empty and populated).
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    const emptyBranch = body.slice(body.indexOf('if (models.length === 0) {'), body.indexOf("t('localLlm.rec.empty')"))
    expect(emptyBranch).toContain('warningsHtml')
    expect(body).toContain('el.innerHTML = warningsHtml + _llmRecGroups.map(')
  })

  it('groups by repo, not one flat row per quant (card 88ea5050, Peti direktiva)', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toContain('_llmRecGroups = llmGroupRecModels(models)')
    const groupFn = fnBody(APP, 'function llmGroupRecModels(models)')
    expect(groupFn).toContain('m.repo || m.id')
  })

  it('only the FIRST group (the sorted list\'s own top offer) is marked recommended', () => {
    const body = fnBody(APP, 'async function llmRefreshRecs()')
    expect(body).toMatch(/_llmRecGroups\.map\(\(variants, i\) => llmRecGroupHtml\(variants, i, i === 0\)\)/)
  })
})

describe('llmRecGroupHtml / llmRecVariantBodyHtml (per-group card + variant swap)', () => {
  it('never truncates installRef -- the full string is both the pull target and the displayed ref', () => {
    const actionBody = fnBody(APP, 'function llmRecActionHtml(m)')
    expect(actionBody).toContain('data-model="${escapeHtml(m.installRef)}"')
    const variantBody = fnBody(APP, 'function llmRecVariantBodyHtml(m)')
    expect(variantBody).toContain('class="llm-rec-installref">${escapeHtml(m.installRef || \'\')}')
  })

  it('SECURITY: the digest shown is ONLY an 8-char prefix of parts[0].sha256, never the full hash or other fields', () => {
    const body = fnBody(APP, 'function llmRecVariantBodyHtml(m)')
    expect(body).toContain('m.parts[0].sha256).slice(0, 8)')
  })

  it('shows measured throughput, or an explicit not-measured state -- never a guessed/zero value (card 88ea5050)', () => {
    // tokensPerSecond did not render anywhere before this card (MikroB/backend2 finding). The
    // producer's own contract (store/llm-catalog.py) is "null unless measured"; the UI must not
    // collapse that null into 0 or omit the field.
    const body = fnBody(APP, 'function llmRecTpsHtml(m)')
    expect(body).toContain("typeof m.tokensPerSecond === 'number'")
    expect(body).toContain("t('localLlm.rec.tps_unmeasured')")
    expect(body).not.toMatch(/tokensPerSecond \|\| 0/)
    const usedInBody = fnBody(APP, 'function llmRecVariantBodyHtml(m)')
    expect(usedInBody).toContain('llmRecTpsHtml(m)')
  })

  it('three distinct action states -- active (badge, no button) / installed-not-active (activate) / not installed (pull)', () => {
    const body = fnBody(APP, 'function llmRecActionHtml(m)')
    expect(body).toContain('if (isActive) return')
    expect(body).toContain("t('localLlm.models.active')")
    expect(body).toContain('if (isInstalled) return')
    expect(body).toContain('llm-rec-use-btn')
    expect(body).toContain('llm-rec-pull-btn')
  })

  it('trust and download count are repo-level facts, shown once in the group header (not per variant)', () => {
    const groupBody = fnBody(APP, 'function llmRecGroupHtml(variants, groupIdx, isTop)')
    expect(groupBody).toMatch(/llm-trust-badge \$\{head\.trusted \? 'trusted' : 'unverified'\}/)
    expect(groupBody).toContain("t(head.trusted ? 'localLlm.rec.trust.trusted' : 'localLlm.rec.trust.unverified')")
    const variantBody = fnBody(APP, 'function llmRecVariantBodyHtml(m)')
    expect(variantBody).not.toContain('llm-trust-badge')
  })

  it('the top group gets the recommended badge; a group with >1 variant gets a quant <select>', () => {
    const body = fnBody(APP, 'function llmRecGroupHtml(variants, groupIdx, isTop)')
    expect(body).toContain('isTop ?')
    expect(body).toContain('llm-rec-badge-star')
    expect(body).toContain("t('localLlm.rec.recommended')")
    expect(body).toContain('variants.length > 1')
    expect(body).toContain('llm-rec-variant-select')
  })

  it('the pull button reuses the EXISTING llmStartPull (install-trigger + progress), not new machinery', () => {
    const body = fnBody(APP, 'function llmWireRecActionButtons(root)')
    expect(body).toContain('llmStartPull(b.dataset.model)')
  })

  it('the use button routes through the explicit activation gate, not an inline fetch here', () => {
    // The actual POST /api/local-llm/model call now lives in llmPostActivateModel, shared by
    // the plain-click path and the publisher-trust confirm retry (card fa8959cd) -- see
    // local-llm-trust-confirm-ui-wiring.test.ts for the full activation + trust-gate contract.
    const body = fnBody(APP, 'function llmWireRecActionButtons(root)')
    expect(body).toContain('llmActivateModelClick(b.dataset.model, b)')
    expect(body).not.toMatch(/fetch\('\/api\/local-llm\/model'/)
  })

  it('activation is still its own explicit POST /api/local-llm/model -- a download never silently becomes active', () => {
    const body = fnBody(APP, 'async function llmPostActivateModel(model, iTrust)')
    expect(body).toContain("fetch('/api/local-llm/model'")
    expect(body).toContain("method: 'POST'")
    expect(body).toContain('JSON.stringify(iTrust ? { model, iTrust } : { model })')
  })

  it('swapping the quant <select> re-renders only that group\'s body from already-fetched data, no re-fetch', () => {
    const body = fnBody(APP, 'function llmRecSwapVariant(selectEl)')
    expect(body).not.toMatch(/fetch\(/)
    expect(body).toContain('llmRecVariantBodyHtml(variant)')
    expect(body).toContain('llmWireRecActionButtons(bodyEl)')
    const wiring = fnBody(APP, 'async function llmRefreshRecs()')
    expect(wiring).toContain("sel.addEventListener('change', () => llmRecSwapVariant(sel))")
  })
})

describe('model catalogue i18n (HU+EN parity, rule 12)', () => {
  const KEYS = [
    'localLlm.rec.gpu_hint', 'localLlm.rec.gpu_unknown', 'localLlm.rec.cpu_only_hint',
    'localLlm.rec.stale_banner', 'localLlm.rec.empty', 'localLlm.rec.use_btn',
    'localLlm.rec.activate_error', 'localLlm.rec.trust.trusted', 'localLlm.rec.trust.trusted_tip',
    'localLlm.rec.trust.unverified', 'localLlm.rec.trust.unverified_tip',
    'localLlm.rec.downloads_tip', 'localLlm.rec.digest_tip',
    'localLlm.rec.recommended', 'localLlm.rec.recommended_tip', 'localLlm.rec.variant_select_aria',
    'localLlm.rec.tps_tip', 'localLlm.rec.tps_unmeasured', 'localLlm.rec.tps_unmeasured_tip',
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

  it('[hidden] actually hides the stale banner (regression: unconditional display:flex silently wins over [hidden])', () => {
    // Same class of bug hidden-attribute-css-contract.test.ts exists to catch: an author rule
    // with display:flex and no [hidden] override beats the UA stylesheet's [hidden]{display:
    // none} at equal specificity, so toggling staleBanner.hidden would have no visible effect.
    const idx = CSS.indexOf('.llm-rec-stale-banner {')
    expect(idx).toBeGreaterThan(-1)
    const block = CSS.slice(idx, CSS.indexOf('}', idx) + 1)
    expect(block).toMatch(/display\s*:\s*flex/)
    expect(CSS).toMatch(/\.llm-rec-stale-banner\[hidden\]\s*\{\s*display\s*:\s*none/)
  })

  it('defines the warnings banner, visually distinct from the stale banner (card 335a6a62)', () => {
    expect(CSS).toContain('.llm-rec-warnings {')
    expect(CSS).toContain('.llm-rec-warning {')
  })

  it('defines the group card, the recommended-group accent, and the entrance animation (card 88ea5050)', () => {
    expect(CSS).toContain('.llm-rec-group {')
    expect(CSS).toContain('.llm-rec-group.recommended {')
    expect(CSS).toContain('.llm-rec-badge-star {')
    expect(CSS).toMatch(/@keyframes llm-rec-group-in/)
  })

  it('the entrance animation is disabled under prefers-reduced-motion', () => {
    // Scoped from OUR keyframe forward -- prefers-reduced-motion appears more than once in this
    // stylesheet (e.g. the agent-card-running indicator), so an unscoped search would match
    // whichever query comes first in the file, not necessarily ours.
    const keyframeIdx = CSS.indexOf('@keyframes llm-rec-group-in')
    expect(keyframeIdx).toBeGreaterThan(-1)
    const mediaIdx = CSS.indexOf('@media (prefers-reduced-motion: reduce)', keyframeIdx)
    expect(mediaIdx).toBeGreaterThan(-1)
    const block = CSS.slice(mediaIdx, mediaIdx + 200)
    expect(block).toMatch(/\.llm-rec-group\s*\{\s*animation:\s*none/)
  })

  it('the quant <select> keeps the 44px touch target (rule 13) by reusing the shared .llm-select base', () => {
    expect(CSS).toContain('.llm-rec-variant-select')
    const idx = CSS.indexOf('.llm-select {')
    const block = CSS.slice(idx, idx + 200)
    expect(block).toMatch(/min-height\s*:\s*44px/)
  })

  it('the active-model row keeps its accent treatment even nested inside a group card', () => {
    expect(CSS).toContain('.llm-rec-group-body .llm-model-row.active {')
  })
})
