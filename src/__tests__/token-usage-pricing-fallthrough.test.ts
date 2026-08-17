// Weekly pricing-reconciliation check (card 270e3ef4), 2026-08-17 run. tuPriceForModel() does
// LONGEST-PREFIX matching over TU_MODEL_PRICING's keys (web/app-token-usage.js) -- a model with no
// explicit row silently falls through to whichever shorter key it happens to start with, or to
// `default`. That is exactly how 'claude-opus-4-5' would have been billed: no row existed for it,
// so it fell through past 'claude-opus-4-8'/4-7/4-6 (none of which it starts with) to the bare
// 'claude-opus-4' row -- 15/75, the OLD Opus tier -- instead of its real rate, 5/25 (same tier as
// 4.6/4.7/4.8). 'claude-haiku-3-5' had the same shape of gap, falling through to `default` (3/15)
// instead of its real 0.80/4. Both rows were added; this file proves the real shipped function
// resolves them correctly now, not just that the source text contains the numbers somewhere.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '..', '..', 'web', 'app-token-usage.js'), 'utf8')

// Pull a top-level `const NAME = { ... }` or `function name(...) { ... }` out of the source by
// brace matching, so the test evaluates the real shipped code, not a hand-copied reimplementation
// (same technique as messages-view-display-name.test.ts's extractFn).
function extractBlock(re: RegExp): string {
  const m = re.exec(src)
  if (!m) throw new Error(`pattern not found in web/app-token-usage.js: ${re}`)
  let depth = 0
  for (let j = src.indexOf('{', m.index); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1)
  }
  throw new Error('unbalanced braces while extracting block')
}

function loadTuPriceForModel(): (model: string | null) => { in: number; out: number; cw: number; cr: number } {
  const sonnet5 = extractBlock(/const TU_SONNET5_PRICE\s*=\s*\{/)
  const pricing = extractBlock(/const TU_MODEL_PRICING\s*=\s*\{/)
  const fn = extractBlock(/function tuPriceForModel\s*\([^)]*\)\s*\{/)
  const body = `${sonnet5}\n${pricing}\n${fn}\nreturn tuPriceForModel`
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(body)()
}

describe('tuPriceForModel prefix-matching (weekly pricing check, card 270e3ef4)', () => {
  it('claude-opus-4-5 resolves to its OWN tier (5/25), not the old Opus 4/4.1 tier (15/75)', () => {
    const tuPriceForModel = loadTuPriceForModel()
    const rate = tuPriceForModel('claude-opus-4-5-20260101')
    expect(rate.in).toBe(5.0)
    expect(rate.out).toBe(25.0)
  })

  it('claude-haiku-3-5 resolves to its own retired rate (0.80/4), not `default` (3/15)', () => {
    const tuPriceForModel = loadTuPriceForModel()
    const rate = tuPriceForModel('claude-haiku-3-5-20241022')
    expect(rate.in).toBe(0.80)
    expect(rate.out).toBe(4.0)
  })

  it('CONTROL: sibling tiers this file already priced correctly are unaffected', () => {
    const tuPriceForModel = loadTuPriceForModel()
    expect(tuPriceForModel('claude-opus-4-8-20260601').in).toBe(5.0)
    expect(tuPriceForModel('claude-opus-4-1-20250805').in).toBe(15.0)
    expect(tuPriceForModel('claude-opus-4-20250514').in).toBe(15.0)
    expect(tuPriceForModel('claude-sonnet-5-20260601').in).toBe(2.0)
    expect(tuPriceForModel('claude-haiku-4-5-20251001').in).toBe(1.0)
  })

  it('a genuinely unknown model still falls through to `default`, not a fabricated rate', () => {
    const tuPriceForModel = loadTuPriceForModel()
    const rate = tuPriceForModel('gpt-4o')
    expect(rate.in).toBe(3.0)
    expect(rate.out).toBe(15.0)
  })
})
