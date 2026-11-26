// Card dcb196f9 (MikroB, URGENT): "Megoldas-tar" live nebula graph -- agents + knowledge-graph
// nodes as one connected graph, with glowing search trails from an agent node to its hit nodes
// that cool down and fade over ~15s.
//
// Round 4 (Peti requirement change, msg 23664, 2026-11-22, Telegram 14507-14510): the flat 2D
// canvas view becomes a real 3D, mouse/touch-rotatable scene -- dense glowing particle-cloud
// clusters (not a grid), a volumetric gas haze per cluster, thin links between hub nodes, curved
// 3D search-trail arcs, orbit controls with idle auto-rotate that stops on interaction. Built with
// three.js (CDN, pinned 0.128.0, verified live -- see index.html) + its classic OrbitControls.js,
// after checking for a pre-built 3D force-graph lib (rule 10/GitHub-first): the "dense glowing
// irregular blob of particles per cluster" + volumetric haze + custom cooling-trail look needs
// per-cluster custom Object3D construction either way, so plain three.js (full control, smaller
// dependency surface, no extra force-graph/d3-force-3d/kapsule chain to vendor) was the better fit
// than wrapping a generic force-graph library and fighting its own node-rendering assumptions.
//
// Pair-BE: a1d57d99 (backend2) -- GET /api/kg/graph and GET /api/kg/activity. Both cards were
// `planned`/undispatched when this was first built, so EVERY network call below degrades to the
// existing honest "not available yet" state (kgShowDisabledState, already proven on this same
// page for the other /api/kg/* endpoints) -- it never fabricates demo nodes/edges/trails for a
// real user (rule 13 of kodminosegi-alapelvek: UI always shows real DB-backed data). The mock
// data is used ONLY by the unit tests and the local fps-measurement harness (never reachable from
// kgNebulaLoad()/the real page).
//
// Proposed contract (unchanged from round 1, still the mock data shape the unit tests use):
//   GET /api/kg/graph?project=&limit=500
//     -> { nodes: [{ id, type, label, project }], edges: [{ source, target, type }] }
//   GET /api/kg/activity?since=<ms>
//     -> { events: [{ agent_id, ts, hit: [nodeId, ...] }], config: { fadeDurationMs } }
//   config.fadeDurationMs is read every poll and overrides the 15000 default (rule 14: the fade
//   time is not a baked-in constant, it is always what the last config response said).

const KG_NEBULA_DEFAULT_FADE_MS = 15000
const KG_NEBULA_POLL_MS = 4000

// Colour-blind-safe-ish categorical palette: golden-angle hue stepping (137.508 deg) starting
// from a fixed seed hue, fixed S/L tuned for legibility on the dark nebula background. Index i
// maps 1:1 to the CSS class `.kg-neb-c<i>` in style.css (legend DOM only -- CSP: class-only, no
// inline style attributes; the 3D scene uses the same hex/hsl values directly as material colour,
// which is WebGL state, not a CSSOM/style mutation, so it is outside style-src's scope). This same
// palette is reused for BOTH the per-agent colour and the per-topic-cluster colour -- two
// different index spaces (agent index vs. bucket index), same deterministic function.
const KG_NEBULA_PALETTE_SIZE = 24
function kgNebulaPaletteColor(index) {
  const i = ((index % KG_NEBULA_PALETTE_SIZE) + KG_NEBULA_PALETTE_SIZE) % KG_NEBULA_PALETTE_SIZE
  const hue = Math.round((i * 137.508 + 18) % 360)
  return `hsl(${hue}, 72%, 62%)`
}

// Stable order for the agents we know about today (root CLAUDE.md "A flotta tobbi agense" +
// mikrob) -- sorted so the mapping does not depend on object/array iteration order anywhere.
// Any agent_id NOT in this list (a future agent) still gets a deterministic, distinct-looking
// slot via a simple string hash, it just is not guaranteed collision-free against this fixed set.
const KG_NEBULA_KNOWN_AGENTS = [
  'backend', 'backend2', 'backend3', 'cybered', 'cybersec', 'cybersec2', 'elemzo',
  'fron-ted', 'fron-teddy', 'fullstack', 'jogasz', 'marketing', 'mikrob', 'penzugy',
  'qa', 'qa2', 'teszter', 'videooo',
].sort()

function kgNebulaHashString(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 }
  return Math.abs(h)
}

function kgNebulaAgentColorIndex(agentId) {
  const known = KG_NEBULA_KNOWN_AGENTS.indexOf(agentId)
  if (known !== -1) return known
  return kgNebulaHashString(String(agentId)) % KG_NEBULA_PALETTE_SIZE
}

function kgNebulaAgentColor(agentId) {
  return kgNebulaPaletteColor(kgNebulaAgentColorIndex(agentId))
}

// Builds the legend entries for every agent that has fired at least one event in the current
// trail buffer, plus (if requested) the full known roster -- callers decide which to show.
function kgNebulaBuildLegend(agentIds) {
  const seen = new Set()
  const out = []
  for (const id of agentIds) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ agentId: id, color: kgNebulaAgentColor(id), paletteIndex: kgNebulaAgentColorIndex(id) % KG_NEBULA_PALETTE_SIZE })
  }
  return out
}

