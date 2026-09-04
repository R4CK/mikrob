import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Card 4c5c540c, follow-up: Peti photographed overlapping blocks on the swimlane (~12:01) and
// asked for interval packing -- an overlapping block goes to the first free sub-row inside the
// same model lane, or opens a new one.
//
// These tests EXECUTE the real packer rather than grepping for it, because "does not overlap"
// is a property of the output, not of the source text.
//
// The thing worth stating: packing raw start/end times would NOT have fixed what he saw. The
// renderer clamps every block to a minimum width, and measured on live data in a 4h window,
// 89% of blocks (66 of 74) are SHORTER than that floor -- they are drawn wider than they lasted
// and collide even when their intervals do not touch. So the packer works on the drawn boxes.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'app-overview.js'), 'utf8')
const CSS = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8')


/** Body of the rule whose selector is EXACTLY `sel` at the start of a line.
 *  Ad-hoc indexOf slicing mis-fired three times writing this file: `.ovw-llmdist-block {` also
 *  matches inside `.ovw-llmdist-lane-rows--compact .ovw-llmdist-block {`, and a slice that
 *  overshoots swallows unrelated declarations (`min-width: 0` on the rows container) and asserts
 *  about the wrong thing. Anchor on the selector, stop at the closing brace. */
function ruleBody(sel: string): string {
  const re = new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
  const m = CSS.match(re)
  if (!m) throw new Error(`rule not found: ${sel}`)
  // Comments STRIPPED. These rules are commented heavily and the comments quote the very
  // properties the assertions forbid ("the `min-width: 10px` removed earlier"), so an assertion
  // over the raw body fails on its own rationale. Caught exactly that way.
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '')
}

interface Block { leftPct: number; widthPct: number; row: number }
type Packer = (blocks: Block[], gapPct?: number) => number

function extract(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`missing function ${name}`)
  let depth = 0
  let i = SRC.indexOf('{', start)
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') { depth--; if (depth === 0) break }
  }
  return SRC.slice(start, i + 1)
}

let pack: Packer
let MIN_W: number
let GAP: number

beforeAll(() => {
  const consts = (SRC.match(/^const OVW_LLMDIST_(MIN_W_PCT|GAP_PCT) = [\d.]+$/gm) ?? []).join('\n')
  expect(consts, 'geometry constants not found').toContain('OVW_LLMDIST_MIN_W_PCT')
  const body = `${consts}\n${extract('ovwLlmDistPackRows')}\n` +
    'return { pack: ovwLlmDistPackRows, MIN_W: OVW_LLMDIST_MIN_W_PCT, GAP: OVW_LLMDIST_GAP_PCT }'
  const out = new Function(body)() as { pack: Packer; MIN_W: number; GAP: number }
  pack = out.pack; MIN_W = out.MIN_W; GAP = out.GAP
})

/** Every pair on the same row must be clear of each other. This is the whole requirement. */
function assertNoOverlap(blocks: Block[]) {
  const byRow = new Map<number, Block[]>()
  for (const b of blocks) {
    if (!byRow.has(b.row)) byRow.set(b.row, [])
    byRow.get(b.row)!.push(b)
  }
  for (const [row, list] of byRow) {
    const sorted = [...list].sort((a, b) => a.leftPct - b.leftPct)
    for (let i = 1; i < sorted.length; i++) {
      const prevRight = sorted[i - 1].leftPct + sorted[i - 1].widthPct
      expect(
        sorted[i].leftPct,
        `row ${row}: block at ${sorted[i].leftPct} overlaps one ending at ${prevRight}`,
      ).toBeGreaterThanOrEqual(prevRight)
    }
  }
}

const mk = (pairs: Array<[number, number]>): Block[] =>
  pairs.map(([leftPct, widthPct]) => ({ leftPct, widthPct, row: 0 }))

describe('ruleBody helper', () => {
  it('strips comments, so an assertion cannot fail (or pass) on the rationale text', () => {
    const raw = CSS.match(/(?:^|\n)\.ovw-llmdist-block\s*\{([^}]*)\}/)![1]
    expect(raw, 'fixture assumption: this rule quotes min-width in a comment').toContain('min-width')
    expect(ruleBody('.ovw-llmdist-block')).not.toContain('min-width')
    expect(ruleBody('.ovw-llmdist-block')).toContain('position: absolute')
  })
})

