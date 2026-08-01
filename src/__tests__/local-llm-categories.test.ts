import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { listCategories, isValidCategoryName } from '../web/routes/local-llm.js'

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

// Card 18a0acb9 (Cybersec adjacent findings): (1) the categories POST must reject a path-traversal
// task name BEFORE joining it into a filesystem path; (2) the dashboard category row must escape the
// `meta` interpolation so no data-origin value can inject markup on the Bearer-gated admin surface.
describe('isValidCategoryName (path-traversal guard, card 18a0acb9)', () => {
  it('rejects traversal + injection payloads', () => {
    for (const bad of [
      '../../etc/passwd', '../foo', 'a/b', 'foo.txt', '.', '..', 'foo\0bar',
      'UPPER', 'space name', 'a'.repeat(65), '', 'foo;rm', 'café',
    ]) {
      expect(isValidCategoryName(bad)).toBe(false)
    }
  })

  it('accepts every real category name on disk (does not break legit input)', () => {
    for (const c of listCategories()) {
      expect(isValidCategoryName(c.name)).toBe(true)
    }
    // and a couple of representative shapes explicitly
    expect(isValidCategoryName('card-decompose')).toBe(true)
    expect(isValidCategoryName('regex')).toBe(true)
  })

  it('the POST handler validates the name BEFORE the path join (wiring, not just the predicate)', () => {
    const src = readFileSync(join(STORE_DIR, '..', 'src', 'web', 'routes', 'local-llm.ts'), 'utf8')
    const guardAt = src.indexOf('isValidCategoryName(task)')
    const joinAt = src.indexOf('existsSync(join(SKILL_DIR, `${task}.txt`))')
    expect(guardAt).toBeGreaterThan(0)
    expect(joinAt).toBeGreaterThan(0)
    // The guard must appear before the join, or a `../` could reach the filesystem path.
    expect(guardAt).toBeLessThan(joinAt)
  })
})

describe('dashboard category-row escapes the meta interpolation (stored-XSS guard, card 18a0acb9)', () => {
  it('web/app.js interpolates ${escapeHtml(meta)}, never a bare ${meta}', () => {
    const appJs = readFileSync(join(STORE_DIR, '..', 'web', 'app.js'), 'utf8')
    // The escaped form must be present...
    expect(appJs).toContain('llm-category-meta">${escapeHtml(meta)}')
    // ...and the unescaped form must be gone, so a future edit reverting it fails CI.
    expect(appJs).not.toContain('llm-category-meta">${meta}')
  })
})
