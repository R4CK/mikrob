// Card dcb196f9 -- Megoldas-tar live nebula graph (agents + KG nodes, flashing search trails).
// Pure-function layer of web/app-kg-nebula.js, executed under a window shim (same recipe as
// llm-monitor-module.test.ts): trail fade/colour math, deterministic per-agent colour
// assignment, legend building, and the deterministic static layout.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '../../web')

type Pos = { x: number; y: number }
type Win = {
  kgNebulaTrailAlpha: (nowMs: number, startMs: number, fadeMs: number) => number
  kgNebulaTrailRgba: (baseColorCss: string, nowMs: number, startMs: number, fadeMs: number) => string
  kgNebulaAgentColor: (agentId: string) => string
  kgNebulaAgentColorIndex: (agentId: string) => number
  kgNebulaBuildLegend: (agentIds: string[]) => { agentId: string; color: string; paletteIndex: number }[]
  kgNebulaActiveTrails: (events: { agent_id: string; ts: number; hit: string[] }[], nowMs: number, fadeMs: number) => unknown[]
  kgNebulaLayout: (nodes: { id: string; project?: string }[], edges: { source: string; target: string }[], w: number, h: number, iterations?: number) => Map<string, Pos>
  kgNebulaDegreeMap: (nodes: { id: string }[], edges: { source: string; target: string }[]) => Map<string, number>
  kgNebulaClusterGeometry: (nodes: { id: string }[], positions: Map<string, Pos & { bucket?: number }>) => { bucket: number; cx: number; cy: number; r: number; count: number }[]
  kgNebulaAgentRingPositions: (agentIds: string[], ringR: number) => Map<string, Pos>
  kgNebulaCurveControl: (ax: number, ay: number, bx: number, by: number, seedKey: string) => { cx: number; cy: number }
}

let win: Win
beforeAll(async () => {
  const g = globalThis as unknown as { window: Record<string, unknown> }
  g.window ||= {}
  await import(/* @vite-ignore */ join(WEB, 'app-kg-nebula.js') as string)
  win = g.window as unknown as Win
})

describe('the module is importable without a DOM', () => {
  it('exposes the pure helpers', () => {
    expect(typeof win.kgNebulaTrailAlpha).toBe('function')
    expect(typeof win.kgNebulaAgentColor).toBe('function')
    expect(typeof win.kgNebulaLayout).toBe('function')
  })
})

describe('kgNebulaTrailAlpha -- 15s (configurable) linear fade, measured with fake timers', () => {
  it('starts fully opaque and reaches zero at/after the fade window, default 15000ms', () => {
    vi.useFakeTimers()
    const start = Date.now()
    expect(win.kgNebulaTrailAlpha(Date.now(), start, 15000)).toBe(1)
    vi.advanceTimersByTime(7500)
    expect(win.kgNebulaTrailAlpha(Date.now(), start, 15000)).toBeCloseTo(0.5, 2)
    vi.advanceTimersByTime(7499)
    expect(win.kgNebulaTrailAlpha(Date.now(), start, 15000)).toBeGreaterThan(0)
    vi.advanceTimersByTime(2)
    expect(win.kgNebulaTrailAlpha(Date.now(), start, 15000)).toBe(0)
    vi.useRealTimers()
  })
  it('is measured at 15s +/- 1s: alpha is ~0 within that band and not before it', () => {
    vi.useFakeTimers()
    const start = Date.now()
    vi.advanceTimersByTime(14000) // 1s before nominal end
    expect(win.kgNebulaTrailAlpha(Date.now(), start, 15000)).toBeGreaterThan(0)
    vi.advanceTimersByTime(2000) // 1s after nominal end
    expect(win.kgNebulaTrailAlpha(Date.now(), start, 15000)).toBe(0)
    vi.useRealTimers()
  })
  it('honours a non-default fade duration from config (no hardcoded 15000)', () => {
    vi.useFakeTimers()
    const start = Date.now()
    vi.advanceTimersByTime(3000)
    expect(win.kgNebulaTrailAlpha(Date.now(), start, 6000)).toBeCloseTo(0.5, 2)
    vi.useRealTimers()
  })
  it('never goes negative or above 1 for out-of-range inputs', () => {
    expect(win.kgNebulaTrailAlpha(1000, 2000, 15000)).toBe(1) // "started in the future" clamps to 1
    expect(win.kgNebulaTrailAlpha(100000, 0, 15000)).toBe(0)
  })
})

