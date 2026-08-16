// String-contract guard for card cf61fcac/bddd07e4 (Peti kep-minta): a live, continuously
// scrolling waveform/spectrum widget on the Áttekintés (overview) page showing local-LLM GPU
// utilization in real time. Prefers GET /api/local-llm/utilization-history (backend2, card
// b6b1493d, DRAFT at the time this landed) once it ships; falls back to a client-side rolling
// buffer sampled from the already-existing /api/local-llm/status + /api/local-llm/queue endpoints
// so the widget works before/without the new endpoint. Follows the house idiom (see
// local-llm-catalog-ui-wiring.test.ts): source files read as strings, asserted against short,
// formatting-proof fragments -- no DOM/canvas runtime needed to prove the contract.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
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

describe('overview spectrum: markup placement and accessibility', () => {
  it('sits between the stat tiles and the team/activity grid on the Áttekintés page', () => {
    const statsIdx = HTML.indexOf('id="statSkillsSub"')
    const spectrumIdx = HTML.indexOf('id="ovwSpectrumCard"')
    const gridIdx = HTML.indexOf('class="overview-grid"')
    expect(statsIdx).toBeGreaterThan(-1)
    expect(spectrumIdx).toBeGreaterThan(statsIdx)
    expect(gridIdx).toBeGreaterThan(spectrumIdx)
  })

  it('the canvas is decorative (aria-hidden) -- the data must live elsewhere as real text', () => {
    const idx = HTML.indexOf('id="ovwSpectrumCanvas"')
    expect(idx).toBeGreaterThan(-1)
    const tag = HTML.slice(HTML.lastIndexOf('<canvas', idx), HTML.indexOf('>', idx) + 1)
    expect(tag).toContain('aria-hidden="true"')
  })

  it('ships a parallel aria-live readout with GPU/VRAM/active-task values as real DOM text', () => {
    const readoutIdx = HTML.indexOf('id="ovwSpectrumReadout"')
    expect(readoutIdx).toBeGreaterThan(-1)
    const tag = HTML.slice(HTML.lastIndexOf('<dl', readoutIdx), HTML.indexOf('>', readoutIdx) + 1)
    expect(tag).toContain('aria-live="polite"')
    expect(HTML).toContain('id="ovwSpectrumGpu"')
    expect(HTML).toContain('id="ovwSpectrumVram"')
    expect(HTML).toContain('id="ovwSpectrumTasks"')
  })

  it('has empty/error message elements distinct from the canvas (rule 12: no raw/blank failure state)', () => {
    expect(HTML).toContain('id="ovwSpectrumEmpty"')
    expect(HTML).toContain('id="ovwSpectrumError"')
    expect(HTML).toMatch(/id="ovwSpectrumError"[^>]*role="alert"/)
  })
})

