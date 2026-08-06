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

// Card b82f952f (Peti COSTOPS): further DRAFT-only offload presets beyond the first 44. Each new
// category must be wired end to end -- a real template on disk (system block + '---' + {{INPUT}}),
// a curated HU description (not a bare name-fallback), and surfaced by listCategories() so the
// dashboard toggle controls it.
describe('new offload categories are wired end to end (card b82f952f)', () => {
  const NEW_CATEGORIES = [
    'user-story', 'acceptance-criteria', 'edge-cases', 'log-summary',
    'keywords', 'alt-text', 'faq', 'commit-split',
  ]
  const skillDir = join(STORE_DIR, 'local-llm-skills')

  it('lists at least 52 categories now (44 + the 8 new), sourced from disk', () => {
    expect(listCategories().length).toBeGreaterThanOrEqual(52)
  })

  it('each new category has a valid template: non-empty system block, a --- separator, and {{INPUT}}', () => {
    for (const name of NEW_CATEGORIES) {
      const tpl = readFileSync(join(skillDir, `${name}.txt`), 'utf8')
      const sepIdx = tpl.split('\n').indexOf('---')
      expect(sepIdx, `${name}: missing '---' separator`).toBeGreaterThan(0) // system block precedes it
      expect(tpl.includes('{{INPUT}}'), `${name}: missing {{INPUT}} placeholder`).toBe(true)
      // the system block (before ---) must carry a real instruction, not be empty
      expect(tpl.slice(0, tpl.indexOf('\n---')).trim().length, `${name}: empty system block`).toBeGreaterThan(20)
    }
  })

  it('each new category surfaces via listCategories with a curated description (not a bare name fallback)', () => {
    const byName = new Map(listCategories().map((c) => [c.name, c]))
    for (const name of NEW_CATEGORIES) {
      const cat = byName.get(name)
      expect(cat, `${name}: not listed`).toBeTruthy()
      // A real description, not the name-fallback the loader uses for an undescribed category.
      expect(cat!.description).not.toBe(name)
      expect(cat!.description.length).toBeGreaterThan(name.length)
      expect(cat!.description).toContain(' ')
    }
  })

  it('the new category names all pass the POST allowlist (dashboard toggle can reach them)', () => {
    for (const name of NEW_CATEGORIES) expect(isValidCategoryName(name)).toBe(true)
  })
})

// Card 91b68885 (Peti approved the 2026-08-02 proposal list, "Mind menjen!"): +15 more DRAFT-only
// offload presets, 52 -> 67. Same wire-up contract as b82f952f: real template on disk, curated HU
// description, surfaced by listCategories(), passes the path-traversal allowlist.
describe('the 2026-08-02 category batch is wired end to end (card 91b68885)', () => {
  const NEW_CATEGORIES_2 = [
    'code-review-checklist', 'migration-plan-draft', 'api-doc-draft', 'onboarding-doc',
    'incident-postmortem-draft', 'module-impl', 'class-impl', 'state-machine-impl',
    'algorithm-impl', 'parser-impl', 'rate-limiter-impl', 'validation-pipeline',
    'cache-wrapper-impl', 'worker-consumer-impl', 'test-suite-full',
  ]
  const skillDir = join(STORE_DIR, 'local-llm-skills')

  it('lists at least 67 categories now (52 + the 15 new), sourced from disk', () => {
    expect(listCategories().length).toBeGreaterThanOrEqual(67)
  })

  it('each new category has a valid template: non-empty system block, a --- separator, and {{INPUT}}', () => {
    for (const name of NEW_CATEGORIES_2) {
      const tpl = readFileSync(join(skillDir, `${name}.txt`), 'utf8')
      const sepIdx = tpl.split('\n').indexOf('---')
      expect(sepIdx, `${name}: missing '---' separator`).toBeGreaterThan(0)
      expect(tpl.includes('{{INPUT}}'), `${name}: missing {{INPUT}} placeholder`).toBe(true)
      expect(tpl.slice(0, tpl.indexOf('\n---')).trim().length, `${name}: empty system block`).toBeGreaterThan(20)
    }
  })

  it('each new category surfaces via listCategories with a curated description (not a bare name fallback)', () => {
    const byName = new Map(listCategories().map((c) => [c.name, c]))
    for (const name of NEW_CATEGORIES_2) {
      const cat = byName.get(name)
      expect(cat, `${name}: not listed`).toBeTruthy()
      expect(cat!.description).not.toBe(name)
      expect(cat!.description.length).toBeGreaterThan(name.length)
      expect(cat!.description).toContain(' ')
    }
  })

  it('the new category names all pass the POST allowlist (dashboard toggle can reach them)', () => {
    for (const name of NEW_CATEGORIES_2) expect(isValidCategoryName(name)).toBe(true)
  })
})

// Card TBD (Peti 2026-08-02, "az ügynökök feladatai alapján készíts még kategóriákat"): +11 categories
// covering recurring role-agent OUTPUT formatting (QA, Cybersec/Cybered, jogász, marketing, pénzügy,
// performance) -- 67 -> 78. Same wire-up contract as the prior batches.
describe('the 2026-08-02 agent-task-driven category batch is wired end to end', () => {
  const NEW_CATEGORIES_3 = [
    'qa-test-plan', 'bug-report-draft', 'finding-writeup', 'retro-notes', 'standup-update',
    'pricing-comparison-draft', 'unit-economics-summary', 'gtm-plan-draft', 'landing-copy-draft',
    'legal-summary', 'perf-summary',
  ]
  const skillDir = join(STORE_DIR, 'local-llm-skills')

  it('lists at least 78 categories now (67 + the 11 new), sourced from disk', () => {
    expect(listCategories().length).toBeGreaterThanOrEqual(78)
  })

  it('each new category has a valid template: non-empty system block, a --- separator, and {{INPUT}}', () => {
    for (const name of NEW_CATEGORIES_3) {
      const tpl = readFileSync(join(skillDir, `${name}.txt`), 'utf8')
      const sepIdx = tpl.split('\n').indexOf('---')
      expect(sepIdx, `${name}: missing '---' separator`).toBeGreaterThan(0)
      expect(tpl.includes('{{INPUT}}'), `${name}: missing {{INPUT}} placeholder`).toBe(true)
      expect(tpl.slice(0, tpl.indexOf('\n---')).trim().length, `${name}: empty system block`).toBeGreaterThan(20)
    }
  })

  it('each new category surfaces via listCategories with a curated description (not a bare name fallback)', () => {
    const byName = new Map(listCategories().map((c) => [c.name, c]))
    for (const name of NEW_CATEGORIES_3) {
      const cat = byName.get(name)
      expect(cat, `${name}: not listed`).toBeTruthy()
      expect(cat!.description).not.toBe(name)
      expect(cat!.description.length).toBeGreaterThan(name.length)
      expect(cat!.description).toContain(' ')
    }
  })

  it('the new category names all pass the POST allowlist (dashboard toggle can reach them)', () => {
    for (const name of NEW_CATEGORIES_3) expect(isValidCategoryName(name)).toBe(true)
  })
})