// --- Trail fade math (pure, no Date.now() inside -- callers pass `now` so fake-timer tests can
// drive it exactly) ---------------------------------------------------------------------------

function kgNebulaTrailAlpha(nowMs, startMs, fadeMs) {
  const fade = fadeMs > 0 ? fadeMs : KG_NEBULA_DEFAULT_FADE_MS
  const t = (nowMs - startMs) / fade
  if (t <= 0) return 1
  if (t >= 1) return 0
  return 1 - t
}

function kgNebulaHexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return { r: 255, g: 255, b: 255 }
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
}

// "Hot -> cool" colour: the trail is born white-hot and cools into the agent's own colour over
// the first third of its life, then holds that colour while alpha (computed separately) carries
// the rest of the fade to fully transparent.
function kgNebulaTrailRgba(baseColorCss, nowMs, startMs, fadeMs) {
  const alpha = kgNebulaTrailAlpha(nowMs, startMs, fadeMs)
  const coolT = Math.min(1, ((nowMs - startMs) / (fadeMs > 0 ? fadeMs : KG_NEBULA_DEFAULT_FADE_MS)) * 3)
  const base = baseColorCss.startsWith('#') ? kgNebulaHexToRgb(baseColorCss) : kgNebulaHslToRgb(baseColorCss)
  const r = Math.round(255 * (1 - coolT) + base.r * coolT)
  const g = Math.round(255 * (1 - coolT) + base.g * coolT)
  const b = Math.round(255 * (1 - coolT) + base.b * coolT)
  return { r, g, b, alpha, css: `rgba(${r},${g},${b},${alpha.toFixed(3)})` }
}

function kgNebulaHslToRgb(hslCss) {
  const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/.exec(hslCss)
  if (!m) return { r: 255, g: 255, b: 255 }
  const h = parseFloat(m[1]) / 360, s = parseFloat(m[2]) / 100, l = parseFloat(m[3]) / 100
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v } }
  const hue2rgb = (p, q, tt) => {
    let x = tt
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  }
}

// Drops events whose trail has fully faded; keeps the rest with their current alpha attached.
function kgNebulaActiveTrails(events, nowMs, fadeMs) {
  const out = []
  for (const ev of events) {
    const alpha = kgNebulaTrailAlpha(nowMs, ev.ts, fadeMs)
    if (alpha <= 0) continue
    out.push({ agentId: ev.agent_id, ts: ev.ts, hit: Array.isArray(ev.hit) ? ev.hit : [], alpha })
  }
  return out
}

// --- Deterministic 3D layout --------------------------------------------------------------------
// Everything below is a pure function of (nodes, edges) -- same input, same output, every time,
// hash-seeded (never Math.random), so it is unit-testable without a WebGL context and the "736
// nodes without freezing" requirement needs no per-frame simulation: it settles once on load,
// positions are frozen, and the render loop only moves the camera (OrbitControls) and the trails.

// Bucket key is project+type together, not project alone (kept from round 3, msg 23643): a single
// bucket per project reads as one uniformly-dense field, not distinct topic clouds. type+project
// is real, structural data from the graph contract (never a fabricated "community" label).
function kgNebulaBucketKey(node) {
  return (node.project || '_global') + '::' + (node.type || '_')
}

function kgNebulaProjectBuckets(nodes) {
  const keys = [...new Set(nodes.map(kgNebulaBucketKey))].sort()
  const map = new Map()
  keys.forEach((k, i) => map.set(k, i))
  return map
}

// Even distribution of n points over a sphere of the given radius -- the classic golden-angle
// (Fibonacci sphere) construction, fully deterministic. Used for BOTH the topic-cluster centres
// and the agent ring (now a sphere, not a 2D circle), so "5 agents" and "12 clusters" both spread
// out in true 3D instead of collapsing onto one plane.
function kgNebulaFibonacciSpherePoints(n, radius) {
  const N = Math.max(1, n)
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  const points = []
  for (let i = 0; i < N; i++) {
    const y = N === 1 ? 0 : 1 - (i / (N - 1)) * 2
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = goldenAngle * i
    points.push({
      x: Math.cos(theta) * radiusAtY * radius,
      y: y * radius,
      z: Math.sin(theta) * radiusAtY * radius,
    })
  }
  return points
}

const KG_NEBULA_CLUSTER_ORBIT_R = 150
const KG_NEBULA_BLOB_BASE = 13
const KG_NEBULA_BLOB_MIN = 22
const KG_NEBULA_BLOB_MAX = 68