describe('ovwLlmDistPackRows', () => {
  it('leaves non-overlapping blocks on a single row', () => {
    const b = mk([[0, 5], [10, 5], [20, 5]])
    expect(pack(b)).toBe(1)
    expect(b.every((x) => x.row === 0)).toBe(true)
  })

  it('pushes an overlapping block to a second row', () => {
    const b = mk([[0, 10], [5, 10]])
    expect(pack(b)).toBe(2)
    expect(b[0].row).toBe(0)
    expect(b[1].row).toBe(1)
    assertNoOverlap(b)
  })

  it('reuses the FIRST free row rather than always opening a new one', () => {
    // Three mutually overlapping, then one far to the right: it must land back on row 0.
    const b = mk([[0, 10], [1, 10], [2, 10], [50, 5]])
    expect(pack(b)).toBe(3)
    expect(b[3].row).toBe(0)
    assertNoOverlap(b)
  })

  it('opens exactly as many rows as the peak concurrency, not one per block', () => {
    const b = mk([[0, 10], [1, 10], [2, 10], [3, 10]])
    expect(pack(b)).toBe(4)
    const b2 = mk([[0, 5], [6, 5], [12, 5], [18, 5]])
    expect(pack(b2)).toBe(1)
  })

  it('handles identical start times deterministically and without overlap', () => {
    const b = mk([[10, 5], [10, 5], [10, 5]])
    expect(pack(b)).toBe(3)
    expect(b.map((x) => x.row)).toEqual([0, 1, 2])
    assertNoOverlap(b)
  })

  it('keeps a gap, so two blocks that merely touch do not render flush', () => {
    // Touching exactly (0..10 and 10..20) reads as one wide block; the gap separates them.
    const b = mk([[0, 10], [10, 10]])
    expect(pack(b)).toBe(2)
    expect(GAP).toBeGreaterThan(0)
  })

  it('is order-independent: shuffled input yields the same row COUNT', () => {
    const pairs: Array<[number, number]> = [[0, 10], [5, 10], [50, 5], [52, 5], [80, 1]]
    const a = mk(pairs)
    const shuffled = mk([...pairs].reverse())
    expect(pack(a)).toBe(pack(shuffled))
  })

  it('the real-data shape packs cleanly: many min-width blocks in a burst', () => {
    // The measured live case: dozens of sub-floor-duration calls seconds apart, all clamped to
    // the minimum width, in a 4h window. Before packing these drew on top of each other.
    const burst: Array<[number, number]> = []
    for (let i = 0; i < 40; i++) burst.push([50 + i * 0.05, MIN_W])
    const b = mk(burst)
    const rows = pack(b)
    expect(rows).toBeGreaterThan(1)
    assertNoOverlap(b)
  })

  it('never leaves a block unassigned', () => {
    const b = mk([[0, 10], [1, 10], [2, 10], [3, 10], [4, 10]])
    pack(b)
    expect(b.every((x) => Number.isInteger(x.row) && x.row >= 0)).toBe(true)
  })
})

