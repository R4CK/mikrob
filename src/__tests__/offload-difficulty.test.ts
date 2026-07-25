import { describe, it, expect } from 'vitest'
import {
  CODING_DIFFICULTY_LEVELS,
  RELIABLE_CEILING,
  defaultDifficultyForAggressiveness,
  normalizeDifficulty,
  isDraftableLocally,
} from '../web/routes/local-llm.js'

// Card afcfe93e: map offload aggressiveness -> a coding-difficulty threshold, and gate whether a
// coding task may draft locally. These pure helpers back the dashboard dropdown + the rag.sh gate.
describe('CODING_DIFFICULTY_LEVELS', () => {
  it('is the ordered coding-only taxonomy (ascending hardness)', () => {
    expect(CODING_DIFFICULTY_LEVELS).toEqual(['trivial', 'isolated', 'module', 'feature', 'architecture'])
  })
  it("marks 'module' as the local 7B's reliable ceiling", () => {
    expect(RELIABLE_CEILING).toBe('module')
    // feature/architecture sit ABOVE the reliable ceiling
    expect(CODING_DIFFICULTY_LEVELS.indexOf('feature')).toBeGreaterThan(CODING_DIFFICULTY_LEVELS.indexOf(RELIABLE_CEILING))
  })
})

describe('defaultDifficultyForAggressiveness', () => {
  it('maps each aggressiveness band to the documented max difficulty', () => {
    expect(defaultDifficultyForAggressiveness(0)).toBe('trivial')
    expect(defaultDifficultyForAggressiveness(74)).toBe('trivial')
    expect(defaultDifficultyForAggressiveness(75)).toBe('isolated') // the marked optimum
    expect(defaultDifficultyForAggressiveness(84)).toBe('isolated')
    expect(defaultDifficultyForAggressiveness(85)).toBe('module')
    expect(defaultDifficultyForAggressiveness(94)).toBe('module')
    expect(defaultDifficultyForAggressiveness(95)).toBe('feature')
    expect(defaultDifficultyForAggressiveness(99)).toBe('feature')
    expect(defaultDifficultyForAggressiveness(100)).toBe('architecture')
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
    expect(defaultDifficultyForAggressiveness(9999)).toBe('architecture') // clamped to 100
    expect(defaultDifficultyForAggressiveness('85')).toBe('module') // numeric string
    expect(defaultDifficultyForAggressiveness('abc')).toBe('isolated') // non-numeric -> default 75 -> isolated
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