// Per-node 3D position: a topic-cluster centre (one per project::type bucket, spread on a sphere)
// plus a deterministic jittered offset INSIDE a blob around that centre. The offset radius is
// biased toward the centre (rFrac = w^1.6, not w) -- a dense glowing core fading to a sparse halo
// at the edge, which is what reads as "nebula" in Peti's reference images, instead of a uniform
// ball of dots.
function kgNebulaNode3DPositions(nodes) {
  const buckets = kgNebulaProjectBuckets(nodes)
  const nBuckets = Math.max(1, buckets.size)
  const centers = kgNebulaFibonacciSpherePoints(nBuckets, KG_NEBULA_CLUSTER_ORBIT_R)
  const bucketCounts = new Map()
  for (const node of nodes) {
    const b = buckets.get(kgNebulaBucketKey(node)) || 0
    bucketCounts.set(b, (bucketCounts.get(b) || 0) + 1)
  }
  const positions = new Map()
  for (const node of nodes) {
    const bucket = buckets.get(kgNebulaBucketKey(node)) || 0
    const center = centers[bucket] || { x: 0, y: 0, z: 0 }
    const bucketSize = bucketCounts.get(bucket) || 1
    const blobR = Math.min(KG_NEBULA_BLOB_MAX, Math.max(KG_NEBULA_BLOB_MIN, KG_NEBULA_BLOB_BASE * Math.sqrt(bucketSize)))
    // Three INDEPENDENTLY-SALTED hashes, not one hash sliced into bit ranges. Real and synthetic
    // node ids are often short, near-identical strings (e.g. "n12"/"n24"/"n36") -- this polynomial
    // hash stays in a narrow numeric band for such ids, so `(seed >>> 7) % 10007` and
    // `(seed >>> 14) % 10007` were both near-constant across an entire bucket (measured: 61 of 62
    // nodes in one cluster landed within half a screen pixel of each other, 3D nebula preview,
    // 2026-11-22) -- the shift only divides an already-small number further down, it does not
    // redistribute entropy. Hashing three different strings scatters each of u/v/w independently.
    const u = (kgNebulaHashString(node.id + ':u') % 10007) / 10007
    const v = (kgNebulaHashString(node.id + ':v') % 10007) / 10007
    const w = (kgNebulaHashString(node.id + ':w') % 10007) / 10007
    const theta = u * Math.PI * 2
    const cosPhi = 1 - 2 * v
    const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi))
    const dirX = Math.cos(theta) * sinPhi
    const dirY = cosPhi
    const dirZ = Math.sin(theta) * sinPhi
    const rFrac = Math.pow(w, 1.6)
    const r = blobR * rFrac
    positions.set(node.id, {
      x: center.x + dirX * r, y: center.y + dirY * r, z: center.z + dirZ * r,
      bucket,
    })
  }
  return positions
}

// Per-bucket gas-cloud geometry (centroid + spread of the ACTUAL node positions, not the blobR
// input) -- the volumetric haze sprite sits exactly where its cluster's particles ended up.
function kgNebulaClusterGeometry3D(nodes, positions) {
  const sums = new Map()
  for (const node of nodes) {
    const p = positions.get(node.id)
    if (!p) continue
    const bucket = typeof p.bucket === 'number' ? p.bucket : 0
    if (!sums.has(bucket)) sums.set(bucket, { sx: 0, sy: 0, sz: 0, n: 0 })
    const s = sums.get(bucket)
    s.sx += p.x; s.sy += p.y; s.sz += p.z; s.n += 1
  }
  const out = []
  for (const [bucket, s] of sums) {
    const cx = s.sx / s.n, cy = s.sy / s.n, cz = s.sz / s.n
    let maxR = 0
    for (const node of nodes) {
      const p = positions.get(node.id)
      if (!p || (p.bucket || 0) !== bucket) continue
      maxR = Math.max(maxR, Math.hypot(p.x - cx, p.y - cy, p.z - cz))
    }
    out.push({ bucket, cx, cy, cz, r: Math.max(20, maxR * 1.3), count: s.n })
  }
  return out
}

// Node degree (edge count) per node id -- drives which nodes are promoted to "hub cores" (bigger,
// brighter, linked) vs. plain dust.
function kgNebulaDegreeMap(nodes, edges) {
  const deg = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of edges) {
    if (deg.has(e.source)) deg.set(e.source, deg.get(e.source) + 1)
    if (deg.has(e.target)) deg.set(e.target, deg.get(e.target) + 1)
  }
  return deg
}

// The top `topPerBucket` nodes by degree in EACH topic cluster become hub cores -- "dense,
// colored hubs" per Peti's reference images, spread across every cluster rather than just the
// global top-N (which would starve small clusters of a hub entirely). A degree-0 node is never a
// hub even if a bucket is all leaves.
function kgNebulaHubNodeIds(nodes, edges, topPerBucket) {
  const degree = kgNebulaDegreeMap(nodes, edges)
  const buckets = kgNebulaProjectBuckets(nodes)
  const byBucket = new Map()
  for (const node of nodes) {
    const b = buckets.get(kgNebulaBucketKey(node)) || 0
    if (!byBucket.has(b)) byBucket.set(b, [])
    byBucket.get(b).push({ id: node.id, degree: degree.get(node.id) || 0 })
  }
  const top = typeof topPerBucket === 'number' ? topPerBucket : 2
  const hubs = new Set()
  for (const [, arr] of byBucket) {
    arr.sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1))
    for (let i = 0; i < Math.min(top, arr.length); i++) {
      if (arr[i].degree > 0) hubs.add(arr[i].id)
    }
  }
  return hubs
}

