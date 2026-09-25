// Card 1ef7bd9c / Cybersec 4822 census: all 3 dashboard /move call sites (column drag-drop, touch
// drag-drop, the status <select> editor) sent `actor` but never `reason` -- so once the bulk-write
// guard (card 4bbb5167, src/db.ts bulkAttributionRequired) made BOTH fields mandatory during a busy
// 60s window, a legitimate human drag on the board had no way to satisfy it and just failed.
//
// House idiom: source files read as strings, asserted against short formatting-proof fragments
// (see kanban-module.test.ts, the same style for the same module).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MODULE = readFileSync(join(__dirname, '../../web/app-kanban.js'), 'utf-8')
const EN     = readFileSync(join(__dirname, '../../web/lang/en.js'),    'utf-8')
const HU     = readFileSync(join(__dirname, '../../web/lang/hu.js'),    'utf-8')

// Strip //-comments before matching, so a needle can only be satisfied by real code, not a comment
// that merely describes the shape (Cybersec, card a14812e8 / e5b7ff19 pattern).
function stripLineComments(src: string): string {
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}
const CODE = stripLineComments(MODULE)

describe('postKanbanMove retries a bulk-refused move with a reason (card 1ef7bd9c)', () => {
  it('the helper is declared', () => {
    expect(CODE).toMatch(/async function postKanbanMove\(/)
  })

  it('on a 409, it checks for the bulk_attribution_required code before prompting', () => {
    expect(CODE).toContain("code === 'bulk_attribution_required'")
  })

  it('it resubmits the SAME move with a reason field added, not a fresh body', () => {
    expect(CODE).toMatch(/doFetch\(\s*\{\s*\.\.\.body,\s*reason:\s*reason\.trim\(\)\s*\}\s*\)/)
  })

  it('all three /move call sites go through the helper, not a raw fetch', () => {
    const rawMoveFetch = /fetch\(`\/api\/kanban\/\$\{encodeURIComponent\([^)]*\)\}\/move`/g
    expect(CODE.match(rawMoveFetch)?.length ?? 0).toBe(1) // exactly one: inside postKanbanMove itself
    expect((CODE.match(/postKanbanMove\(/g) ?? []).length).toBe(4) // 1 declaration + 3 call sites
  })

  it('the prompt copy is localized, not hardcoded English in the module', () => {
    expect(CODE).not.toMatch(/window\.prompt\(['"]/)
    expect(CODE).toContain("window.prompt(t('kanban.toast.bulk_attribution_reason_prompt'))")
  })
})

describe('the prompt string exists in both locales, non-empty (lang-parity covers key presence)', () => {
  it('en.js has a real sentence, not a placeholder', () => {
    const m = EN.match(/'kanban\.toast\.bulk_attribution_reason_prompt':\s*'([^']+)'/)
    expect(m).not.toBeNull()
    expect(m![1].length).toBeGreaterThan(10)
  })

  it('hu.js has a real sentence, not a placeholder', () => {
    const m = HU.match(/'kanban\.toast\.bulk_attribution_reason_prompt':\s*'([^']+)'/)
    expect(m).not.toBeNull()
    expect(m![1].length).toBeGreaterThan(10)
  })
})