describe('overview spectrum: data source with graceful fallback', () => {
  it('polls the server history endpoint first', () => {
    const body = fnBody(APP, 'async function ovwSpectrumPoll()')
    expect(body).toContain("fetch('/api/local-llm/utilization-history')")
  })

  it('falls back to /status + /queue only when the server endpoint has never been established', () => {
    const body = fnBody(APP, 'async function ovwSpectrumPoll()')
    expect(body).toContain('if (_ovwSpectrumUsesServerHistory) return')
    expect(body).toContain("fetch('/api/local-llm/status')")
    expect(body).toContain("fetch('/api/local-llm/queue')")
  })

  it('shows an honest no-GPU state instead of fabricating a flat-line reading', () => {
    const body = fnBody(APP, 'async function ovwSpectrumPoll()')
    expect(body).toContain('if (!d.gpu)')
    expect(body).toContain("ovwSpectrumSetState('no_gpu')")
  })

  it('preserves a null util_pct from the server (unreadable GPU tick) instead of coercing it to 0', () => {
    const body = fnBody(APP, 'async function ovwSpectrumPoll()')
    expect(body).toContain("util: typeof s.util_pct === 'number' ? s.util_pct : null")
    expect(body).not.toMatch(/util:\s*Number\(s\.util_pct\)/)
  })

  it('caps the client-side fallback buffer to the rolling window instead of growing unbounded', () => {
    const body = fnBody(APP, 'async function ovwSpectrumPoll()')
    expect(body).toContain('OVW_SPECTRUM_WINDOW_MS')
    expect(body).toMatch(/_ovwSpectrumSamples\s*=\s*_ovwSpectrumSamples\.filter/)
  })

  it('never shows a raw error object/message to the user (rule 12)', () => {
    const body = fnBody(APP, 'async function ovwSpectrumPoll()')
    expect(body).toContain("ovwSpectrumSetState('error')")
    expect(body).not.toMatch(/ovwSpectrumSetState\('error',\s*err/)
  })
})

describe('overview spectrum: lifecycle wired into page navigation', () => {
  it('starts when the Áttekintés page loads', () => {
    const body = fnBody(APP, 'async function loadOverview()')
    expect(body).toContain('startOvwSpectrum()')
  })

  it('stops (interval + rAF) when navigating away from the page', () => {
    const idx = APP.indexOf("if (pageId !== 'overview') stopOvwSpectrum()")
    expect(idx).toBeGreaterThan(-1)
  })

  it('stopOvwSpectrum tears down both the poll timer and the animation frame', () => {
    const body = fnBody(APP, 'function stopOvwSpectrum()')
    expect(body).toContain('clearInterval(_ovwSpectrumPollTimer)')
    expect(body).toContain('cancelAnimationFrame(_ovwSpectrumRafId)')
  })

  it('the poll loop self-stops if the page was hidden without switchPage running (safety net)', () => {
    const body = fnBody(APP, 'function startOvwSpectrum()')
    expect(body).toContain("document.getElementById('overviewPage').hidden")
    expect(body).toContain('stopOvwSpectrum()')
  })
})

describe('overview spectrum: null util_pct draws a gap, never a fabricated 0', () => {
  it('splits the waveform into contiguous non-null runs instead of drawing null as the bottom edge', () => {
    const body = fnBody(APP, 'function ovwSpectrumDraw()')
    expect(body).toContain("typeof s.util !== 'number'")
    expect(body).toMatch(/if\s*\(p === null\)\s*\{\s*if\s*\(cur\.length\)\s*runs\.push\(cur\)/)
  })
})

describe('overview spectrum: motion respects prefers-reduced-motion', () => {
  it('the draw loop does not re-schedule itself under reduced motion', () => {
    const body = fnBody(APP, 'function ovwSpectrumDraw()')
    expect(body).toContain("matchMedia('(prefers-reduced-motion: reduce)').matches")
    expect(body).toMatch(/_ovwSpectrumRafId\s*=\s*reduceMotion\s*\?\s*null\s*:\s*requestAnimationFrame\(ovwSpectrumDraw\)/)
  })

  it('still redraws once per poll tick under reduced motion, so the reading is not stale', () => {
    const body = fnBody(APP, 'function startOvwSpectrum()')
    expect(body).toContain('ovwSpectrumDraw()')
  })
})

describe('overview spectrum: responsive + i18n', () => {
  it('shrinks the canvas height on narrow viewports (rule 13)', () => {
    expect(CSS).toMatch(/@media \(max-width:\s*640px\)\s*\{[^}]*\.ovw-spectrum-canvas\s*\{\s*height:\s*90px/)
  })

  it('every overview.spectrum.* key used in app.js/index.html exists in both hu.js and en.js', () => {
    const keys = new Set<string>()
    for (const m of (APP + HTML).matchAll(/overview\.spectrum\.[a-zA-Z_]+/g)) keys.add(m[0])
    expect(keys.size).toBeGreaterThan(0)
    for (const key of keys) {
      expect(HU).toContain(`'${key}'`)
      expect(EN).toContain(`'${key}'`)
    }
  })
})
