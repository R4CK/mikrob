// Card dcb196f9 -- Megoldas-tar live nebula graph (agents + KG nodes, flashing search trails),
// round 4: a real 3D scene (Peti requirement change, msg 23664). Pure-function layer of
// web/app-kg-nebula.js, executed under a window shim (same recipe as llm-monitor-module.test.ts):
// trail fade/colour math, deterministic per-agent colour assignment, legend building, and the
// deterministic 3D layout (cluster spheres, node blobs, hub selection, agent sphere, curve bow).
// three.js itself is NOT imported here -- these are the plain-JS math functions the 3D scene
// consumes, the same split this page already uses for every other classic-script module.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '../../web')

type Vec3 = { x: number; y: number; z: number }
type Win = {
  kgNebulaTrailAlpha: (nowMs: number, startMs: number, fadeMs: number) => number
  kgNebulaTrailRgba: (baseColorCss: string, nowMs: number, startMs: number, fadeMs: number) => { r: number; g: number; b: number; alpha: number; css: string }
  kgNebulaAgentColor: (agentId: string) => string
  kgNebulaAgentColorIndex: (agentId: string) => number
  kgNebulaBuildLegend: (agentIds: string[]) => { agentId: string; color: string; paletteIndex: number }[]
  kgNebulaActiveTrails: (events: { agent_id: string; ts: number; hit: string[] }[], nowMs: number, fadeMs: number) => unknown[]
  kgNebulaDegreeMap: (nodes: { id: string }[], edges: { source: string; target: string }[]) => Map<string, number>
  kgNebulaBucketKey: (node: { project?: string; type?: string }) => string
  kgNebulaProjectBuckets: (nodes: { project?: string; type?: string }[]) => Map<string, number>
  kgNebulaFibonacciSpherePoints: (n: number, radius: number) => Vec3[]
  kgNebulaNode3DPositions: (nodes: { id: string; project?: string; type?: string }[]) => Map<string, Vec3 & { bucket: number }>
  kgNebulaClusterGeometry3D: (nodes: { id: string }[], positions: Map<string, Vec3 & { bucket?: number }>) => { bucket: number; cx: number; cy: number; cz: number; r: number; count: number }[]
  kgNebulaHubNodeIds: (nodes: { id: string }[], edges: { source: string; target: string }[], topPerBucket?: number) => Set<string>
  kgNebulaAgentSpherePositions: (agentIds: string[], radius: number) => Map<string, Vec3>
  kgNebulaCurveControl3D: (ax: number, ay: number, az: number, bx: number, by: number, bz: number, seedKey: string) => { cx: number; cy: number; cz: number }
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
    expect(typeof win.kgNebulaNode3DPositions).toBe('function')
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
    vi.advanceTimersByTime(14000)
    expect(win.kgNebulaTrailAlpha(Date.now(), start, 15000)).toBeGreaterThan(0)
    vi.advanceTimersByTime(2000)
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
    expect(win.kgNebulaTrailAlpha(1000, 2000, 15000)).toBe(1)
    expect(win.kgNebulaTrailAlpha(100000, 0, 15000)).toBe(0)
  })
})

describe('kgNebulaTrailRgba -- hot-white birth cooling into the agent colour, alpha from the fade', () => {
  it('is near-white at t=0 and settles toward the base colour as it cools', () => {
    vi.useFakeTimers()
    const start = Date.now()
    const base = win.kgNebulaAgentColor('backend')
    const atBirth = win.kgNebulaTrailRgba(base, Date.now(), start, 15000)
    expect(atBirth.alpha).toBe(1)
    expect(atBirth.r + atBirth.g + atBirth.b).toBeGreaterThan(600) // close to 255*3 = white
    vi.advanceTimersByTime(14999)
    const nearEnd = win.kgNebulaTrailRgba(base, Date.now(), start, 15000)
    expect(nearEnd.alpha).toBeLessThan(0.01)
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
      { agent_id: 'qa', ts: t0 - 20000, hit: ['n2'] },
    ]
    const active = win.kgNebulaActiveTrails(events, Date.now(), 15000)
    expect(active).toHaveLength(1)
    expect((active[0] as { agentId: string }).agentId).toBe('backend')
    vi.useRealTimers()
  })
})