describe('rendered geometry is decided by ONE number', () => {
  it('the CSS pixel floor is gone, so percent is authoritative', () => {
    // With both `min-width: 10px` and a percent floor, "no overlap" could be true in percent and
    // false on screen: 0.6% of a ~700px track is ~4px, so the pixel floor silently won.
    expect(ruleBody('.ovw-llmdist-block')).not.toContain('min-width')
  })

  it('the lane stacks its sub-rows', () => {
    expect(CSS).toContain('.ovw-llmdist-lane-rows')
    expect(SRC).toContain('ovw-llmdist-lane-rows')
    expect(CSS).toMatch(/\.ovw-llmdist-lane \{[^}]*align-items: flex-start/)
  })

  it('switches to compact rows past a few sub-rows, instead of a 1200px lane', () => {
    // Measured live: 23 sub-rows over 30 minutes, 36 over 4 hours, because a call's logged
    // duration includes its GPU-lock wait. Strict packing alone would be honest and unusable.
    expect(SRC).toContain('OVW_LLMDIST_COMPACT_FROM_ROWS')
    expect(SRC).toMatch(/const compact = rowCount > OVW_LLMDIST_COMPACT_FROM_ROWS/)
    expect(SRC).toContain("ovw-llmdist-lane-rows--compact")
    expect(CSS).toContain('.ovw-llmdist-lane-rows--compact')
    // The backstop: even compact rows must not be allowed to run away vertically.
    expect(CSS).toMatch(/\.ovw-llmdist-lane-rows--compact \{[^}]*max-height/)
    expect(CSS).toMatch(/\.ovw-llmdist-lane-rows--compact \{[^}]*overflow-y: auto/)
  })

  it('REGRESSION: the track does not flex along the COLUMN axis', () => {
    // Shipped and broke the live dashboard (448008be): the track kept `flex: 1` from when it was
    // a child of .ovw-llmdist-lane, a ROW container, where that sized its WIDTH. Moving it into
    // the column .ovw-llmdist-lane-rows made the main axis HEIGHT, so flex:1's implied
    // `flex-basis: 0%` overrode `height: 30px`, every track collapsed to zero height, and the
    // absolutely-positioned blocks vanished. Verified in a real browser: 9 of 9 blocks measured
    // height 0 with the old rule, 24px with this one.
    //
    // vitest has no layout engine, so this pins the CSS declaration rather than the geometry.
    // Anchored to the START OF A LINE: the compact override's selector also ENDS with
    // `.ovw-llmdist-lane-track {` and sits earlier in the file, so a plain indexOf sliced the
    // wrong rule and this assertion failed against correct CSS on its first run.
    const rule = ruleBody('.ovw-llmdist-lane-track')
    expect(rule).toContain('height: 38px')
    expect(rule).not.toMatch(/flex:\s*1\s*;/)
    expect(rule).toMatch(/flex:\s*0 0 auto/)
  })

  it('the renderer packs before emitting markup', () => {
    const fn = SRC.slice(SRC.indexOf('function ovwLlmDistLanesHtml('), SRC.indexOf('function ovwLlmDistLegendHtml('))
    expect(fn).toContain('ovwLlmDistPackRows(blocks, gap)')
    expect(fn).toContain('OVW_LLMDIST_MIN_W_PCT')
    expect(fn).not.toMatch(/Math\.max\(0\.6,/) // the literal floor moved into the shared const
    expect(fn).toContain('OVW_LLMDIST_MIN_W_PCT / z')
  })
})

describe('ten-minute scrollable viewport (card b52c3c42)', () => {
  it('zoom is the loaded range divided by the ten-minute viewport', () => {
    const zoom = new Function(
      SRC.slice(SRC.indexOf('const OVW_LLMDIST_VIEWPORT_MIN'), SRC.indexOf('const OVW_LLMDIST_LABEL_GUTTER_PX')) +
      extract('ovwLlmDistZoom') + '\nreturn ovwLlmDistZoom',
    )() as (h: number) => number
    expect(zoom(0.5)).toBe(3)
    expect(zoom(1)).toBe(6)
    expect(zoom(4)).toBe(24)
    // Never below 1: a canvas narrower than its own viewport would scroll backwards into nothing.
    expect(zoom(0.1)).toBe(1)
    expect(zoom(NaN)).toBe(1)
    expect(zoom(-3)).toBe(1)
  })

  it('the canvas multiplies ONLY the track area, not the label gutter', () => {
    // `106px + (100% - 106px) * zoom`. Multiplying the whole width instead would make the visible
    // slice short by the label width -- about 13% off at a typical card width, so the "ten
    // minutes" claim would simply be wrong. Verified in a browser: 10.00 minutes visible.
    expect(CSS).toMatch(/\.ovw-llmdist-canvas \{[^}]*calc\(106px \+ \(100% - 106px\) \* var\(--llmdist-zoom/)
  })

  it('geometry scales with zoom so the floor and gap keep their PIXEL size', () => {
    const fn = SRC.slice(SRC.indexOf('function ovwLlmDistLanesHtml('), SRC.indexOf('function ovwLlmDistLegendHtml('))
    expect(fn).toContain('OVW_LLMDIST_MIN_W_PCT / z')
    expect(fn).toContain('OVW_LLMDIST_GAP_PCT / z')
    expect(fn).toContain('ovwLlmDistPackRows(blocks, gap)')
  })

  it('no CSS property silently re-imposes a minimum block width', () => {
    // Twice now a pixel-sized property has overridden the percentage the packer reasons about:
    // first `min-width: 10px`, then `padding: 0 8px` (which floors a block at 16px and put 21
    // on-screen overlaps back into a layout the packer believed was clean). The label is inset
    // with text-indent, which does not contribute to the box width.
    const rule = ruleBody('.ovw-llmdist-block')
    expect(rule).not.toMatch(/min-width/)
    expect(rule).not.toMatch(/padding:\s*0\s+[1-9]/)
    expect(rule).toMatch(/text-indent/)
  })

  it('the label stays put while the canvas scrolls under it', () => {
    expect(CSS).toMatch(/\.ovw-llmdist-lane-label \{[^}]*position: sticky/)
  })

  it('opens on NOW, after the card is un-hidden', () => {
    // A hidden element has no layout, so reading scrollWidth before un-hiding yields 0 and the
    // view opens at the OLDEST end -- the opposite of "drag back from the present".
    // Anchored on the scroller lookup, not on `card.hidden = false`: that line appears in the
    // empty-models and error branches too, so both indexOf and lastIndexOf land in a branch
    // where no scroller exists.
    const at = SRC.indexOf("const scroller = document.getElementById('ovwLlmDistScroll')")
    expect(at, 'scroller lookup not found').toBeGreaterThan(-1)
    expect(SRC.slice(at, at + 200)).toContain('scrollLeft = scroller.scrollWidth')
    // ...and it must come AFTER the card is un-hidden, or scrollWidth reads 0.
    expect(SRC.lastIndexOf('card.hidden = false', at)).toBeGreaterThan(-1)
  })
})

// ---------------------------------------------------------------------------------------
// Card 21950f77: an installed-but-idle model gets a lane too, and a lane whose model is no
// longer installed says so -- but ONLY when the roster lookup actually succeeded.
//
// The renderer is EXECUTED here, for the same reason the packer is: "does not claim a model
// was removed" is a property of the produced HTML, not of the source text.
// ---------------------------------------------------------------------------------------
type Lane = { model: string; tasks: unknown[]; installed?: boolean }
type Renderer = (
  models: Lane[], startMs: number, endMs: number, zoom: number, rosterAvailable?: boolean,
) => string

let renderLanes: Renderer

beforeAll(() => {
  const consts = (SRC.match(/^const OVW_LLMDIST_[A-Z_]+ = [\d.]+$/gm) ?? []).join('\n')
  const stubs = `
    const escapeHtml = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const t = (key) => 'i18n:' + key
    const ovwLlmDistColorFor = () => '#000'
    const ovwLlmDistFormatTpsOrNa = () => 'tps'
    const ovwLlmDistStatusLabel = () => 'ok'
  `
  const body = `${consts}\n${stubs}\n${extract('ovwLlmDistPackRows')}\n${extract('ovwLlmDistLanesHtml')}\n` +
    'return ovwLlmDistLanesHtml'
  renderLanes = new Function(body)() as Renderer
})

const NOW = 1_788_000_000_000
const HOUR_AGO = NOW - 3600_000
const task = () => ({ startMs: NOW - 60_000, durationMs: 5_000, task: 'code', agent: 'backend', status: 'ok', tokensIn: 1, tokensOut: 1, tokensPerSec: 1 })

describe('ovwLlmDistLanesHtml -- idle roster lanes (card 21950f77)', () => {
  it('draws an idle lane with a note and NO blocks', () => {
    const html = renderLanes([{ model: 'mistral', tasks: [], installed: true }], HOUR_AGO, NOW, 6, true)
    expect(html).toContain('ovw-llmdist-lane--idle')
    expect(html).toContain('i18n:overview.llmDist.lane_idle')
    // An empty lane must not emit a block button; before the split it rendered one empty
    // full-height track and nothing said why it was blank.
    expect(html).not.toContain('ovw-llmdist-block')
  })

  it('does NOT draw the idle chrome on a lane that has traffic', () => {
    const html = renderLanes([{ model: 'mistral', tasks: [task()], installed: true }], HOUR_AGO, NOW, 6, true)
    expect(html).not.toContain('ovw-llmdist-lane--idle')
    expect(html).toContain('ovw-llmdist-block')
  })

  it('marks a lane whose model is no longer installed', () => {
    const html = renderLanes([{ model: 'gone', tasks: [task()], installed: false }], HOUR_AGO, NOW, 6, true)
    expect(html).toContain('ovw-llmdist-lane-label--removed')
    expect(html).toContain('i18n:overview.llmDist.lane_uninstalled')
  })

  it('does NOT claim a model was removed when the roster could not be read', () => {
    // THE guard. With ollama down every lane arrives installed:false; badging them all
    // "no longer installed" would state what the lookup never returned.
    const html = renderLanes([{ model: 'gone', tasks: [task()], installed: false }], HOUR_AGO, NOW, 6, false)
    expect(html).not.toContain('ovw-llmdist-lane-label--removed')
    expect(html).not.toContain('i18n:overview.llmDist.lane_uninstalled')
  })

  it('keeps the idle note sticky at the label offset, so it survives a scroll to NOW', () => {
    // The canvas is up to 24 viewports wide and opens scrolled to the right edge. A note
    // pinned to the canvas origin is simply off-screen, and the lane reads as an empty box.
    const rule = ruleBody('.ovw-llmdist-lane-idle-note')
    expect(rule).toContain('position: sticky')
    // 106px = the label allowance .ovw-llmdist-canvas reserves in its width calc.
    expect(rule).toContain('left: 106px')
    expect(ruleBody('.ovw-llmdist-canvas')).toContain('106px')
  })
})