// Agent entities placed on an outer sphere, past every topic cluster -- sorted order keeps it
// stable frame to frame and testable.
function kgNebulaAgentSpherePositions(agentIds, radius) {
  const sorted = [...new Set(agentIds)].sort()
  const points = kgNebulaFibonacciSpherePoints(sorted.length, radius)
  const out = new Map()
  sorted.forEach((id, i) => out.set(id, points[i]))
  return out
}

// Quadratic-curve control point for a 3D search-trail arc, bowed to an arbitrary direction
// perpendicular to the agent->hit line (picked via cross-product with a reference "up" axis,
// falling back to a different reference when the line is nearly parallel to it so the cross
// product never degenerates to zero). Deterministic per (agent, hit) pair via hash, so the curve
// never flickers frame to frame but different trails do not all bow identically.
function kgNebulaCurveControl3D(ax, ay, az, bx, by, bz, seedKey) {
  const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2
  const dx = bx - ax, dy = by - ay, dz = bz - az
  const len = Math.hypot(dx, dy, dz) || 1
  const ndy = dy / len
  let ux = 0, uy = 1, uz = 0
  if (Math.abs(ndy) > 0.98) { ux = 1; uy = 0; uz = 0 }
  let px = dy * uz - dz * uy
  let py = dz * ux - dx * uz
  let pz = dx * uy - dy * ux
  const plen = Math.hypot(px, py, pz) || 1
  px /= plen; py /= plen; pz /= plen
  const sign = kgNebulaHashString(seedKey) % 2 === 0 ? 1 : -1
  const bow = Math.min(len * 0.22, 70) * sign
  return { cx: mx + px * bow, cy: my + py * bow, cz: mz + pz * bow }
}

// --- Page wiring (DOM/three.js/network -- not covered by the pure-function unit tests above,
// same split as every other classic-script module on this page) --------------------------------

const kgNebulaState = {
  open: false,
  nodes: [], edges: [], positions: null, nodeIndex: new Map(),
  events: [], fadeDurationMs: KG_NEBULA_DEFAULT_FADE_MS, sinceMs: 0,
  pollTimer: null, reduced: false,
  lastProject: '',
  degree: new Map(), hubIds: new Set(), clusters: [], outerR: 260,
  // three.js runtime handles -- created in kgNebula3DBuildScene, torn down in kgNebula3DDispose.
  renderer: null, scene: null, camera: null, controls: null, rafId: null,
  pointsByBucket: [], // [{ bucket, points, ids: [nodeId...] }] -- ids[i] matches positions[i*3..]
  trailObjects: new Map(), // eventKey -> { line, headSprite, material, headMaterial }
  dotTexture: null, hazeTexture: null,
  resizeObserver: null,
}

function kgNebulaCanvasSize(canvas) {
  const rect = canvas.parentElement.getBoundingClientRect()
  const w = Math.max(240, rect.width)
  const h = Math.max(240, rect.height > 0 ? rect.height : Math.min(760, w * 0.72))
  return { w, h }
}

function kgNebulaReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch { return false }
}

function kgNebulaEl(id) { return document.getElementById(id) }

async function kgNebulaFetchGraph(project) {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
  params.set('limit', '500')
  return kgFetch('/api/kg/graph?' + params.toString())
}

async function kgNebulaFetchActivity(sinceMs) {
  const params = new URLSearchParams()
  if (sinceMs) params.set('since', String(sinceMs))
  return kgFetch('/api/kg/activity?' + params.toString())
}

function kgNebulaShowMessage(key) {
  kgNebula3DDispose()
  const wrap = kgNebulaEl('kgNebulaCanvasWrap')
  if (!wrap) return
  wrap.innerHTML = `<div class="kg-nebula-msg">${escapeHtml(t(key))}</div>`
}

function kgNebulaShowErrorWithRetry() {
  kgNebula3DDispose()
  const wrap = kgNebulaEl('kgNebulaCanvasWrap')
  if (!wrap) return
  wrap.innerHTML = `<div class="kg-nebula-msg kg-nebula-msg-error">
    <p>${escapeHtml(t('kg.nebula.error'))}</p>
    <button type="button" class="btn-secondary btn-compact" id="kgNebulaRetryBtn">${escapeHtml(t('common.btn.retry'))}</button>
  </div>`
  const btn = kgNebulaEl('kgNebulaRetryBtn')
  if (btn) btn.addEventListener('click', () => { void kgNebulaLoad() })
}

function kgNebulaRestoreCanvas() {
  const wrap = kgNebulaEl('kgNebulaCanvasWrap')
  if (!wrap || kgNebulaEl('kgNebulaCanvas')) return
  wrap.innerHTML = '<canvas id="kgNebulaCanvas" class="kg-nebula-canvas"></canvas>'
}

