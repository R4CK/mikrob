// String-contract guard for card 3d923ef5: "installed but not yet benchmarked" visual state in
// the installed-models list (Helyi LLM page). House idiom: source files read as strings, asserted
// against short, formatting-proof fragments -- no DOM/runtime needed.
//
// Key constraints from the card:
//   - trusted (catalog) and benchmarked (bench.sh) are TWO SEPARATE badges, answering different
//     questions -- never merged
//   - tok/s is ALWAYS shown with benchCtx ("18.4 tok/s @ 4096"), never without
//   - "installed but not benchmarked" state is visually distinct (CSS class + inline hint)
//   - no "mark as benchmarked" UI button -- only store/local-llm-bench.sh writes the state
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_CORE = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const LLM_MODULE = readFileSync(join(__dirname, '../../web/app-local-llm.js'), 'utf-8')
const APP = APP_CORE + '\n' + LLM_MODULE
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

function fnBody(source: string, startMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nfunction ', start + startMarker.length)
  const nextAsyncFn = source.indexOf('\nasync function ', start + startMarker.length)
  const candidates = [nextFn, nextAsyncFn].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + 8000
  return source.slice(start, end)
}

describe('installed-models list: data source', () => {
  it('fetches the catalog alongside status so trusted can be shown without a second round-trip', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    expect(body).toContain("fetch('/api/local-llm/catalog')")
    expect(body).toContain("fetch('/api/local-llm/status')")
  })

  it('builds a trustedByName map from the catalog response', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    expect(body).toContain('trustedByName')
    expect(body).toContain('trustedByName.set')
  })

  it('catalog fetch failure does not break the status section (graceful fallback)', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    expect(body).toMatch(/fetch\('\/api\/local-llm\/catalog'\)\.catch\(\(\) => null\)/)
  })
})

describe('installed-models list: tok/s always shown with benchCtx', () => {
  it('includes benchCtx in the measured tok/s display', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    expect(body).toContain('benchCtx')
    expect(body).toMatch(/tok\/s.*benchCtx|benchCtx.*tok\/s/)
  })

  it('does not show tok/s alone (without context size) for benchmarked models', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    // The format string must include the ctx variable alongside the tps value
    expect(body).toContain('m.benchCtx')
  })
})

describe('installed-models list: two separate badges', () => {
  it('shows a trusted/unverified badge sourced from the catalog (publisher trust claim)', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    expect(body).toContain('llm-trust-badge')
    expect(body).toContain('trustedByName.get(m.name)')
  })

  it('trusted and benchmarked are rendered as separate HTML elements, not merged', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    // bench badge uses llm-rec-tps class (existing); trust badge uses llm-trust-badge -- distinct
    expect(body).toContain('llm-rec-tps')
    expect(body).toContain('llm-trust-badge')
    // they should not be a single span
    const trustIdx = body.indexOf('llm-trust-badge')
    const tpsIdx = body.indexOf('llm-rec-tps')
    expect(Math.abs(trustIdx - tpsIdx)).toBeGreaterThan(10)
  })

  it('omits the trust badge when the catalog was unavailable (no invented value)', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    expect(body).toContain('trustedByName.has(m.name)')
  })
})

describe('installed-models list: not-benchmarked visual state', () => {
  it('adds a not-benchmarked CSS class to rows where benchmarked is false', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    expect(body).toContain('not-benchmarked')
    expect(body).toContain('notBenched')
  })

  it('shows an inline hint telling the user how to trigger a benchmark (rule 12: actionable)', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    expect(body).toContain('llm-bench-hint')
    expect(body).toContain("localLlm.models.bench.unmeasured_hint")
  })

  it('never adds not-benchmarked class to the active model row', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    // The condition guards: notBenched && !active
    expect(body).toContain('notBenched && !active')
  })

  it('has no UI button to mark a model as benchmarked -- only bench.sh can write that state', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    // "bench-btn" or "benchmarkBtn" class are the dangerous patterns -- not plain "benchmarked"
    expect(body).not.toContain('bench-btn')
    expect(body).not.toContain('benchmarkBtn')
    expect(body).not.toContain('mark-bench')
  })
})

describe('installed-models list: CSS', () => {
  it('has .llm-model-row.not-benchmarked with a distinct border style', () => {
    expect(CSS).toMatch(/\.llm-model-row\.not-benchmarked\s*\{[^}]*border-style:\s*dashed/)
  })

  it('has .llm-bench-hint styled as a muted hint (monospace, warning color)', () => {
    expect(CSS).toMatch(/\.llm-bench-hint\s*\{[^}]*font-family/)
    expect(CSS).toMatch(/\.llm-bench-hint\s*\{[^}]*color/)
  })
})

describe('installed-models list: i18n parity', () => {
  it('all localLlm.models.bench.* keys exist in both hu.js and en.js', () => {
    const keys = ['localLlm.models.bench.tip', 'localLlm.models.bench.unmeasured_tip', 'localLlm.models.bench.unmeasured_hint']
    for (const key of keys) {
      expect(HU).toContain(`'${key}'`)
      expect(EN).toContain(`'${key}'`)
    }
  })
})