describe('kgNebulaDegreeMap -- node glow/size driver (hubs should read brighter than leaves)', () => {
  it('counts edges per node, zero for an isolated node', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'lonely' }]
    const edges = [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }]
    const deg = win.kgNebulaDegreeMap(nodes, edges)
    expect(deg.get('a')).toBe(2)
    expect(deg.get('b')).toBe(1)
    expect(deg.get('lonely')).toBe(0)
  })
})

describe('kgNebulaBucketKey / kgNebulaProjectBuckets -- project+type topic clusters', () => {
  it('buckets by project+type together, not project alone', () => {
    const nodes = [
      { id: 'a', project: 'marveen', type: 'solution' },
      { id: 'b', project: 'marveen', type: 'card' },
      { id: 'c', project: 'mopsion', type: 'solution' },
    ]
    const buckets = win.kgNebulaProjectBuckets(nodes)
    expect(buckets.size).toBe(3)
  })
})

describe('kgNebulaFibonacciSpherePoints -- even 3D spread, deterministic', () => {
  it('is deterministic: same n/radius gives the same points', () => {
    const p1 = win.kgNebulaFibonacciSpherePoints(8, 100)
    const p2 = win.kgNebulaFibonacciSpherePoints(8, 100)
    expect(p1).toEqual(p2)
  })
  it('places every point at (approximately) the requested radius from the origin', () => {
    const points = win.kgNebulaFibonacciSpherePoints(12, 150)
    for (const p of points) {
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(150, 5)
    }
  })
  it('does not collapse distinct points onto the same spot (no two clusters overlap exactly)', () => {
    const points = win.kgNebulaFibonacciSpherePoints(10, 100)
    const seen = new Set(points.map((p) => JSON.stringify(p)))
    expect(seen.size).toBe(10)
  })
  it('handles n=1 without dividing by zero', () => {
    const points = win.kgNebulaFibonacciSpherePoints(1, 100)
    expect(points).toHaveLength(1)
    expect(Number.isFinite(points[0].x)).toBe(true)
  })
})

describe('kgNebulaNode3DPositions -- deterministic per-cluster blob layout', () => {
  const nodes = [
    { id: 'a', project: 'marveen', type: 'solution' },
    { id: 'b', project: 'marveen', type: 'solution' },
    { id: 'c', project: 'mopsion', type: 'card' },
  ]

  it('is deterministic: identical input gives identical positions', () => {
    const p1 = win.kgNebulaNode3DPositions(nodes)
    const p2 = win.kgNebulaNode3DPositions(nodes)
    for (const n of nodes) expect(p1.get(n.id)).toEqual(p2.get(n.id))
  })

  it('places every node within its own cluster blob radius of its bucket centre', () => {
    const positions = win.kgNebulaNode3DPositions(nodes)
    const buckets = win.kgNebulaProjectBuckets(nodes)
    const centers = win.kgNebulaFibonacciSpherePoints(buckets.size, 150)
    for (const n of nodes) {
      const p = positions.get(n.id)!
      const bucket = buckets.get(win.kgNebulaBucketKey(n))!
      const c = centers[bucket]
      const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z)
      expect(d).toBeLessThanOrEqual(70 + 0.01) // KG_NEBULA_BLOB_MAX
    }
  })

  it('does not blow up or hang on a larger synthetic graph (perf smoke)', () => {
    const big = Array.from({ length: 736 }, (_, i) => ({
      id: 'n' + i, project: i % 3 === 0 ? 'marveen' : 'mopsion', type: ['solution', 'skill', 'card', 'agent-note'][i % 4],
    }))
    const start = performance.now()
    const p = win.kgNebulaNode3DPositions(big)
    expect(p.size).toBe(736)
    expect(performance.now() - start).toBeLessThan(500)
  })
})