async function kgNebulaLoad() {
  const project = kgNebulaEl('kgProjectSelect') ? kgNebulaEl('kgProjectSelect').value : ''
  kgNebulaState.lastProject = project && project !== '*' ? project : ''
  kgNebulaShowMessage('common.loading')

  let res
  try {
    res = await kgNebulaFetchGraph(kgNebulaState.lastProject)
  } catch {
    kgNebulaShowErrorWithRetry()
    return
  }
  if (res.status === 404) { kgNebulaShowMessage('kg.disabled'); return }
  if (!res.ok) { kgNebulaShowErrorWithRetry(); return }

  let data
  try { data = await res.json() } catch { kgNebulaShowErrorWithRetry(); return }
  const nodes = Array.isArray(data.nodes) ? data.nodes : []
  const edges = Array.isArray(data.edges) ? data.edges : []
  if (!nodes.length) { kgNebulaShowMessage('kg.nebula.empty'); return }

  kgNebula3DDispose()
  kgNebulaRestoreCanvas()
  kgNebulaState.nodes = nodes
  kgNebulaState.edges = edges
  kgNebulaState.nodeIndex = new Map(nodes.map((n) => [n.id, n]))
  kgNebulaState.positions = kgNebulaNode3DPositions(nodes)
  kgNebulaState.degree = kgNebulaDegreeMap(nodes, edges)
  kgNebulaState.hubIds = kgNebulaHubNodeIds(nodes, edges, 2)
  kgNebulaState.clusters = kgNebulaClusterGeometry3D(nodes, kgNebulaState.positions)
  const maxClusterR = kgNebulaState.clusters.reduce((m, c) => Math.max(m, c.r), 0)
  kgNebulaState.outerR = KG_NEBULA_CLUSTER_ORBIT_R + maxClusterR + 90

  const canvas = kgNebulaEl('kgNebulaCanvas')
  kgNebula3DBuildScene(canvas)
  kgNebulaRenderLegend()
  kgNebulaStartPolling()
  kgNebula3DStart()
}

function kgNebulaRenderLegend() {
  const legend = kgNebulaEl('kgNebulaLegend')
  if (!legend) return
  const activeAgents = [...new Set(kgNebulaState.events.map((e) => e.agent_id))]
  const entries = kgNebulaBuildLegend(activeAgents)
  legend.innerHTML = entries.map((e) => `
    <span class="kg-legend-item">
      <span class="kg-legend-dot kg-neb-c${e.paletteIndex}"></span>${escapeHtml(e.agentId)}
    </span>`).join('') || `<span class="kg-nebula-legend-empty">${escapeHtml(t('kg.nebula.legend_empty'))}</span>`
}

async function kgNebulaPollOnce() {
  let res
  try { res = await kgNebulaFetchActivity(kgNebulaState.sinceMs) } catch { return }
  if (!res.ok) return
  let data
  try { data = await res.json() } catch { return }
  const events = Array.isArray(data.events) ? data.events : []
  if (data.config && typeof data.config.fadeDurationMs === 'number' && data.config.fadeDurationMs > 0) {
    kgNebulaState.fadeDurationMs = data.config.fadeDurationMs
  }
  if (events.length) {
    kgNebulaState.events.push(...events)
    kgNebulaState.sinceMs = events.reduce((max, e) => Math.max(max, e.ts || 0), kgNebulaState.sinceMs)
    kgNebulaRenderLegend()
  }
  const cutoff = Date.now() - kgNebulaState.fadeDurationMs * 2
  kgNebulaState.events = kgNebulaState.events.filter((e) => e.ts >= cutoff)
}

function kgNebulaStartPolling() {
  if (kgNebulaState.pollTimer) return
  void kgNebulaPollOnce()
  kgNebulaState.pollTimer = setInterval(() => { void kgNebulaPollOnce() }, KG_NEBULA_POLL_MS)
}

function kgNebulaStopPolling() {
  if (kgNebulaState.pollTimer) { clearInterval(kgNebulaState.pollTimer); kgNebulaState.pollTimer = null }
}

// --- three.js scene ------------------------------------------------------------------------------

// A soft circular glow, drawn once into an offscreen canvas and reused as a texture for every
// particle/haze sprite -- avoids per-node/per-frame gradient allocation (the round-3 2D canvas
// version paid a createRadialGradient+fill cost per node per frame; a texture is built ONCE here).
function kgNebulaMakeGlowTexture(sizePx, coreAlpha) {
  const c = document.createElement('canvas')
  c.width = sizePx; c.height = sizePx
  const ctx = c.getContext('2d')
  const r = sizePx / 2
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r)
  grad.addColorStop(0, `rgba(255,255,255,${coreAlpha})`)
  grad.addColorStop(0.4, `rgba(255,255,255,${coreAlpha * 0.55})`)
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, sizePx, sizePx)
  const tex = new THREE.CanvasTexture(c)
  tex.needsUpdate = true
  return tex
}

function kgNebulaMakeLabelSprite(text, colorCss) {
  const c = document.createElement('canvas')
  const scale = 4
  c.width = 160 * scale; c.height = 40 * scale
  const ctx = c.getContext('2d')
  ctx.scale(scale, scale)
  ctx.font = '600 16px sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = colorCss
  ctx.fillText(text, 2, 20)
  const tex = new THREE.CanvasTexture(c)
  tex.needsUpdate = true
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(28, 7, 1)
  return sprite
}

