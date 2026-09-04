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
    const blockRule = CSS.slice(CSS.indexOf('.ovw-llmdist-block {'), CSS.indexOf('.ovw-llmdist-block:hover'))
    expect(blockRule).not.toContain('min-width')
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

  it('the renderer packs before emitting markup', () => {
    const fn = SRC.slice(SRC.indexOf('function ovwLlmDistLanesHtml('), SRC.indexOf('function ovwLlmDistLegendHtml('))
    expect(fn).toContain('ovwLlmDistPackRows(blocks)')
    expect(fn).toContain('OVW_LLMDIST_MIN_W_PCT')
    expect(fn).not.toMatch(/Math\.max\(0\.6,/) // the literal floor moved into the shared const
  })
})