describe('kgNebulaTrailRgba -- hot-white birth cooling into the agent colour, alpha from the fade', () => {
  it('is near-white at t=0 and settles toward the base colour as it cools', () => {
    vi.useFakeTimers()
    const start = Date.now()
    const base = win.kgNebulaAgentColor('backend')
    const atBirth = win.kgNebulaTrailRgba(base, Date.now(), start, 15000)
    const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(atBirth)!
    const [, r, g, b, a] = m.map(Number) as unknown as number[]
    expect(Number(a)).toBe(1)
    expect(Number(r) + Number(g) + Number(b)).toBeGreaterThan(600) // close to 255*3 = white
    vi.advanceTimersByTime(14999)
    const nearEnd = win.kgNebulaTrailRgba(base, Date.now(), start, 15000)
    const m2 = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(nearEnd)!
    expect(Number(m2[4])).toBeLessThan(0.01)
    vi.useRealTimers()
  })
})

describe('kgNebulaAgentColor -- deterministic, distinct per agent', () => {
  const agents = ['mikrob', 'backend', 'backend2', 'backend3', 'cybered', 'cybersec', 'cybersec2',
    'elemzo', 'fron-ted', 'fron-teddy', 'fullstack', 'jogasz', 'marketing', 'penzugy', 'qa', 'qa2',
    'teszter', 'videooo']

  it('is a pure function of the agent id -- same input, same output, every call', () => {
    for (const a of agents) {
      expect(win.kgNebulaAgentColor(a)).toBe(win.kgNebulaAgentColor(a))
    }
  })

  it('gives every known fleet agent a distinct colour slot', () => {
    const indices = new Set(agents.map((a) => win.kgNebulaAgentColorIndex(a)))
    expect(indices.size).toBe(agents.length)
  })

  it('still returns a stable colour for an agent outside the known list', () => {
    const c1 = win.kgNebulaAgentColor('some-future-agent')
    const c2 = win.kgNebulaAgentColor('some-future-agent')
    expect(c1).toBe(c2)
  })
})

describe('kgNebulaBuildLegend', () => {
  it('dedupes repeated agent ids and keeps first-seen order', () => {
    const legend = win.kgNebulaBuildLegend(['backend', 'qa', 'backend'])
    expect(legend.map((e) => e.agentId)).toEqual(['backend', 'qa'])
  })
  it('returns an empty list for no activity (legend_empty text is a DOM-layer concern)', () => {
    expect(win.kgNebulaBuildLegend([])).toEqual([])
  })
})

describe('kgNebulaActiveTrails -- drops fully-faded events', () => {
  it('keeps events still inside the fade window and drops expired ones', () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const events = [
      { agent_id: 'backend', ts: t0, hit: ['n1'] },
      { agent_id: 'qa', ts: t0 - 20000, hit: ['n2'] }, // already expired at default 15000ms
    ]
    const active = win.kgNebulaActiveTrails(events, Date.now(), 15000)
    expect(active).toHaveLength(1)
    expect((active[0] as { agentId: string }).agentId).toBe('backend')
    vi.useRealTimers()
  })
})

