// String-contract guard for the project-dispatch-priority dropdown and the priority-badge
// contrast fix (card e291e9c4, BE sibling 2d6587fe, Peti screenshot 2026-08-08). Follows the
// house idiom (see last-update-badge-ui.test.ts / approvals-ui-contract.test.ts): app.js is a
// single global script with no module boundary to import a function from directly, so the
// frontend files are read as strings and asserted against short, formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

function fnBody(source: string, startMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nfunction ', start + startMarker.length)
  const nextAsyncFn = source.indexOf('\nasync function ', start + startMarker.length)
  const candidates = [nextFn, nextAsyncFn].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + 3000
  return source.slice(start, end)
}

describe('project dispatch-priority dropdown', () => {
  it('the dropdown lives in the board filter row, next to the project filter', () => {
    expect(HTML).toContain('id="kanbanPriorityProjectSelect"')
    const priIdx = HTML.indexOf('id="kanbanPriorityProjectSelect"')
    const projIdx = HTML.indexOf('id="kanbanProjectFilter"')
    const filtersRowEnd = HTML.indexOf('id="kanbanBoardFilters"')
    expect(projIdx).toBeGreaterThan(-1)
    expect(priIdx).toBeGreaterThan(projIdx) // sits after the project filter, same row
    expect(filtersRowEnd).toBeLessThan(priIdx)
  })

  it('is populated from the real project list, not a hardcoded option set', () => {
    expect(APP).toMatch(/async function populatePriorityProjectFilter/)
    const body = fnBody(APP, 'async function populatePriorityProjectFilter')
    expect(body).toContain('kanbanProjects') // the same live-fetched list the project FILTER uses
    expect(body).toContain("fetch('/api/config/project-priority')")
  })

  it('saves via PUT to the BE sibling endpoint, sending an array (order = priority)', () => {
    const anchor = "kanbanPriorityProjectSelect').addEventListener('change'"
    const idx = APP.indexOf(anchor)
    expect(idx, 'the priority-select change listener was not found').toBeGreaterThan(-1)
    const body = APP.slice(idx, idx + 1500)
    expect(body).toContain("method: 'PUT'")
    expect(body).toContain('/api/config/project-priority')
    expect(body).toMatch(/priority:\s*value\s*\?\s*\[value\]\s*:\s*\[\]/)
  })

  it('reverts the visible selection on a failed save, and never shows a raw server error', () => {
    const anchor = "kanbanPriorityProjectSelect').addEventListener('change'"
    const idx = APP.indexOf(anchor)
    const body = APP.slice(idx, idx + 1500)
    expect(body).toContain('sel.value = prevValue')
    // Rule 12: no raw fetch/response error text surfaced to the user.
    expect(body).not.toMatch(/showToast\(\s*(String\(err|err\.message|err\.error)/)
    expect(body).toContain("t('kanban.filter.priority_save_failed')")
  })

  it('all kanban.filter.priority_* i18n keys exist in both HU and EN', () => {
    const keys = [
      'kanban.filter.priority_label',
      'kanban.filter.priority_default',
      'kanban.filter.priority_tooltip',
      'kanban.filter.priority_saved',
      'kanban.filter.priority_cleared',
      'kanban.filter.priority_save_failed',
    ]
    for (const key of keys) {
      expect(HU, `HU missing ${key}`).toContain(`'${key}':`)
      expect(EN, `EN missing ${key}`).toContain(`'${key}':`)
    }
  })
})

describe('priority badge contrast fix (card e291e9c4)', () => {
  it('.priority-badge is a solid-fill pill with white text, one rule per level', () => {
    expect(CSS).toMatch(/\.priority-badge\s*{[^}]*color:\s*#fff/)
    for (const level of ['urgent', 'high', 'normal', 'low']) {
      expect(CSS, `missing .priority-badge.priority-${level}`).toMatch(
        new RegExp(`\\.priority-badge\\.priority-${level}\\s*{\\s*background:\\s*#[0-9a-fA-F]{6}`),
      )
    }
  })

  it('the live board card renders the badge from the real per-card priority', () => {
    const body = fnBody(APP, 'function createCardEl')
    expect(body).toContain('priorityBadgeHtml')
    expect(body).toMatch(/class="priority-badge priority-\$\{/)
    expect(body).toContain('kanban-card-footer">${priorityBadgeHtml}')
  })

  it('the archived-cards view uses the SAME badge class, not its own low-contrast pill', () => {
    // The old archived-prio-pill CSS class used a translucent tint of the priority color as both
    // text and background -- the same class of contrast problem this card exists to fix, just on
    // a different page. Checked as an actual CLASS REFERENCE (a class="..." attribute or a CSS
    // selector), not a bare substring match: app.js keeps a WHY-comment naming the old class it
    // replaced, and that mention is legitimate documentation, not a regression.
    const oldClassName = 'archived' + '-prio-pill'
    expect(APP).not.toMatch(new RegExp(`class="${oldClassName}`))
    expect(CSS).not.toMatch(new RegExp(`\\.${oldClassName}\\s*{`))
    const body = fnBody(APP, 'function renderArchivedCard')
    expect(body).toMatch(/class="priority-badge priority-\$\{/)
  })

  it('badge text color passes WCAG AA (>=4.5:1) against every level background', () => {
    // Re-derive from the CSS text itself (not a hand-copied constant here) so a future palette
    // edit that regresses contrast fails this test instead of silently drifting from the
    // measurement recorded in the CSS comment.
    function relLum(hex: string): number {
      const n = parseInt(hex.replace('#', ''), 16)
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    function contrast(a: string, b: string): number {
      const [l1, l2] = [relLum(a), relLum(b)].sort((x, y) => y - x)
      return (l1 + 0.05) / (l2 + 0.05)
    }
    for (const level of ['urgent', 'high', 'normal', 'low']) {
      const m = CSS.match(new RegExp(`\\.priority-badge\\.priority-${level}\\s*{\\s*background:\\s*(#[0-9a-fA-F]{6})`))
      expect(m, `no background hex found for priority-${level}`).toBeTruthy()
      const ratio = contrast('#ffffff', m![1])
      expect(ratio, `priority-${level} (${m![1]}) contrast vs white text`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