function kgNebula3DDispose() {
  if (kgNebulaState.resizeObserver) { kgNebulaState.resizeObserver.disconnect(); kgNebulaState.resizeObserver = null }
  if (kgNebulaState.rafId) { cancelAnimationFrame(kgNebulaState.rafId); kgNebulaState.rafId = null }
  if (kgNebulaState.controls) { kgNebulaState.controls.dispose(); kgNebulaState.controls = null }
  if (kgNebulaState.scene) {
    kgNebulaState.scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose()
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
        for (const m of mats) { if (m.map) m.map.dispose(); m.dispose() }
      }
    })
  }
  if (kgNebulaState.renderer) { kgNebulaState.renderer.dispose(); kgNebulaState.renderer = null }
  kgNebulaState.scene = null
  kgNebulaState.camera = null
  kgNebulaState.pointsByBucket = []
  kgNebulaState.trailObjects = new Map()
  kgNebulaState.dotTexture = null
  kgNebulaState.hazeTexture = null
}

function kgNebula3DBuildScene(canvas) {
  if (!canvas || typeof THREE === 'undefined') { kgNebulaShowErrorWithRetry(); return }
  const { w, h } = kgNebulaCanvasSize(canvas)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(w, h, false)
  renderer.setClearColor(0x05060a, 1)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, w / h, 1, 5000)
  const camDist = kgNebulaState.outerR * 2.3
  camera.position.set(camDist * 0.6, camDist * 0.35, camDist * 0.7)
  camera.lookAt(0, 0, 0)

  kgNebulaState.reduced = kgNebulaReducedMotion()
  const note = kgNebulaEl('kgNebulaReducedNote')
  if (note) note.hidden = !kgNebulaState.reduced

  const controls = new THREE.OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minDistance = kgNebulaState.outerR * 0.6
  controls.maxDistance = kgNebulaState.outerR * 5
  controls.autoRotate = !kgNebulaState.reduced
  controls.autoRotateSpeed = 0.6
  controls.addEventListener('start', () => { controls.autoRotate = false })

  kgNebulaState.dotTexture = kgNebulaMakeGlowTexture(64, 1)
  kgNebulaState.hazeTexture = kgNebulaMakeGlowTexture(256, 0.5)

  // 1. Per-cluster particle dust + volumetric gas haze.
  kgNebulaState.pointsByBucket = []
  const byBucket = new Map()
  for (const node of kgNebulaState.nodes) {
    const p = kgNebulaState.positions.get(node.id)
    if (!p) continue
    if (!byBucket.has(p.bucket)) byBucket.set(p.bucket, [])
    byBucket.get(p.bucket).push({ node, p })
  }
  for (const [bucket, entries] of byBucket) {
    const color = new THREE.Color(kgNebulaPaletteColor(bucket))
    const positions = new Float32Array(entries.length * 3)
    const ids = new Array(entries.length)
    entries.forEach((e, i) => {
      positions[i * 3] = e.p.x; positions[i * 3 + 1] = e.p.y; positions[i * 3 + 2] = e.p.z
      ids[i] = e.node.id
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      color, map: kgNebulaState.dotTexture, size: 3.4, sizeAttenuation: true,
      transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false,
    })
    const points = new THREE.Points(geo, mat)
    scene.add(points)
    kgNebulaState.pointsByBucket.push({ bucket, points, ids })
  }
  for (const c of kgNebulaState.clusters) {
    const color = kgNebulaPaletteColor(c.bucket)
    const hazeMat = new THREE.SpriteMaterial({
      map: kgNebulaState.hazeTexture, color: new THREE.Color(color),
      transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false,
    })
    const haze = new THREE.Sprite(hazeMat)
    haze.position.set(c.cx, c.cy, c.cz)
    haze.scale.setScalar(c.r * 2.6)
    scene.add(haze)
  }

  // 2. Hub cores -- bigger, brighter, cyan-white (matches Peti's reference), plus thin links
  // between any two hubs that actually share a graph edge.
  const hubPositions = []
  const hubIndexById = new Map()
  for (const node of kgNebulaState.nodes) {
    if (!kgNebulaState.hubIds.has(node.id)) continue
    const p = kgNebulaState.positions.get(node.id)
    if (!p) continue
    hubIndexById.set(node.id, hubPositions.length)
    hubPositions.push(p)
  }
  if (hubPositions.length) {
    const positions = new Float32Array(hubPositions.length * 3)
    hubPositions.forEach((p, i) => { positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      color: new THREE.Color(0xbfe8ff), map: kgNebulaState.dotTexture, size: 7.5, sizeAttenuation: true,
      transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    })
    scene.add(new THREE.Points(geo, mat))

    const linkPositions = []
    for (const e of kgNebulaState.edges) {
      const ai = hubIndexById.get(e.source), bi = hubIndexById.get(e.target)
      if (ai === undefined || bi === undefined) continue
      const a = hubPositions[ai], b = hubPositions[bi]
      linkPositions.push(a.x, a.y, a.z, b.x, b.y, b.z)
    }
    if (linkPositions.length) {
      const lgeo = new THREE.BufferGeometry()
      lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linkPositions), 3))
      const lmat = new THREE.LineBasicMaterial({ color: 0x8fa0c8, transparent: true, opacity: 0.35 })
      scene.add(new THREE.LineSegments(lgeo, lmat))
    }
  }

  // 3. Agent entities on an outer sphere -- own colour sphere + glow + label sprite.
  const activeAgentIds = [...new Set(kgNebulaState.events.map((e) => e.agent_id))]
  const agentIds = activeAgentIds.length ? activeAgentIds : KG_NEBULA_KNOWN_AGENTS
  const agentPositions = kgNebulaAgentSpherePositions(agentIds, kgNebulaState.outerR)
  const agentMeshes = new Map()
  const sphereGeo = new THREE.SphereGeometry(4, 12, 10)
  for (const [agentId, pos] of agentPositions) {
    const color = new THREE.Color(kgNebulaAgentColor(agentId))
    const sphere = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color }))
    sphere.position.set(pos.x, pos.y, pos.z)
    scene.add(sphere)
    const glowMat = new THREE.SpriteMaterial({
      map: kgNebulaState.dotTexture, color, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
    const glow = new THREE.Sprite(glowMat)
    glow.position.copy(sphere.position)
    glow.scale.setScalar(22)
    scene.add(glow)
    const label = kgNebulaMakeLabelSprite(agentId, kgNebulaAgentColor(agentId))
    const outward = new THREE.Vector3(pos.x, pos.y, pos.z).normalize()
    label.position.set(pos.x + outward.x * 14, pos.y + outward.y * 14 + 6, pos.z + outward.z * 14)
    scene.add(label)
    agentMeshes.set(agentId, { sphere, glow, label, pos })
  }
  kgNebulaState.agentMeshes = agentMeshes

  kgNebulaState.renderer = renderer
  kgNebulaState.scene = scene
  kgNebulaState.camera = camera
  kgNebulaState.controls = controls

  const ro = new ResizeObserver(() => kgNebula3DResize())
  ro.observe(canvas.parentElement)
  kgNebulaState.resizeObserver = ro

  if (!canvas.dataset.kgNebulaClickWired) {
    canvas.dataset.kgNebulaClickWired = '1'
    canvas.addEventListener('click', kgNebulaHandleClick)
  }
}

