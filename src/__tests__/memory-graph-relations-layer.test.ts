// Card 3bd18e70 (phase fe3eff9f, FELADAT 4/4): kanban relation layer on the
// memory-page Canvas graph. Two halves:
//   1. string contract -- the module, HTML, CSS and both language files carry
//      the wiring (toggle, legend, status, endpoints, i18n keys, 44px target);
//   2. behaviour -- the real shipped pure helpers (extracted from the module
//      source by brace matching, not copied) are evaluated against fixtures:
//      card-id bridge extraction, anchor ranking, 1-hop neighbour + file caps,
//      edge dedupe, and the type-generic `decision` node.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MODULE = readFileSync(join(__dirname, '../../web/app-memories.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')

type Refs = Map<string, number>
type Anchor = { id: string; mentions: number }
type RelEdge = { from_type: string; from_id: string; to_type: string; to_id: string; relation_type: string }
type FileRow = { id: string; repo: string; path: string; shas: string[] }
type Layer = {
  nodes: Array<{ kind: string; id: string; mentions: number; anchor: boolean }>
  files: Array<{ id: string; repo: string; path: string; cardIds: string[] }>
  edges: Array<{ from: string; to: string; type: string }>
}
type Caps = { maxAnchors: number; maxCards: number; maxFilesPerCard: number; maxFiles: number }
type Helpers = {
  graphRelExtractCardRefs: (memories: Array<{ content?: string; keywords?: string }>, known: Set<string>) => Refs
  graphRelPickAnchors: (refs: Refs, max: number) => Anchor[]
  graphRelBuildLayer: (anchors: Anchor[], relEdges: RelEdge[], filesByCard: Map<string, FileRow[]>, caps: Caps) => Layer
}

function extractFn(name: string): string | null {
  const re = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = re.exec(MODULE)
  if (!m) return null
  let depth = 0
  for (let j = MODULE.indexOf('{', m.index); j < MODULE.length; j++) {
    if (MODULE[j] === '{') depth++
    else if (MODULE[j] === '}' && --depth === 0) return MODULE.slice(m.index, j + 1)
  }
  return null
}

function extractConst(name: string): string {
  const m = new RegExp(`^const ${name} = .*$`, 'm').exec(MODULE)
  if (!m) throw new Error(`const ${name} missing from web/app-memories.js`)
  return m[0]
}

let helpers: Helpers
beforeAll(() => {
  const parts = ['graphRelExtractCardRefs', 'graphRelPickAnchors', 'graphRelBuildLayer'].map((n) => {
    const src = extractFn(n)
    if (!src) throw new Error(`${n} missing from web/app-memories.js`)
    return src
  })
  const body = `
    ${extractConst('GRAPH_REL_ID_RE')}
    ${parts.join('\n')}
    return { graphRelExtractCardRefs, graphRelPickAnchors, graphRelBuildLayer }
  `
  helpers = new Function(body)() as Helpers
})

const CAPS: Caps = { maxAnchors: 50, maxCards: 110, maxFilesPerCard: 12, maxFiles: 120 }

