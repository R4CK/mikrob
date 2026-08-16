// String-contract guard for the #localLlm page's non-recommendation sections (card a05c39c9,
// follow-up to 88ea5050): Status/Feladat-sor/Kategoriak/Hasznalat-merteek/Modellek(telepitett)
// getting the modern/animated treatment the original card's honest scope note flagged as missing,
// plus the evalTps/benchmarked display gap noted alongside it (card d730070e's fields, merged into
// GET /api/local-llm/status server-side but never rendered). Follows the house idiom (see
// local-llm-catalog-ui-wiring.test.ts): app.js is read as a string and asserted against short,
// formatting-proof fragments.
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

describe('installed-models throughput (card a05c39c9, d730070e fields)', () => {
  it('shows evalTps when benchmarked, an explicit not-measured state otherwise -- never 0 or omitted', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    expect(body).toContain('m.benchmarked && typeof m.evalTps === \'number\'')
    expect(body).toContain("t('localLlm.rec.tps_unmeasured')")
    expect(body).not.toMatch(/evalTps \|\| 0/)
  })

  it('reuses the catalogue section\'s tps i18n keys where the same fact applies; unmeasured hint is model-list-specific (card 3d923ef5)', () => {
    const body = fnBody(APP, 'async function llmRefreshStatus()')
    expect(body).toContain("t('localLlm.rec.tps_tip')")
    // card 3d923ef5: the unmeasured message now points to store/local-llm-bench.sh (actionable,
    // rule 12), so it uses a dedicated key rather than the catalogue's generic version.
    expect(body).toContain("t('localLlm.models.bench.unmeasured_tip')")
  })
})