function kgNebula3DResize() {
  const canvas = kgNebulaEl('kgNebulaCanvas')
  if (!canvas || !kgNebulaState.renderer || !kgNebulaState.camera) return
  const { w, h } = kgNebulaCanvasSize(canvas)
  kgNebulaState.camera.aspect = w / h
  kgNebulaState.camera.updateProjectionMatrix()
  kgNebulaState.renderer.setSize(w, h, false)
}

function kgNebulaDisposeTrailObject(obj) {
  kgNebulaState.scene.remove(obj.line)
  kgNebulaState.scene.remove(obj.headSprite)
  obj.line.geometry.dispose()
  obj.material.dispose()
  obj.headMaterial.dispose()
}

// Updates the live search-trail arcs each frame: one quadratic-bezier 3D curve per (agent, hit)
// pair, hot-white cooling into the agent's colour, alpha fading over fadeDurationMs. Objects are
// created lazily and reused across frames (keyed by agent+hit+ts, unique per search even if the
// same pair is hit twice) and disposed once their trail fully fades -- no per-frame allocation of
// geometry for a trail that is still alive, only a position/attribute update.
function kgNebula3DUpdateTrails(now) {
  const scene = kgNebulaState.scene
  if (!scene) return
  const seenKeys = new Set()
  if (!kgNebulaState.reduced) {
    for (const ev of kgNebulaState.events) {
      const alpha = kgNebulaTrailAlpha(now, ev.ts, kgNebulaState.fadeDurationMs)
      if (alpha <= 0) continue
      const origin = kgNebulaState.agentMeshes && kgNebulaState.agentMeshes.get(ev.agent_id)
      if (!origin) continue
      const color = kgNebulaAgentColor(ev.agent_id)
      for (const hitId of (ev.hit || [])) {
        const b = kgNebulaState.positions.get(hitId)
        if (!b) continue
        const key = ev.agent_id + ':' + hitId + ':' + ev.ts
        seenKeys.add(key)
        const rgb = kgNebulaTrailRgba(color, now, ev.ts, kgNebulaState.fadeDurationMs)
        let obj = kgNebulaState.trailObjects.get(key)
        if (!obj) {
          const { cx, cy, cz } = kgNebulaCurveControl3D(origin.pos.x, origin.pos.y, origin.pos.z, b.x, b.y, b.z, key)
          const curve = new THREE.QuadraticBezierCurve3(
            new THREE.Vector3(origin.pos.x, origin.pos.y, origin.pos.z),
            new THREE.Vector3(cx, cy, cz),
            new THREE.Vector3(b.x, b.y, b.z),
          )
          const pts = curve.getPoints(24)
          const geo = new THREE.BufferGeometry().setFromPoints(pts)
          const material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 })
          const line = new THREE.Line(geo, material)
          const headMaterial = new THREE.SpriteMaterial({
            map: kgNebulaState.dotTexture, color: 0xffffff, transparent: true,
            blending: THREE.AdditiveBlending, depthWrite: false,
          })
          const headSprite = new THREE.Sprite(headMaterial)
          headSprite.position.set(b.x, b.y, b.z)
          headSprite.scale.setScalar(10)
          scene.add(line)
          scene.add(headSprite)
          obj = { line, headSprite, material, headMaterial }
          kgNebulaState.trailObjects.set(key, obj)
        }
        obj.material.color.setRGB(rgb.r / 255, rgb.g / 255, rgb.b / 255)
        obj.material.opacity = rgb.alpha
        obj.headMaterial.color.setRGB(rgb.r / 255, rgb.g / 255, rgb.b / 255)
        obj.headMaterial.opacity = rgb.alpha
      }
    }
  }
  for (const [key, obj] of kgNebulaState.trailObjects) {
    if (!seenKeys.has(key)) { kgNebulaDisposeTrailObject(obj); kgNebulaState.trailObjects.delete(key) }
  }
}