describe('kgNebulaClusterGeometry3D -- per-topic gas-cloud centroid/radius', () => {
  it('centres each cluster on the mean of its own settled nodes, not the origin', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const positions = new Map([
      ['a', { x: 10, y: 10, z: 0, bucket: 0 }],
      ['b', { x: 30, y: 10, z: 0, bucket: 0 }],
      ['c', { x: -100, y: -100, z: 50, bucket: 1 }],
    ])
    const clusters = win.kgNebulaClusterGeometry3D(nodes, positions)
    const c0 = clusters.find((c) => c.bucket === 0)!
    const c1 = clusters.find((c) => c.bucket === 1)!
    expect(c0.cx).toBeCloseTo(20, 5)
    expect(c0.cy).toBeCloseTo(10, 5)
    expect(c0.count).toBe(2)
    expect(c1.cx).toBeCloseTo(-100, 5)
    expect(c1.cz).toBeCloseTo(50, 5)
    expect(c1.count).toBe(1)
  })
})

describe('kgNebulaHubNodeIds -- hub cores spread across clusters, never a degree-0 leaf', () => {
  it('picks the top-degree node(s) per bucket, not just the global top', () => {
    const nodes = [
      { id: 'a1', project: 'p1' }, { id: 'a2', project: 'p1' }, { id: 'a3', project: 'p1' },
      { id: 'b1', project: 'p2' }, { id: 'b2', project: 'p2' },
    ]
    const edges = [
      { source: 'a1', target: 'a2' }, { source: 'a1', target: 'a3' }, // a1 degree 2 (cluster p1 hub)
      { source: 'b1', target: 'b2' }, // b1/b2 degree 1 each
    ]
    const hubs = win.kgNebulaHubNodeIds(nodes, edges, 1)
    expect(hubs.has('a1')).toBe(true)
    expect(hubs.has('b1') || hubs.has('b2')).toBe(true) // p2 still gets its own hub
  })
  it('never promotes a degree-0 node to hub', () => {
    const nodes = [{ id: 'lonely', project: 'p1' }]
    const hubs = win.kgNebulaHubNodeIds(nodes, [], 2)
    expect(hubs.size).toBe(0)
  })
})

describe('kgNebulaAgentSpherePositions -- each agent its own positioned entity in 3D', () => {
  it('gives every agent a distinct point, deterministic regardless of input order', () => {
    const p1 = win.kgNebulaAgentSpherePositions(['backend', 'qa', 'cybered'], 100)
    const p2 = win.kgNebulaAgentSpherePositions(['cybered', 'backend', 'qa'], 100)
    expect(p1.get('backend')).toEqual(p2.get('backend'))
    expect(p1.get('qa')).toEqual(p2.get('qa'))
    const seen = new Set(['backend', 'qa', 'cybered'].map((id) => JSON.stringify(p1.get(id))))
    expect(seen.size).toBe(3)
  })

  it('places every agent at the requested sphere radius from the centre', () => {
    const p = win.kgNebulaAgentSpherePositions(['backend', 'qa', 'cybered', 'fron-ted'], 150)
    for (const pos of p.values()) {
      expect(Math.hypot(pos.x, pos.y, pos.z)).toBeCloseTo(150, 5)
    }
  })
})

describe('kgNebulaCurveControl3D -- trails are curved 3D arcs, not straight lines', () => {
  it('returns a control point off the direct line between the two endpoints', () => {
    const { cx, cy, cz } = win.kgNebulaCurveControl3D(0, 0, 0, 100, 0, 0, 'backend:n1')
    expect(cx).toBeCloseTo(50, 0)
    expect(Math.abs(cy) + Math.abs(cz)).toBeGreaterThan(0)
  })

  it('is deterministic for the same agent/hit pair', () => {
    const a = win.kgNebulaCurveControl3D(0, 0, 0, 100, 40, 20, 'qa:n7')
    const b = win.kgNebulaCurveControl3D(0, 0, 0, 100, 40, 20, 'qa:n7')
    expect(a).toEqual(b)
  })

  it('stays well-defined (no NaN) when the line is parallel to the reference up axis', () => {
    const { cx, cy, cz } = win.kgNebulaCurveControl3D(0, 0, 0, 0, 100, 0, 'edge-case')
    expect(Number.isFinite(cx)).toBe(true)
    expect(Number.isFinite(cy)).toBe(true)
    expect(Number.isFinite(cz)).toBe(true)
  })
})