describe('kgNebulaLayout -- deterministic static force layout', () => {
  const nodes = [
    { id: 'a', project: 'marveen' }, { id: 'b', project: 'marveen' },
    { id: 'c', project: 'mopsion' }, { id: 'd', project: 'mopsion' },
  ]
  const edges = [{ source: 'a', target: 'b' }, { source: 'c', target: 'd' }]

  it('is deterministic: identical input gives identical positions', () => {
    const p1 = win.kgNebulaLayout(nodes, edges, 400, 300, 40)
    const p2 = win.kgNebulaLayout(nodes, edges, 400, 300, 40)
    for (const n of nodes) {
      expect(p1.get(n.id)).toEqual(p2.get(n.id))
    }
  })

  it('places every node within the canvas bounds', () => {
    const p = win.kgNebulaLayout(nodes, edges, 400, 300, 40)
    for (const n of nodes) {
      const pos = p.get(n.id)!
      expect(Math.abs(pos.x)).toBeLessThanOrEqual(200)
      expect(Math.abs(pos.y)).toBeLessThanOrEqual(150)
    }
  })

  it('does not blow up or hang on a larger synthetic graph (perf smoke, not the real fps measurement)', () => {
    const big = Array.from({ length: 200 }, (_, i) => ({ id: 'n' + i, project: i % 3 === 0 ? 'marveen' : 'mopsion' }))
    const bigEdges = Array.from({ length: 150 }, (_, i) => ({ source: 'n' + i, target: 'n' + ((i + 1) % 200) }))
    const start = performance.now()
    const p = win.kgNebulaLayout(big, bigEdges, 800, 600, 60)
    expect(p.size).toBe(200)
    expect(performance.now() - start).toBeLessThan(2000)
  })
})

describe('kgNebulaDegreeMap -- node glow/size driver (MikroB feedback 2026-11-22: hubs should read brighter than leaves)', () => {
  it('counts edges per node, zero for an isolated node', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'lonely' }]
    const edges = [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }]
    const deg = win.kgNebulaDegreeMap(nodes, edges)
    expect(deg.get('a')).toBe(2)
    expect(deg.get('b')).toBe(1)
    expect(deg.get('lonely')).toBe(0)
  })
})

describe('kgNebulaClusterGeometry -- per-project gas-cloud centroid/radius for the nebula backdrop', () => {
  it('centres each cluster on the mean of its own settled nodes, not the canvas origin', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const positions = new Map([
      ['a', { x: 10, y: 10, bucket: 0 }],
      ['b', { x: 30, y: 10, bucket: 0 }],
      ['c', { x: -100, y: -100, bucket: 1 }],
    ])
    const clusters = win.kgNebulaClusterGeometry(nodes, positions)
    const c0 = clusters.find((c) => c.bucket === 0)!
    const c1 = clusters.find((c) => c.bucket === 1)!
    expect(c0.cx).toBeCloseTo(20, 5)
    expect(c0.cy).toBeCloseTo(10, 5)
    expect(c0.count).toBe(2)
    expect(c1.cx).toBeCloseTo(-100, 5)
    expect(c1.count).toBe(1)
  })
})

describe('kgNebulaAgentRingPositions -- each agent is its own positioned entity (MikroB feedback 2026-11-22: "agents are not visible as entities")', () => {
  it('gives every agent a distinct point on the ring, deterministic regardless of input order', () => {
    const p1 = win.kgNebulaAgentRingPositions(['backend', 'qa', 'cybered'], 100)
    const p2 = win.kgNebulaAgentRingPositions(['cybered', 'backend', 'qa'], 100)
    expect(p1.get('backend')).toEqual(p2.get('backend'))
    expect(p1.get('qa')).toEqual(p2.get('qa'))
    const seen = new Set(['backend', 'qa', 'cybered'].map((id) => JSON.stringify(p1.get(id))))
    expect(seen.size).toBe(3) // no two agents collapse onto the same point
  })

  it('places every agent at the requested ring radius from the centre', () => {
    const p = win.kgNebulaAgentRingPositions(['backend', 'qa', 'cybered', 'fron-ted'], 150)
    for (const pos of p.values()) {
      expect(Math.hypot(pos.x, pos.y)).toBeCloseTo(150, 5)
    }
  })
})

describe('kgNebulaCurveControl -- trails are curved, not straight lines through one centre point', () => {
  it('returns a control point off the direct line between the two endpoints', () => {
    const { cx, cy } = win.kgNebulaCurveControl(0, 0, 100, 0, 'backend:n1')
    // The midpoint of a straight line from (0,0) to (100,0) is (50,0); a real bow moves cy off 0.
    expect(cx).toBeCloseTo(50, 0)
    expect(Math.abs(cy)).toBeGreaterThan(0)
  })

  it('is deterministic for the same agent/hit pair', () => {
    const a = win.kgNebulaCurveControl(0, 0, 100, 40, 'qa:n7')
    const b = win.kgNebulaCurveControl(0, 0, 100, 40, 'qa:n7')
    expect(a).toEqual(b)
  })
})
