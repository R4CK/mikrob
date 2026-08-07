import { describe, it, expect } from 'vitest'
import {
  CODING_DIFFICULTY_LEVELS,
  RELIABLE_CEILING,
  OFFLOADABLE_THRESHOLDS,
  defaultDifficultyForAggressiveness,
  normalizeDifficulty,
  normalizeThreshold,
  isDraftableLocally,
} from '../web/routes/local-llm.js'

// Card afcfe93e: map offload aggressiveness -> a coding-difficulty threshold, and gate whether a
// coding task may draft locally. These pure helpers back the dashboard dropdown + the rag.sh gate.
describe('CODING_DIFFICULTY_LEVELS', () => {
  it('is the ordered coding-only taxonomy (ascending hardness)', () => {
    expect(CODING_DIFFICULTY_LEVELS).toEqual(['trivial', 'isolated', 'module', 'feature', 'architecture'])
  })
  it("marks 'feature' as the reliable/offload ceiling (Peti, 2026-08-07); architecture sits above it", () => {
    expect(RELIABLE_CEILING).toBe('feature')
    expect(CODING_DIFFICULTY_LEVELS.indexOf('architecture')).toBeGreaterThan(CODING_DIFFICULTY_LEVELS.indexOf(RELIABLE_CEILING))
  })
  it('offers only <=ceiling levels as offload thresholds (architecture never offloads)', () => {
    expect(OFFLOADABLE_THRESHOLDS).toEqual(['trivial', 'isolated', 'module', 'feature'])
    expect(OFFLOADABLE_THRESHOLDS).not.toContain('architecture')
  })
})

describe('defaultDifficultyForAggressiveness', () => {
  it('maps aggressiveness -> max difficulty, CAPPED at the reliable ceiling (Peti 2026-08-07: 100% never exceeds it)', () => {
    expect(defaultDifficultyForAggressiveness(0)).toBe('trivial')
    expect(defaultDifficultyForAggressiveness(74)).toBe('trivial')
    expect(defaultDifficultyForAggressiveness(75)).toBe('isolated') // the marked optimum
    expect(defaultDifficultyForAggressiveness(84)).toBe('isolated')
    expect(defaultDifficultyForAggressiveness(85)).toBe('module')
    expect(defaultDifficultyForAggressiveness(94)).toBe('module')
    expect(defaultDifficultyForAggressiveness(95)).toBe('feature')
    expect(defaultDifficultyForAggressiveness(100)).toBe('feature') // capped, never 'architecture'
  })
  it('never returns a level above the reliable ceiling for any 0..100', () => {
    const cap = CODING_DIFFICULTY_LEVELS.indexOf(RELIABLE_CEILING)
    for (let a = 0; a <= 100; a++) {
      expect(CODING_DIFFICULTY_LEVELS.indexOf(defaultDifficultyForAggressiveness(a))).toBeLessThanOrEqual(cap)
    }
  })
  it('is monotonic non-decreasing across 0..100', () => {
    let prev = -1
    for (let a = 0; a <= 100; a++) {
      const idx = CODING_DIFFICULTY_LEVELS.indexOf(defaultDifficultyForAggressiveness(a))
      expect(idx).toBeGreaterThanOrEqual(prev)
      prev = idx
    }
  })
  it('reuses normalizeAggressiveness (clamps/parses/defaults) for its input', () => {
    expect(defaultDifficultyForAggressiveness(-5)).toBe('trivial') // clamped to 0
    expect(defaultDifficultyForAggressiveness(9999)).toBe('feature') // clamped to 100 -> capped feature
    expect(defaultDifficultyForAggressiveness('85')).toBe('module') // numeric string
    expect(defaultDifficultyForAggressiveness('abc')).toBe('isolated') // non-numeric -> default 75 -> isolated
  })
})

describe('normalizeThreshold (clamps to the reliable ceiling)', () => {
  it('passes through an offloadable level unchanged', () => {
    expect(normalizeThreshold('trivial')).toBe('trivial')
    expect(normalizeThreshold('isolated')).toBe('isolated')
    expect(normalizeThreshold('module')).toBe('module')
    expect(normalizeThreshold('feature')).toBe('feature')
  })
  it('clamps a level above the ceiling down to feature (architecture never offloads)', () => {
    expect(normalizeThreshold('architecture')).toBe('feature')
  })
  it('returns null for unknown/absent (caller derives from the slider)', () => {
    expect(normalizeThreshold('auto')).toBeNull()
    expect(normalizeThreshold('nope')).toBeNull()
    expect(normalizeThreshold(null)).toBeNull()
    expect(normalizeThreshold(undefined)).toBeNull()
  })
})

describe('normalizeDifficulty', () => {
  it('passes through a known level', () => {
    for (const lvl of CODING_DIFFICULTY_LEVELS) expect(normalizeDifficulty(lvl)).toBe(lvl)
  })
  it('returns null for unknown / non-string (caller then derives from the slider)', () => {
    expect(normalizeDifficulty('superhard')).toBeNull()
    expect(normalizeDifficulty('auto')).toBeNull()
    expect(normalizeDifficulty('')).toBeNull()
    expect(normalizeDifficulty(null)).toBeNull()
    expect(normalizeDifficulty(undefined)).toBeNull()
    expect(normalizeDifficulty(3)).toBeNull()
    expect(normalizeDifficulty({})).toBeNull()
  })
})

describe('isDraftableLocally', () => {
  it('allows a task at or below the threshold', () => {
    expect(isDraftableLocally('trivial', 'isolated')).toBe(true)
    expect(isDraftableLocally('isolated', 'isolated')).toBe(true)
    expect(isDraftableLocally('module', 'feature')).toBe(true)
  })
  it('denies a task harder than the threshold', () => {
    expect(isDraftableLocally('module', 'isolated')).toBe(false)
    expect(isDraftableLocally('architecture', 'feature')).toBe(false)
    expect(isDraftableLocally('feature', 'trivial')).toBe(false)
  })
})
