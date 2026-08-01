import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { listCategories } from '../web/routes/local-llm.js'

// Card 0c054ebf: the dashboard must show ALL --task presets, not just the 4
// coding-difficulty levels -- and the list must be sourced from the real
// skill-template directory (store/local-llm-skills/*.txt), never a hardcoded
// UI array that could silently drift from what store/local-llm.sh actually
// offers. Read-only: does not touch store/local-llm-offload-active.json, since
// that file is the same one store/local-llm.sh reads at runtime for real
// offload calls -- a test must not leave it in a mutated state.
describe('listCategories', () => {
  it('lists every --task preset found on disk, matching store/local-llm-skills exactly', () => {
    const onDisk = readdirSync(join(STORE_DIR, 'local-llm-skills'))
      .filter((f) => f.endsWith('.txt'))
      .map((f) => f.slice(0, -'.txt'.length))
      .sort()

    const categories = listCategories()
    const listed = categories.map((c) => c.name).sort()

    expect(listed).toEqual(onDisk)
    expect(categories.length).toBeGreaterThanOrEqual(44)
  })

  it('every category has a shape the dashboard can render without a fallback branch', () => {
    for (const c of listCategories()) {
      expect(typeof c.name).toBe('string')
      expect(c.name.length).toBeGreaterThan(0)
      expect(typeof c.description).toBe('string')
      expect(c.description.length).toBeGreaterThan(0)
      expect(typeof c.enabled).toBe('boolean')
      expect(typeof c.count).toBe('number')
      expect(c.lastTs === null || typeof c.lastTs === 'number').toBe(true)
    }
  })
})