describe('relation layer: string contract (module)', () => {
  it('ships the pure helpers and the loader', () => {
    expect(MODULE).toContain('function graphRelExtractCardRefs(')
    expect(MODULE).toContain('function graphRelPickAnchors(')
    expect(MODULE).toContain('function graphRelBuildLayer(')
    expect(MODULE).toContain('async function loadRelationLayer(')
    expect(MODULE).toContain('function mergeRelationLayerIntoGraph(')
    expect(MODULE).toContain('function setRelationLayerStatus(')
  })

  it('talks to the FELADAT 3 contract endpoints only (raw edges paged, 2-hop files per card)', () => {
    expect(MODULE).toContain('/api/kanban/relations?${params}')
    expect(MODULE).toContain("from_type: 'card'")
    expect(MODULE).toContain('/api/kanban/relations/files?card=${encodeURIComponent(id)}')
    expect(MODULE).not.toContain('/api/kanban/relations/cards')
    // paging follows the response's `total`, never assumes one page
    expect(MODULE).toMatch(/offset >= \(Number\(data\.total\)/)
  })

  it('hides sha nodes and keeps every other node type (decision-ready)', () => {
    expect(MODULE).toContain("if (e.to_type !== 'sha') relEdges.push(e)")
    expect(MODULE).toMatch(/GRAPH_REL_COLORS = \{ card: '#[0-9a-f]{6}', file: '#[0-9a-f]{6}', decision: '#[0-9a-f]{6}', other: '#[0-9a-f]{6}' \}/)
    expect(MODULE).toContain("if (node.kind === 'decision')")
  })

  it('memory nodes are tagged kind: mem and the tier physics skip relation nodes', () => {
    expect(MODULE).toContain("kind: 'mem',")
    expect((MODULE.match(/if \(node\.kind !== 'mem'\) continue/g) || []).length).toBeGreaterThanOrEqual(3)
  })

  it('relation edges are dashed and the dash is reset after the edge pass', () => {
    expect(MODULE).toContain("ctx.setLineDash(edge.rel === 'mention' ? [2, 4] : (edge.rel ? [5, 3] : []))")
    expect(MODULE).toContain('ctx.setLineDash([])')
  })

  it('search covers relation nodes without touching node.mem', () => {
    expect(MODULE).toContain("} else if (node.kind !== 'mem') {")
    expect(MODULE).toContain('${node.relId} ${node.label} ${node.path || \'\'} ${node.title || \'\'}')
  })

  it('persists the toggle per viewer, guarded against a throwing localStorage', () => {
    expect(MODULE).toContain("const GRAPH_REL_STORAGE_KEY = 'cc-mem-graph-rel-layer'")
    expect(MODULE).toContain("try { graphRelLayerOn = localStorage.getItem(GRAPH_REL_STORAGE_KEY) === '1' } catch {}")
    expect(MODULE).toContain("try { localStorage.setItem(GRAPH_REL_STORAGE_KEY, graphRelLayerOn ? '1' : '0') } catch {}")
  })

  it('a stale in-flight load cannot merge into a newer graph (sequence guard)', () => {
    expect(MODULE).toContain('const seq = ++graphRelLoadSeq')
    expect((MODULE.match(/if \(seq !== graphRelLoadSeq\) return/g) || []).length).toBeGreaterThanOrEqual(3)
  })

  it('offline is reported as its own state, error state has a retry (rule 12)', () => {
    expect(MODULE).toContain("setRelationLayerStatus(navigator.onLine === false ? 'offline' : 'error')")
    expect(MODULE).toContain("retry.addEventListener('click', () => loadRelationLayer(graphLastMemories))")
  })

  it('card panel: 404 is "missing", other failures retry, and the detail opens on the kanban page', () => {
    expect(MODULE).toContain('if (res.status === 404) meta = { missing: true }')
    expect(MODULE).toContain("t('memories.graph.rel.card_missing')")
    expect(MODULE).toContain("document.getElementById('graphRelCardRetry').addEventListener('click', () => fillRelationCardPanel(node))")
    expect(MODULE).toContain("switchPage('kanban')")
    expect(MODULE).toContain('showCardDetail(card)')
  })

  it('panel text goes through escapeHtml (card titles and file paths are untrusted)', () => {
    expect(MODULE).toContain('${escapeHtml(card.title || \'\')}')
    expect(MODULE).toContain('${escapeHtml(node.path)}')
    expect(MODULE).toContain('${escapeHtml(String(node.relId))}')
  })
})

describe('relation layer: string contract (HTML / CSS / i18n)', () => {
  it('index.html carries the toggle (aria-pressed), legend and live status region inside the graph view', () => {
    const view = HTML.slice(HTML.indexOf('id="memGraphView"'), HTML.indexOf('id="memLogView"'))
    expect(view).toContain('id="graphRelToggle" aria-pressed="false"')
    expect(view).toContain('data-i18n="memories.graph.rel.toggle"')
    expect(view).toContain('id="graphRelLegend" hidden')
    expect(view).toContain('data-kind="decision" hidden')
    expect(view).toContain('id="graphRelStatus" role="status" aria-live="polite" hidden')
  })

  it('the toggle and the panel action are 44px touch targets; the panel goes bottom-sheet on small screens (rule 13)', () => {
    const toggle = CSS.slice(CSS.indexOf('.graph-layer-toggle {'), CSS.indexOf('.graph-layer-toggle:hover'))
    expect(toggle).toContain('min-height: 44px')
    expect(CSS).toContain('.graph-rel-action { min-height: 44px; }')
    const mobile = CSS.slice(CSS.indexOf('/* === Kanban relation layer on the memory graph'))
    expect(mobile).toContain('@media (max-width: 640px)')
    expect(mobile).toMatch(/\.graph-panel \{[^}]*bottom: 12px;[^}]*width: auto;/s)
  })

  it('every i18n key the module uses exists in BOTH hu.js and en.js', async () => {
    ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {}
    await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
    await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
    const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n
    const literal = [...MODULE.matchAll(/t\('(memories\.graph\.rel\.[a-z_]+)'/g)].map((m) => m[1])
    const dynamicStates = ['loading', 'empty', 'error', 'offline'].map((s) => `memories.graph.rel.${s}`)
    const dynamicKinds = ['card', 'file', 'decision'].map((k) => `memories.graph.rel.${k}`)
    const fromHtml = [...HTML.matchAll(/data-i18n="(memories\.graph\.rel\.[a-z_]+)"/g)].map((m) => m[1])
    const keys = new Set([...literal, ...dynamicStates, ...dynamicKinds, ...fromHtml])
    expect(keys.size).toBeGreaterThanOrEqual(15)
    const missing: string[] = []
    for (const k of keys) {
      if (!i18n.hu[k]) missing.push(`hu:${k}`)
      if (!i18n.en[k]) missing.push(`en:${k}`)
    }
    expect(missing).toEqual([])
    expect(i18n.hu['memories.graph.rel.mentions']).toContain('{n}')
    expect(i18n.en['memories.graph.rel.mentions']).toContain('{n}')
  })
})

describe('relation layer: graphRelExtractCardRefs (memory -> card bridge)', () => {
  it('counts a card once per memory, case-insensitively, from content AND keywords, only for known ids', () => {
    const known = new Set(['3bd18e70', '69396b63', 'fe3eff9f'])
    const refs = helpers.graphRelExtractCardRefs(
      [
        { content: 'card 3bd18e70 depends on 69396B63, again 3bd18e70', keywords: 'fe3eff9f, graph' },
        { content: 'unrelated deadbeef and 3bd18e70' },
        { content: 'sha-looking a1b2c3d4 only' },
      ],
      known,
    )
    expect([...refs.entries()].sort()).toEqual([
      ['3bd18e70', 2],
      ['69396b63', 1],
      ['fe3eff9f', 1],
    ])
  })

  it('does not match a hex run that is part of a longer token (a 40-hex sha is not eight card ids)', () => {
    const known = new Set(['827ff22f'])
    const refs = helpers.graphRelExtractCardRefs([{ content: '827ff22f0000000000000000000000000000abcd' }], known)
    expect(refs.size).toBe(0)
  })
})

describe('relation layer: graphRelPickAnchors', () => {
  it('orders by mentions desc, id asc, and caps', () => {
    const refs: Refs = new Map([
      ['bbbbbbbb', 2],
      ['aaaaaaaa', 2],
      ['cccccccc', 5],
      ['dddddddd', 1],
    ])
    expect(helpers.graphRelPickAnchors(refs, 3)).toEqual([
      { id: 'cccccccc', mentions: 5 },
      { id: 'aaaaaaaa', mentions: 2 },
      { id: 'bbbbbbbb', mentions: 2 },
    ])
  })
})

describe('relation layer: graphRelBuildLayer', () => {
  const anchors: Anchor[] = [{ id: 'a1a1a1a1', mentions: 3 }]
  const edges: RelEdge[] = [
    { from_type: 'card', from_id: 'a1a1a1a1', to_type: 'card', to_id: 'p0p0p0p0', relation_type: 'child-of' },
    { from_type: 'card', from_id: 'a1a1a1a1', to_type: 'card', to_id: 'p0p0p0p0', relation_type: 'child-of' }, // duplicate row
    { from_type: 'card', from_id: 'f2f2f2f2', to_type: 'card', to_id: 'a1a1a1a1', relation_type: 'pair-fe' },
    { from_type: 'card', from_id: 'p0p0p0p0', to_type: 'card', to_id: 'zzzzzzzz', relation_type: 'child-of' }, // 2 hops away: excluded
    { from_type: 'card', from_id: 'a1a1a1a1', to_type: 'decision', to_id: 'DEC-2026-09-03-1', relation_type: 'decided-by' },
  ]

  it('adds 1-hop neighbours of any type (decision included), never 2-hop, and dedupes edges', () => {
    const layer = helpers.graphRelBuildLayer(anchors, edges, new Map(), CAPS)
    const ids = layer.nodes.map((n) => `${n.kind}:${n.id}`).sort()
    expect(ids).toEqual(['card:a1a1a1a1', 'card:f2f2f2f2', 'card:p0p0p0p0', 'decision:DEC-2026-09-03-1'])
    expect(layer.nodes.find((n) => n.id === 'a1a1a1a1')?.anchor).toBe(true)
    expect(layer.nodes.find((n) => n.id === 'p0p0p0p0')?.anchor).toBe(false)
    expect(layer.edges).toEqual([
      { from: 'card:a1a1a1a1', to: 'card:p0p0p0p0', type: 'child-of' },
      { from: 'card:f2f2f2f2', to: 'card:a1a1a1a1', type: 'pair-fe' },
      { from: 'card:a1a1a1a1', to: 'decision:DEC-2026-09-03-1', type: 'decided-by' },
    ])
  })

  it('stops adding neighbours at maxCards but keeps the anchors', () => {
    const many: RelEdge[] = Array.from({ length: 10 }, (_, i) => ({
      from_type: 'card', from_id: 'a1a1a1a1', to_type: 'card', to_id: `c${i}c${i}c${i}c${i}`, relation_type: 'child-of',
    }))
    const layer = helpers.graphRelBuildLayer(anchors, many, new Map(), { ...CAPS, maxCards: 4 })
    expect(layer.nodes.length).toBe(4)
    expect(layer.nodes[0]).toEqual({ kind: 'card', id: 'a1a1a1a1', mentions: 3, anchor: true })
    expect(layer.edges.length).toBe(3)
  })

  it('files: per-card cap prefers more shas then path, global cap prefers shared files, edges are touches-file', () => {
    const files = new Map<string, FileRow[]>([
      ['a1a1a1a1', [
        { id: 'r:z.ts', repo: 'r', path: 'z.ts', shas: ['1'] },
        { id: 'r:a.ts', repo: 'r', path: 'a.ts', shas: ['1'] },
        { id: 'r:shared.ts', repo: 'r', path: 'shared.ts', shas: ['1', '2'] },
      ]],
      ['b2b2b2b2', [
        { id: 'r:shared.ts', repo: 'r', path: 'shared.ts', shas: ['3'] },
        { id: 'r:only-b.ts', repo: 'r', path: 'only-b.ts', shas: ['3'] },
      ]],
    ])
    const two: Anchor[] = [{ id: 'a1a1a1a1', mentions: 3 }, { id: 'b2b2b2b2', mentions: 1 }]
    const layer = helpers.graphRelBuildLayer(two, [], files, { ...CAPS, maxFilesPerCard: 2, maxFiles: 2 })
    // per-card: a -> [shared(2 shas), a.ts]; b -> [only-b, shared] (path asc on equal sha count)
    // global cap 2 by cardIds desc then id asc: shared (2 cards), then r:a.ts vs r:only-b.ts -> 'r:a.ts'
    expect(layer.files.map((f) => f.id)).toEqual(['r:shared.ts', 'r:a.ts'])
    expect(layer.files[0].cardIds).toEqual(['a1a1a1a1', 'b2b2b2b2'])
    expect(layer.edges).toEqual([
      { from: 'card:a1a1a1a1', to: 'file:r:shared.ts', type: 'touches-file' },
      { from: 'card:b2b2b2b2', to: 'file:r:shared.ts', type: 'touches-file' },
      { from: 'card:a1a1a1a1', to: 'file:r:a.ts', type: 'touches-file' },
    ])
  })

  it('an anchor with no files and no edges still yields its own node', () => {
    const layer = helpers.graphRelBuildLayer(anchors, [], new Map(), CAPS)
    expect(layer).toEqual({ nodes: [{ kind: 'card', id: 'a1a1a1a1', mentions: 3, anchor: true }], files: [], edges: [] })
  })
})