function kgNebula3DRenderOnce() {
  if (!kgNebulaState.renderer) return
  kgNebula3DUpdateTrails(Date.now())
  kgNebulaState.controls.update()
  kgNebulaState.renderer.render(kgNebulaState.scene, kgNebulaState.camera)
}

function kgNebula3DStart() {
  if (!kgNebulaState.renderer) return
  if (kgNebulaState.reduced) { kgNebula3DRenderOnce(); return } // static frame, no rAF loop
  const tick = () => {
    kgNebula3DRenderOnce()
    kgNebulaState.rafId = requestAnimationFrame(tick)
  }
  kgNebulaState.rafId = requestAnimationFrame(tick)
}

function kgNebulaHandleClick(ev) {
  if (!kgNebulaState.renderer || !kgNebulaState.camera) return
  const canvas = kgNebulaEl('kgNebulaCanvas')
  const rect = canvas.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1,
  )
  const raycaster = new THREE.Raycaster()
  raycaster.params.Points.threshold = 5
  raycaster.setFromCamera(ndc, kgNebulaState.camera)
  let best = null
  for (const group of kgNebulaState.pointsByBucket) {
    const hits = raycaster.intersectObject(group.points)
    if (hits.length && (!best || hits[0].distance < best.distance)) {
      best = { distance: hits[0].distance, nodeId: group.ids[hits[0].index] }
    }
  }
  if (best) void kgSelectNode(best.nodeId)
}

function kgNebulaToggle() {
  const section = kgNebulaEl('kgNebulaSection')
  const btn = kgNebulaEl('kgNebulaToggleBtn')
  if (!section) return
  kgNebulaState.open = !kgNebulaState.open
  section.hidden = !kgNebulaState.open
  if (btn) btn.setAttribute('aria-expanded', String(kgNebulaState.open))
  if (kgNebulaState.open) {
    void kgNebulaLoad()
  } else {
    kgNebulaStopPolling()
    kgNebula3DDispose()
  }
}

function kgNebulaWireToolbar() {
  const btn = kgNebulaEl('kgNebulaToggleBtn')
  if (btn && !btn.dataset.kgWired) {
    btn.dataset.kgWired = '1'
    btn.addEventListener('click', kgNebulaToggle)
  }
  const projectSelect = kgNebulaEl('kgProjectSelect')
  if (projectSelect && !projectSelect.dataset.kgNebulaWired) {
    projectSelect.dataset.kgNebulaWired = '1'
    projectSelect.addEventListener('change', () => { if (kgNebulaState.open) void kgNebulaLoad() })
  }
}

// Classic <script> top-level `function` decls attach to `window` for free in the real page; a
// dynamic import() in the test harness runs this as an ES module instead, where they stay
// module-scoped (same seam already documented/handled in app-llm-monitor.js) -- export the
// pure-function surface explicitly so src/__tests__/kg-nebula-module.test.ts can reach it.
window.kgNebulaTrailAlpha = kgNebulaTrailAlpha
window.kgNebulaTrailRgba = kgNebulaTrailRgba
window.kgNebulaAgentColor = kgNebulaAgentColor
window.kgNebulaAgentColorIndex = kgNebulaAgentColorIndex
window.kgNebulaBuildLegend = kgNebulaBuildLegend
window.kgNebulaActiveTrails = kgNebulaActiveTrails
window.kgNebulaWireToolbar = kgNebulaWireToolbar
window.kgNebulaToggle = kgNebulaToggle
window.kgNebulaDegreeMap = kgNebulaDegreeMap
window.kgNebulaBucketKey = kgNebulaBucketKey
window.kgNebulaProjectBuckets = kgNebulaProjectBuckets
window.kgNebulaFibonacciSpherePoints = kgNebulaFibonacciSpherePoints
window.kgNebulaNode3DPositions = kgNebulaNode3DPositions
window.kgNebulaClusterGeometry3D = kgNebulaClusterGeometry3D
window.kgNebulaHubNodeIds = kgNebulaHubNodeIds
window.kgNebulaAgentSpherePositions = kgNebulaAgentSpherePositions
window.kgNebulaCurveControl3D = kgNebulaCurveControl3D