describe('llmAnimateBatch (once-only entrance animation on 5s-polled sections)', () => {
  it('does nothing on a section already marked done -- prevents re-animating on every poll tick', () => {
    const body = fnBody(APP, 'function llmAnimateBatch(html, key, cls)')
    expect(body).toContain('if (_llmAnimDone[key]) return html')
  })

  it('marks the key done as part of the SAME call that applies the class (no separate call site can forget it)', () => {
    const body = fnBody(APP, 'function llmAnimateBatch(html, key, cls)')
    expect(body).toContain('llmAnimMark(key)')
  })

  it('SECURITY-ADJACENT (class-corruption guard): the match requires a boundary after the class name', () => {
    // "llm-tile" is also a PREFIX of "llm-tile-label"/"llm-tile-value"/"llm-tile-note"/
    // "llm-tile-role" -- a plain substring/prefix replace would corrupt those into
    // "llm-tile llm-anim-in-label" etc. The regex must require a `"` or whitespace right after
    // the class name, not just match the prefix.
    const body = fnBody(APP, 'function llmAnimateBatch(html, key, cls)')
    expect(body).toMatch(/\(\?=\["\\\\s\]\)/)
  })

  it('is wired into the small tile grids/lists: status, models, usage, queue', () => {
    const statusBody = fnBody(APP, 'async function llmRefreshStatus()')
    expect(statusBody).toContain("llmAnimateBatch(tiles.join(''), 'status', 'llm-tile')")
    expect(statusBody).toContain("'models', 'llm-model-row')")

    const usageBody = fnBody(APP, 'async function llmRefreshUsage()')
    expect(usageBody).toContain("'usage', 'llm-tile')")

    const queueBody = fnBody(APP, 'async function llmRefreshQueue()')
    expect(queueBody).toContain("'queue', 'llm-tile')")
  })

  it('NOT wired into Categories (Peti feedback 2026-08-16: "vibrál") -- ~80 rows is too many for a per-row stagger', () => {
    const catBody = fnBody(APP, 'async function llmRefreshCategories()')
    expect(catBody).not.toContain('llmAnimateBatch(')
    expect(catBody).not.toContain('llm-anim-in')
  })
})

describe('usage bar-chart growth animation (card a05c39c9)', () => {
  it('defers setting the real --w/--h to a rAF tick instead of the same synchronous render pass', () => {
    // Setting the CSS custom property in the same tick as the innerHTML write risks the browser
    // batching both into one paint, so the width `transition` in style.css never has a visible
    // 0% starting frame to animate from. Deferring one frame guarantees the 0% state actually
    // painted first.
    const usageBody = fnBody(APP, 'async function llmRefreshUsage()')
    const byAgentIdx = usageBody.indexOf('llm-usage-bar-fill')
    const byAgentSlice = usageBody.slice(byAgentIdx, byAgentIdx + 800)
    expect(byAgentSlice).toContain('requestAnimationFrame(() => {')

    const dayIdx = usageBody.indexOf('llm-usage-day-bar')
    const daySlice = usageBody.slice(dayIdx, dayIdx + 700)
    expect(daySlice).toContain('requestAnimationFrame(() => {')
  })
})

describe('#localLlm page polish CSS (card a05c39c9)', () => {
  it('defines the once-only entrance class, reusing the catalogue section\'s own keyframe (not a duplicate)', () => {
    expect(CSS).toContain('.llm-anim-in {')
    expect(CSS).toMatch(/\.llm-anim-in\s*\{\s*animation:\s*llm-rec-group-in/)
  })

  it('the entrance class is disabled under prefers-reduced-motion', () => {
    const idx = CSS.indexOf('@keyframes llm-rec-group-in')
    expect(idx).toBeGreaterThan(-1)
    const mediaIdx = CSS.indexOf('@media (prefers-reduced-motion: reduce)', idx)
    expect(mediaIdx).toBeGreaterThan(-1)
    const block = CSS.slice(mediaIdx, mediaIdx + 300)
    expect(block).toMatch(/\.llm-anim-in\s*\{\s*animation:\s*none/)
  })

  it('the usage bar-chart transitions are defined and disabled under prefers-reduced-motion', () => {
    expect(CSS).toMatch(/\.llm-usage-bar-fill\s*\{[^}]*transition:\s*width/)
    expect(CSS).toMatch(/\.llm-usage-day-bar\s*\{[^}]*transition:\s*height/)
    const idx = CSS.indexOf('@keyframes llm-rec-group-in')
    const mediaIdx = CSS.indexOf('@media (prefers-reduced-motion: reduce)', idx)
    const block = CSS.slice(mediaIdx, mediaIdx + 300)
    expect(block).toMatch(/\.llm-usage-bar-fill,\s*\.llm-usage-day-bar\s*\{\s*transition:\s*none/)
  })
})

describe('Feladat-sor scope hint (card c4abd0f0, MikroB correction 2026-08-16)', () => {
  // The queue widget (GET /api/local-llm/queue*) reads a narrow, rarely-used async job-queue
  // table -- NOT the main offload path (which is usage-log based, see the "Használat" section).
  // A quiet queue was misread as "offload stopped entirely" during a05c39c9's investigation;
  // MikroB corrected it with a live measurement (41.6% local ratio that same day). This hint
  // exists so the same misreading doesn't happen again from the UI alone.
  it('the hint sits right after the queue description, inside the same section', () => {
    const titleIdx = HTML.indexOf('data-i18n="localLlm.queue.title"')
    const descIdx = HTML.indexOf('data-i18n="localLlm.queue.desc"', titleIdx)
    const hintIdx = HTML.indexOf('data-i18n="localLlm.queue.scope_hint"', descIdx)
    const tilesIdx = HTML.indexOf('id="llmQueueTiles"', hintIdx)
    expect(descIdx).toBeGreaterThan(titleIdx)
    expect(hintIdx).toBeGreaterThan(descIdx)
    expect(tilesIdx).toBeGreaterThan(hintIdx)
  })

  it('exists in both languages and points at the Usage section for the full picture', () => {
    expect(HU).toContain("'localLlm.queue.scope_hint':")
    expect(EN).toContain("'localLlm.queue.scope_hint':")
    const huIdx = HU.indexOf("'localLlm.queue.scope_hint':")
    const huLine = HU.slice(huIdx, HU.indexOf('\n', huIdx))
    expect(huLine).toMatch(/Használat/)
  })
})
