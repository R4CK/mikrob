// String-contract guard for the side-effect health panel (card 2d9c0bb2, pair-BE 0a527826,
// contract-first per the contract-first-dashboard-widget skill -- pair-BE still planned at
// build time). House idiom: source files read as strings, asserted against short,
// formatting-proof fragments -- no DOM/runtime needed.
//
// Proposed contract (posted as a comment on 0a527826/2d9c0bb2, may be corrected once BE lands):
//   GET /api/health/effects -> { effects: [{ kind, status: 'ok'|'red', consecutiveFailures,
//                                             lastError, lastCheckedAt }] }
// Global banner at the top of <main> (same pattern as #branchDriftBanner/#authSetupBanner):
// visible on every page, not page-scoped. Shows ONLY red entries; healthy state takes no space.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { langHasKey } from './helpers/lang-overlay-key.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_HEALTH = readFileSync(join(__dirname, '../../web/app-health-panel.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')

function fnBody(source: string, startMarker: string, maxLen = 4000): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nasync function ', start + startMarker.length)
  const nextSyncFn = source.indexOf('\nfunction ', start + startMarker.length)
  const candidates = [nextFn, nextSyncFn].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + maxLen
  return source.slice(start, end)
}

describe('health panel: loader (loadSideEffectHealth)', () => {
  const FN = 'async function loadSideEffectHealth('

  it('function is defined in app-health-panel.js', () => {
    expect(APP_HEALTH).toContain(FN)
  })

  it('fetches GET /api/health/effects', () => {
    const body = fnBody(APP_HEALTH, FN)
    expect(body).toContain("fetch('/api/health/effects')")
  })

  it('hides the panel on 404 (pair-BE not landed yet)', () => {
    const body = fnBody(APP_HEALTH, FN)
    expect(body).toContain('res.status === 404')
    expect(body).toContain('panel.hidden = true')
  })

  it('renders ONLY red entries, stays hidden when every effect is ok (healthy = no space)', () => {
    const body = fnBody(APP_HEALTH, FN)
    expect(body).toContain("e.status === 'red'")
    expect(body).toContain('if (red.length === 0)')
  })

  it('shows the kind label and a descriptive error (rule 12), with a speaking fallback when lastError is empty', () => {
    const body = fnBody(APP_HEALTH, FN)
    expect(body).toContain('healthPanelKindLabel(e.kind)')
    expect(body).toContain("e.lastError || t('healthPanel.no_detail')")
  })

  it('a failed health-check READ hides the panel rather than showing a scary banner for our own fetch error', () => {
    const body = fnBody(APP_HEALTH, FN)
    expect(body).toMatch(/catch\s*\{\s*[^}]*panel\.hidden = true/)
  })
})

describe('health panel: kind-label miss detection', () => {
  it('compares against the lookup key itself, not truthiness (card ebe20efe i18n-fallback class)', () => {
    const body = fnBody(APP_HEALTH, 'function healthPanelKindLabel(kind) {')
    expect(body).toContain("const key = 'healthPanel.kind.' + kind")
    expect(body).toContain('const label = t(key)')
    expect(body).toContain('return label !== key ? label : kind')
  })
})

describe('health panel: lifecycle', () => {
  it('polls every 30s, independent of any single page (global, not switchPage-scoped)', () => {
    expect(APP_HEALTH).toContain('const HEALTH_PANEL_POLL_MS = 30000')
    expect(APP_HEALTH).toContain('setInterval(() => void loadSideEffectHealth(), HEALTH_PANEL_POLL_MS)')
  })

  it('starts once at script load, not inside any page-switch branch', () => {
    expect(APP_HEALTH).toContain('startHealthPanelPoll()')
    const pageSwitch = readFileSync(join(__dirname, '../../web/app-page-switch.js'), 'utf-8')
    expect(pageSwitch).not.toContain('startHealthPanelPoll')
    expect(pageSwitch).not.toContain('stopHealthPanelPoll')
  })
})

describe('health panel: HTML', () => {
  it('the panel sits inside <main>, before the first page div, hidden by default', () => {
    const mainIdx = HTML.indexOf('<main>')
    const panelIdx = HTML.indexOf('id="sideEffectHealthPanel"')
    const firstPageIdx = HTML.indexOf('class="page"')
    expect(mainIdx).toBeGreaterThan(-1)
    expect(panelIdx).toBeGreaterThan(mainIdx)
    expect(firstPageIdx).toBeGreaterThan(panelIdx)
    const tag = HTML.slice(HTML.lastIndexOf('<div', panelIdx), HTML.indexOf('>', panelIdx) + 1)
    expect(tag).toContain('hidden')
    expect(tag).toContain('role="alert"')
    expect(tag).toContain('aria-live="polite"')
  })

  it('has a list container for the red rows', () => {
    expect(HTML).toContain('id="sideEffectHealthList"')
  })

  it('does not disturb existing navigation or page markup (additive only, Peti 14288)', () => {
    // Existing global banners are still present, in the same relative order.
    const authIdx = HTML.indexOf('id="authSetupBanner"')
    const panelIdx = HTML.indexOf('id="sideEffectHealthPanel"')
    const driftIdx = HTML.indexOf('id="branchDriftBanner"')
    expect(authIdx).toBeGreaterThan(-1)
    expect(driftIdx).toBeGreaterThan(-1)
    expect(panelIdx).toBeGreaterThan(driftIdx)
    expect(authIdx).toBeGreaterThan(panelIdx)
  })
})

describe('health panel: CSS', () => {
  it('defines the panel shell, the [hidden] override, and the row/kind/error classes', () => {
    expect(CSS).toContain('.side-effect-health-panel {')
    expect(CSS).toContain('.side-effect-health-panel[hidden] { display: none; }')
    expect(CSS).toContain('.side-effect-health-row')
    expect(CSS).toContain('.side-effect-health-kind')
    expect(CSS).toContain('.side-effect-health-error')
  })

  it('has a mobile breakpoint (rule 13)', () => {
    expect(CSS).toMatch(/@media \(max-width:\s*480px\)\s*\{[^}]*\.side-effect-health-row/)
  })
})

describe('health panel: i18n parity', () => {
  for (const key of [
    'healthPanel.title',
    'healthPanel.no_detail',
    'healthPanel.kind.land',
    'healthPanel.kind.gate_dispatch',
    'healthPanel.kind.telegram_send',
    'healthPanel.kind.offload_draft',
    'healthPanel.kind.memory_embed',
    'healthPanel.kind.scheduled_task',
  ]) {
    it(`hu.js and en.js both define ${key}`, () => {
      expect(langHasKey('hu', key)).toBe(true)
      expect(langHasKey('en', key)).toBe(true)
    })
  }
})
