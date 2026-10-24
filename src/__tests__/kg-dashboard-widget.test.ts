// String-contract guard for card 8bb7cf54 (MT F5 / MT-11): "Megoldás-tár" (knowledge graph)
// dashboard page. Pair-BE (34c2d2a2, MT-03/04) and the storage layer (ee9ee17b, MT-01/02) are
// both still `planned` at the time this was built -- contract-first against the FROZEN
// contract in card 3f6fc4ce comment 20763 (overrides 20727 section 3) + decisions 20758/20814.
// House idiom (see gemini-calls-widget.test.ts): source files read as strings, asserted
// against short, formatting-proof fragments; pure helpers extracted and actually executed
// via new Function() where behavior (not just presence) needs proving.
//
// Key contracts:
//   - GET /api/kg/search?q=&project=&types=&strict=&k= with Authorization header
//   - GET /api/kg/nodes/:id?depth= with Authorization header
//   - PUT /api/kg/nodes/:id/status with {status:'archived', reason} body, JSON content-type
//   - 404 on any endpoint renders the honest "backend not landed yet" state (kg.disabled),
//     never an invented result
//   - status badge classes cover all 5 kg_nodes.status values (draft/active/stale/
//     superseded/archived); anchor state covers all 3 (fresh/drifted/gone)
//   - project scope defaults to the project selector's own value, '*' only on explicit choice
//     (D5/F2: project=* is a scope filter, never sent unless the user picked "Mind")
//   - i18n parity: every kg.* key in both hu.js and en.js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_KG     = readFileSync(join(__dirname, '../../web/app-kg.js'), 'utf-8')
const APP_PAGESW = readFileSync(join(__dirname, '../../web/app-page-switch.js'), 'utf-8')
const HTML       = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS        = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HU         = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN         = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

function fnBody(source: string, startMarker: string, maxLen = 4000): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nasync function ', start + startMarker.length)
  const nextSyncFn = source.indexOf('\nfunction ', start + startMarker.length)
  const nextConst = source.indexOf('\nconst ', start + startMarker.length)
  const candidates = [nextFn, nextSyncFn, nextConst].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + maxLen
  return source.slice(start, end)
}

function runPure<T>(fnSrc: string, fnName: string, ...args: unknown[]): T {
  const factory = new Function('t', fnSrc + `\nreturn function(...args) { return ${fnName}(...args) }`)
  const tStub = (key: string, params: Record<string, unknown> = {}) => {
    // Mimic the real t(): unknown key -> returns the key itself, {n} interpolation.
    const table: Record<string, string> = {
      'kg.type.solution': 'Megoldás',
      'kg.rel.produced': 'létrehozta',
    }
    const str = table[key] ?? key
    return str.replace(/\{(\w+)\}/g, (_: string, k: string) => String(params[k] ?? `{${k}}`))
  }
  const fn = factory(tStub)
  return fn(...args) as T
}

describe('kg (Megoldás-tár): pure helper functions, real execution', () => {
  it('kgStatusBadgeClass covers all 5 kg_nodes.status values', () => {
    const src = fnBody(APP_KG, 'function kgStatusBadgeClass(')
    for (const [status, expectClass] of [
      ['active', 'kg-badge-active'], ['draft', 'kg-badge-draft'], ['stale', 'kg-badge-stale'],
      ['superseded', 'kg-badge-superseded'], ['archived', 'kg-badge-archived'],
    ] as const) {
      const out = runPure<string>(src, 'kgStatusBadgeClass', status)
      expect(out).toContain(expectClass)
    }
  })

  it('kgStatusBadgeClass falls back to the base class for an unknown status', () => {
    const src = fnBody(APP_KG, 'function kgStatusBadgeClass(')
    expect(runPure<string>(src, 'kgStatusBadgeClass', 'bogus')).toBe('kg-badge')
  })

  it('kgAnchorStateClass covers all 3 anchor states', () => {
    const src = fnBody(APP_KG, 'function kgAnchorStateClass(')
    expect(runPure<string>(src, 'kgAnchorStateClass', 'fresh')).toContain('kg-anchor-fresh')
    expect(runPure<string>(src, 'kgAnchorStateClass', 'drifted')).toContain('kg-anchor-drifted')
    expect(runPure<string>(src, 'kgAnchorStateClass', 'gone')).toContain('kg-anchor-gone')
  })

  it('kgTypeLabel resolves a known type via t() and falls back to the raw type otherwise', () => {
    const src = fnBody(APP_KG, 'function kgTypeLabel(')
    expect(runPure<string>(src, 'kgTypeLabel', 'solution')).toBe('Megoldás')
    expect(runPure<string>(src, 'kgTypeLabel', 'some_future_type')).toBe('some_future_type')
  })

  it('kgRelLabel resolves a known rel via t() and falls back to the raw rel otherwise', () => {
    const src = fnBody(APP_KG, 'function kgRelLabel(')
    expect(runPure<string>(src, 'kgRelLabel', 'produced')).toBe('létrehozta')
    expect(runPure<string>(src, 'kgRelLabel', 'some_future_rel')).toBe('some_future_rel')
  })

  it('kgProjectColor is stable per project and never throws on an unknown project', () => {
    const startIdx = APP_KG.indexOf('const KG_PROJECT_COLORS')
    const endIdx = APP_KG.indexOf('function kgBuildGraphNodes')
    const src = APP_KG.slice(startIdx, endIdx)
    const call = new Function(src + '\nreturn kgProjectColor(arguments[0])')
    expect(call('marveen')).toMatch(/^#[0-9a-f]{6}$/i)
    expect(call('mopsion')).toMatch(/^#[0-9a-f]{6}$/i)
    expect(call('_global')).toMatch(/^#[0-9a-f]{6}$/i)
    expect(() => call('a-project-nobody-registered-yet')).not.toThrow()
  })
})

// WhiteHat F1/F2 (card 88fd0000, source: card 8bb7cf54 comment 20875, CYBERSEC GO with
// condition): the ORIGINAL kg-dashboard-widget.test.ts never ran the real render functions
// against an attacker string -- it only grep'd source text, so stripping any one of 6
// escapeHtml() call-sites (detail title, result title, snippet, the data-attribute id, the
// anchor path, the neighbor title) left the suite fully green. These tests actually EXECUTE
// kgRenderResults/kgRenderDetail against a crafted payload on a minimal (Node, no jsdom) DOM
// stub -- the same "truncated DOM" approach WhiteHat's own verification used -- and assert the
// real escaped output, so removing any one of those escapeHtml() calls turns a specific test
// red (verified by mutation, see the commit message).
function loadKgRenderModule() {
  class FakeEl {
    _html = ''
    hidden = false
    value = '*'
    checked = false
    selectedOptions: unknown[] = []
    classList = { toggle: () => {}, add: () => {}, remove: () => {} }
    get innerHTML(): string { return this._html }
    set innerHTML(v: string) { this._html = v }
    querySelectorAll(): unknown[] { return [] }
    querySelector(): null { return null }
    addEventListener(): void {}
    getAttribute(): null { return null }
    setAttribute(): void {}
  }
  const elements = new Map<string, FakeEl>()
  function fakeEl(id: string): FakeEl {
    if (!elements.has(id)) elements.set(id, new FakeEl())
    return elements.get(id)!
  }
  const fakeDocument = { getElementById: fakeEl }
  // Faithful to the real escapeHtml (app-helpers.js:25-33): textContent->innerHTML escapes
  // & < > (in that order, so a literal & is never re-escaped by the later rules), then an
  // explicit replace for " and ' (attribute-context safety).
  const realEscapeHtml = (v: unknown) =>
    String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  const tStub = (key: string, params: Record<string, unknown> = {}) =>
    key.replace(/\{(\w+)\}/g, (_: string, k: string) => String(params[k] ?? `{${k}}`))
  const factory = new Function(
    'document', 'escapeHtml', 't', 'localStorage', 'fetch', 'confirm', 'alert',
    APP_KG + '\nreturn { kgRenderResults, kgRenderDetail, kgCurrentQuery }',
  )
  const mod = factory(fakeDocument, realEscapeHtml, tStub, { getItem: () => '' }, () => Promise.reject(new Error('not used')), () => true, () => {})
  return { mod, fakeEl }
}

describe('kg: escaping, real execution against the actual render functions (WhiteHat F1/F2)', () => {
  const XSS = '"><img src=x onerror=alert(1)>'

  it('kgRenderResults escapes result.title', () => {
    const { mod, fakeEl } = loadKgRenderModule()
    mod.kgRenderResults([{ id: 'ok1', type: 'solution', project: 'marveen', title: XSS, status: 'active' }], {})
    const html = fakeEl('kgResultsBody').innerHTML
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('kgRenderResults escapes result.snippet', () => {
    const { mod, fakeEl } = loadKgRenderModule()
    mod.kgRenderResults([{ id: 'ok1', type: 'solution', project: 'marveen', title: 'ok', snippet: XSS, status: 'active' }], {})
    const html = fakeEl('kgResultsBody').innerHTML
    expect(html).not.toContain('<img')
  })

  it('kgRenderResults escapes the data-kg-node-id attribute value', () => {
    const { mod, fakeEl } = loadKgRenderModule()
    mod.kgRenderResults([{ id: XSS, type: 'solution', project: 'marveen', title: 'ok', status: 'active' }], {})
    const html = fakeEl('kgResultsBody').innerHTML
    expect(html).not.toContain('"><img')
    expect(html).not.toContain('<img')
  })

  it('kgRenderDetail escapes node.title', () => {
    const { mod, fakeEl } = loadKgRenderModule()
    mod.kgRenderDetail({ id: 'n1', type: 'solution', project: 'marveen', status: 'active', title: XSS, anchors: [] }, [])
    const html = fakeEl('kgDetailBody').innerHTML
    expect(html).not.toContain('<img')
  })

  it('kgRenderDetail escapes node.snippet', () => {
    const { mod, fakeEl } = loadKgRenderModule()
    mod.kgRenderDetail({ id: 'n1', type: 'solution', project: 'marveen', status: 'active', title: 'ok', snippet: XSS, anchors: [] }, [])
    const html = fakeEl('kgDetailBody').innerHTML
    expect(html).not.toContain('<img')
  })

  it('kgRenderDetail escapes the anchor repo/path', () => {
    const { mod, fakeEl } = loadKgRenderModule()
    mod.kgRenderDetail(
      { id: 'n1', type: 'solution', project: 'marveen', status: 'active', title: 'ok', anchors: [{ repo: XSS, path: XSS, state: 'fresh' }] },
      [],
    )
    const html = fakeEl('kgDetailBody').innerHTML
    expect(html).not.toContain('<img')
  })

  it('kgRenderDetail escapes a neighbor title', () => {
    const { mod, fakeEl } = loadKgRenderModule()
    mod.kgRenderDetail(
      { id: 'n1', type: 'solution', project: 'marveen', status: 'active', title: 'ok', anchors: [] },
      [{ edge: { rel: 'produced' }, node: { id: 'n2', type: 'solution', status: 'active', title: XSS } }],
    )
    const html = fakeEl('kgDetailBody').innerHTML
    expect(html).not.toContain('<img')
  })

  it('F1: kgRenderDetail never emits a raw, unescaped non-numeric anchor.line_end', () => {
    const { mod, fakeEl } = loadKgRenderModule()
    mod.kgRenderDetail(
      { id: 'n1', type: 'solution', project: 'marveen', status: 'active', title: 'ok', anchors: [{ repo: 'r', path: 'p', line_start: 1, line_end: XSS, state: 'fresh' }] },
      [],
    )
    const html = fakeEl('kgDetailBody').innerHTML
    expect(html).not.toContain('<img')
    // typeof-guarded like line_start: a non-number line_end is omitted entirely, not stringified.
    expect(html).not.toContain(XSS)
  })

  it('F1: a genuine numeric line_end still renders (no regression)', () => {
    const { mod, fakeEl } = loadKgRenderModule()
    mod.kgRenderDetail(
      { id: 'n1', type: 'solution', project: 'marveen', status: 'active', title: 'ok', anchors: [{ repo: 'r', path: 'p', line_start: 10, line_end: 20, state: 'fresh' }] },
      [],
    )
    const html = fakeEl('kgDetailBody').innerHTML
    expect(html).toContain('L10-20')
  })

  it('F2: default scope is always project=* (no card_id-less, project-less dead end)', () => {
    const { mod, fakeEl } = loadKgRenderModule()
    // Simulate the post-F3 DOM: a single, selected "Összes projekt" (*) option.
    fakeEl('kgSearchInput').value = 'anything'
    fakeEl('kgProjectSelect').value = '*'
    fakeEl('kgTypeFilter').selectedOptions = []
    fakeEl('kgStrictToggle').checked = false
    const query = mod.kgCurrentQuery()
    expect(query.project).toBe('*')
  })
})

describe('kg: search fetch contract', () => {
  const src = fnBody(APP_KG, 'async function kgRunSearch(')

  it('fetches /api/kg/search with an Authorization header', () => {
    expect(src).toContain("kgFetch('/api/kg/search?'")
  })

  it('sends q, project, types[], strict, k as query params (card 3f6fc4ce comment 20763)', () => {
    expect(src).toContain("params.set('q'")
    expect(src).toContain("params.set('project'")
    expect(src).toContain("params.append('types'")
    expect(src).toContain("params.set('strict'")
    expect(src).toContain("params.set('k'")
  })

  it('never hardcodes the "*" scope in JS -- it is read from the DOM select (F3, card 88fd0000)', () => {
    // kgCurrentQuery reads the raw <select> value; the HTML now carries a single, selected
    // "Összes projekt" (*) option (F3), but the JS itself still never hardcodes the scope.
    expect(APP_KG).not.toMatch(/project['"]?\s*[:=]\s*['"]\*['"]/)
  })

  it('a 404 renders the disabled state, not an invented result', () => {
    expect(src).toContain('res.status === 404')
    expect(src).toContain('kgShowDisabledState(body)')
  })

  it('renders meta.relaxed and meta.hits distinctly from a plain result count', () => {
    const renderSrc = fnBody(APP_KG, 'function kgRenderResults(')
    expect(renderSrc).toContain('kg.meta.relaxed')
    expect(renderSrc).toContain('kg.meta.hits')
  })
})

describe('kg: node detail fetch contract', () => {
  it('kgSelectNode fetches /api/kg/nodes/:id?depth=1 by default', () => {
    const src = fnBody(APP_KG, 'async function kgSelectNode(')
    expect(src).toContain("kgFetch('/api/kg/nodes/' + encodeURIComponent(id) + '?depth=1')")
  })

  it('a 404 on node detail renders the disabled state', () => {
    const src = fnBody(APP_KG, 'async function kgSelectNode(')
    expect(src).toContain('res.status === 404')
    expect(src).toContain('kgShowDisabledState(detailBody)')
  })

  it('renders anchors with their state badge and neighbors with their rel label', () => {
    const src = fnBody(APP_KG, 'function kgRenderDetail(')
    expect(src).toContain('kgAnchorStateClass(a.state)')
    expect(src).toContain('kgRelLabel(n.edge.rel)')
  })

  it('the archive button is disabled when the node is already archived', () => {
    const src = fnBody(APP_KG, 'function kgRenderDetail(')
    expect(src).toContain("node.status !== 'archived'")
  })
})

describe('kg: archive (PUT /api/kg/nodes/:id/status) contract', () => {
  const src = fnBody(APP_KG, 'async function kgArchiveNode(')

  it('PUTs to /api/kg/nodes/:id/status with a JSON body carrying status:"archived"', () => {
    expect(src).toContain("method: 'PUT'")
    expect(src).toContain("'/api/kg/nodes/' + encodeURIComponent(id) + '/status'")
    expect(src).toContain("status: 'archived'")
  })

  it('confirms before archiving (irreversible-feeling action, even though the node is not deleted)', () => {
    expect(src).toContain('confirm(')
  })

  it('re-fetches the node and re-runs the search after a successful archive', () => {
    expect(src).toContain('kgSelectNode(id)')
    expect(src).toContain('kgRunSearch()')
  })
})

describe('kg: HTML wiring', () => {
  it('sidebar nav has a kg link in the Tudás group, next to Memória', () => {
    const memIdx = HTML.indexOf('data-page="memories"')
    const slice = HTML.slice(memIdx, memIdx + 1200)
    expect(slice).toContain('data-page="kg"')
    expect(slice).toContain('data-i18n="nav.kg"')
  })

  it('the kg page section exists with the required child elements', () => {
    const pageIdx = HTML.indexOf('id="kgPage"')
    expect(pageIdx).toBeGreaterThan(-1)
    const slice = HTML.slice(pageIdx, pageIdx + 4000)
    for (const id of [
      'kgOllamaBanner', 'kgStats', 'kgSearchInput', 'kgProjectSelect', 'kgTypeFilter',
      'kgStrictToggle', 'kgResultsMeta', 'kgResultsBody', 'kgDetailPanel', 'kgTabDetail',
      'kgTabGraph', 'kgDetailBody', 'kgGraphView', 'kgGraphCanvas', 'kgGraphDepthBtn',
      'kgGraphLegend', 'kgGraphPanel', 'kgDetailPlaceholder',
    ]) {
      expect(slice).toContain(`id="${id}"`)
    }
  })

  it('the detail panel and graph view are hidden by default', () => {
    const pageIdx = HTML.indexOf('id="kgPage"')
    const slice = HTML.slice(pageIdx, pageIdx + 4000)
    expect(slice).toMatch(/id="kgDetailPanel"\s+hidden/)
    expect(slice).toMatch(/id="kgGraphView"\s+hidden/)
    expect(slice).toMatch(/id="kgOllamaBanner"[^>]*hidden/)
  })

  it('the type filter offers solution/anti_pattern/decision/finding/lesson', () => {
    const pageIdx = HTML.indexOf('id="kgTypeFilter"')
    const slice = HTML.slice(pageIdx, pageIdx + 600)
    for (const ty of ['solution', 'anti_pattern', 'decision', 'finding', 'lesson']) {
      expect(slice).toContain(`value="${ty}"`)
    }
  })

  it('F3 (card 88fd0000): the project select defaults to "Összes projekt" (*), no "Saját projekt" dead end', () => {
    const selectIdx = HTML.indexOf('id="kgProjectSelect"')
    const closeIdx = HTML.indexOf('</select>', selectIdx)
    const slice = HTML.slice(selectIdx, closeIdx)
    expect(slice).toContain('value="*"')
    expect(slice).toContain('selected')
    // The old "Saját projekt" (empty-value) option sent neither project nor card_id and hit
    // the contract's 400 project_or_card_id_required dead end -- it must be gone, not just
    // relabeled.
    expect(slice).not.toContain('value=""')
    expect(slice).not.toContain('kg.filter.default_scope')
  })

  it('the script tag is present after app-overview.js', () => {
    const ovwIdx = HTML.indexOf('/app-overview.js')
    expect(ovwIdx).toBeGreaterThan(-1)
    expect(HTML.indexOf('/app-kg.js', ovwIdx)).toBeGreaterThan(ovwIdx)
  })
})

describe('kg: page-switch wiring', () => {
  it('switchPage calls loadKgPage for the kg page id', () => {
    expect(APP_PAGESW).toContain("if (pageId === 'kg') loadKgPage()")
  })
})

describe('kg: CSS', () => {
  it('defines every class the JS/HTML reference', () => {
    const must = [
      'kg-banner', 'kg-stats', 'kg-stat-tile', 'kg-toolbar', 'kg-search-wrap', 'kg-search',
      'kg-project-select', 'kg-type-select', 'kg-strict-toggle', 'kg-layout', 'kg-results',
      'kg-result-item', 'kg-badge', 'kg-badge-active', 'kg-badge-archived', 'kg-detail',
      'kg-detail-tabs', 'kg-tab', 'kg-anchor', 'kg-anchor-fresh', 'kg-anchor-drifted',
      'kg-anchor-gone', 'kg-neighbor-item', 'kg-graph-canvas', 'kg-graph-panel', 'kg-disabled',
    ]
    for (const cls of must) {
      expect(CSS).toContain(`.${cls}`)
    }
  })

  it('has [hidden] overrides for every conditionally-hidden element', () => {
    expect(CSS).toContain('.kg-banner[hidden]')
    expect(CSS).toContain('.kg-detail[hidden]')
    expect(CSS).toContain('.kg-detail-body[hidden]')
    expect(CSS).toContain('.kg-graph-view[hidden]')
    expect(CSS).toContain('.kg-graph-panel[hidden]')
  })

  it('has a responsive breakpoint (rule 13) that collapses the two-column layout', () => {
    const idx = CSS.indexOf('.kg-layout')
    const tailIdx = CSS.lastIndexOf('@media (max-width: 768px)')
    expect(tailIdx).toBeGreaterThan(idx)
    const slice = CSS.slice(tailIdx, tailIdx + 300)
    expect(slice).toContain('.kg-layout')
    expect(slice).toContain('grid-template-columns: 1fr')
  })

  it('touch targets are >= 44px (rule 13) on the interactive controls', () => {
    for (const cls of ['.kg-search', '.kg-project-select', '.kg-type-select', '.kg-strict-toggle', '.kg-result-item', '.kg-tab', '.kg-neighbor-item']) {
      // Word-boundary match so e.g. '.kg-search' doesn't hit '.kg-search-wrap' first.
      const re = new RegExp('\\.' + cls.slice(1) + '(?![a-zA-Z0-9-])')
      const m = re.exec(CSS)
      expect(m, `selector ${cls} not found`).toBeTruthy()
      const nameIdx = m!.index
      const braceIdx = CSS.indexOf('{', nameIdx)
      const block = CSS.slice(nameIdx, CSS.indexOf('}', braceIdx))
      expect(block).toMatch(/min-height:\s*44px/)
    }
  })
})

describe('kg: i18n parity (hu.js / en.js)', () => {
  it('every kg.* key referenced by app-kg.js exists in BOTH language files', () => {
    const refs = new Set<string>()
    // Require a closing paren/comma right after the quote so a dynamic concatenation
    // (e.g. t('kg.anchor.state.' + a.state)) is excluded -- its PREFIX is not a real key.
    for (const m of APP_KG.matchAll(/t\('(kg\.[a-zA-Z0-9_.]+)'\s*[,)]/g)) refs.add(m[1])
    expect(refs.size).toBeGreaterThan(10)
    for (const key of refs) {
      expect(HU).toContain(`'${key}'`)
      expect(EN).toContain(`'${key}'`)
    }
  })

  it('every kg.* key referenced by index.html (data-i18n) exists in BOTH language files', () => {
    const refs = new Set<string>()
    for (const m of HTML.matchAll(/data-i18n(?:-placeholder)?="(kg\.[a-zA-Z0-9_.]+)"/g)) refs.add(m[1])
    expect(refs.size).toBeGreaterThan(5)
    for (const key of refs) {
      expect(HU).toContain(`'${key}'`)
      expect(EN).toContain(`'${key}'`)
    }
  })

  it('nav.kg exists in both languages', () => {
    expect(HU).toContain("'nav.kg':")
    expect(EN).toContain("'nav.kg':")
  })

  it('the three anchor states and five node types all have an hu+en label', () => {
    for (const state of ['fresh', 'drifted', 'gone']) {
      expect(HU).toContain(`'kg.anchor.state.${state}'`)
      expect(EN).toContain(`'kg.anchor.state.${state}'`)
    }
    for (const ty of ['solution', 'anti_pattern', 'decision', 'finding', 'lesson']) {
      expect(HU).toContain(`'kg.type.${ty}'`)
      expect(EN).toContain(`'kg.type.${ty}'`)
    }
  })

  it('kg.disabled (the honest "backend not landed" state, rule 12) exists in both languages', () => {
    expect(HU).toContain("'kg.disabled'")
    expect(EN).toContain("'kg.disabled'")
  })
})
