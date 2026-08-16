// String-contract guard for card c12abc67: inline diff-comment UI.
// House idiom: source files read as strings, no DOM/runtime.
//
// Key contracts:
//   - GET /api/kanban/:id/diff-comments fetched on modal open
//   - 404 → section stays hidden (pair-BE 906c130f not yet built)
//   - Empty diffs → .diff-empty
//   - Error → .diff-error
//   - Renders per-file diff-table with .diff-line-add/.diff-line-remove/.diff-line-context
//   - "+" button per line → shows add-comment form for that line
//   - POST /api/kanban/:id/diff-comments to submit; DELETE for remove
//   - Toggle button collapses/expands the diff body
//   - i18n parity: all kanban.diff.* keys in hu.js and en.js
//   - CSS: all .diff-* classes defined, responsive breakpoint
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP  = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS  = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HU   = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN   = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

function fnBody(source: string, startMarker: string, maxLen = 8000): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextAsync = source.indexOf('\nasync function ', start + startMarker.length)
  const nextSync  = source.indexOf('\nfunction ', start + startMarker.length)
  const candidates = [nextAsync, nextSync].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + maxLen
  return source.slice(start, end)
}

describe('diff-inline-comments: loadCardDiffComments', () => {
  it('function is defined in app.js', () => {
    expect(APP).toContain('async function loadCardDiffComments(')
  })

  it('fetches /api/kanban/:id/diff-comments with auth token', () => {
    const body = fnBody(APP, 'async function loadCardDiffComments(')
    expect(body).toContain('/api/kanban/')
    expect(body).toContain('/diff-comments')
    expect(body).toContain('Authorization')
  })

  it('hides section on 404 (graceful fallback)', () => {
    const body = fnBody(APP, 'async function loadCardDiffComments(')
    expect(body).toContain('r.status === 404')
    const i = body.indexOf('r.status === 404')
    const slice = body.slice(i, i + 60)
    expect(slice).toContain('section.hidden = true')
  })

  it('renders .diff-empty when diffs array is empty', () => {
    const body = fnBody(APP, 'async function loadCardDiffComments(')
    expect(body).toContain('diff-empty')
    expect(body).toContain("kanban.diff.empty")
  })

  it('renders .diff-error on fetch failure', () => {
    const body = fnBody(APP, 'async function loadCardDiffComments(')
    expect(body).toContain('diff-error')
    expect(body).toContain("kanban.diff.error")
  })

  it('calls renderDiffFile for each file diff', () => {
    const body = fnBody(APP, 'async function loadCardDiffComments(')
    expect(body).toContain('renderDiffFile')
  })

  it('calls wireCardDiffToggle after render', () => {
    const body = fnBody(APP, 'async function loadCardDiffComments(')
    expect(body).toContain('wireCardDiffToggle')
  })

  it('calls wireDiffInteractions after render', () => {
    const body = fnBody(APP, 'async function loadCardDiffComments(')
    expect(body).toContain('wireDiffInteractions')
  })
})

describe('diff-inline-comments: renderDiffFile', () => {
  it('function is defined', () => {
    expect(APP).toContain('function renderDiffFile(')
  })

  it('renders .diff-file wrapper', () => {
    const body = fnBody(APP, 'function renderDiffFile(')
    expect(body).toContain('diff-file')
  })

  it('renders .diff-file-header with file name and sha', () => {
    const body = fnBody(APP, 'function renderDiffFile(')
    expect(body).toContain('diff-file-header')
    expect(body).toContain('diff-file-name')
    expect(body).toContain('diff-file-sha')
  })

  it('renders diff-line-add for added lines', () => {
    const body = fnBody(APP, 'function renderDiffFile(')
    expect(body).toContain('diff-line-add')
  })

  it('renders diff-line-remove for removed lines', () => {
    const body = fnBody(APP, 'function renderDiffFile(')
    expect(body).toContain('diff-line-remove')
  })

  it('renders diff-line-context for context lines', () => {
    const body = fnBody(APP, 'function renderDiffFile(')
    expect(body).toContain('diff-line-context')
  })

  it('renders .diff-add-comment-btn per line', () => {
    const body = fnBody(APP, 'function renderDiffFile(')
    expect(body).toContain('diff-add-comment-btn')
  })

  it('renders inline .diff-add-form per line (hidden by default)', () => {
    const body = fnBody(APP, 'function renderDiffFile(')
    expect(body).toContain('diff-add-form')
    expect(body).toContain('hidden')
  })

  it('renders existing inline comments in .diff-inline-comments', () => {
    const body = fnBody(APP, 'function renderDiffFile(')
    expect(body).toContain('diff-inline-comments')
    expect(body).toContain('diff-inline-comment')
    expect(body).toContain('diff-comment-delete')
  })

  it('renders hunk header', () => {
    const body = fnBody(APP, 'function renderDiffFile(')
    expect(body).toContain('diff-hunk-header')
  })
})

describe('diff-inline-comments: addDiffComment', () => {
  it('function is defined', () => {
    expect(APP).toContain('async function addDiffComment(')
  })

  it('POSTs to /api/kanban/:id/diff-comments', () => {
    const body = fnBody(APP, 'async function addDiffComment(')
    expect(body).toContain("method: 'POST'")
    expect(body).toContain('/diff-comments')
  })

  it('sends sha, file, line, text, author in body', () => {
    const body = fnBody(APP, 'async function addDiffComment(')
    expect(body).toContain('sha')
    expect(body).toContain('file')
    expect(body).toContain('line')
    expect(body).toContain('text')
    expect(body).toContain('author')
  })
})

describe('diff-inline-comments: wireDiffInteractions', () => {
  it('function is defined', () => {
    expect(APP).toContain('function wireDiffInteractions(')
  })

  it('wires "+" buttons to toggle the add-comment form', () => {
    const body = fnBody(APP, 'function wireDiffInteractions(')
    expect(body).toContain('diff-add-comment-btn')
    expect(body).toContain('diff-add-form')
    expect(body).toContain('form.hidden')
  })

  it('wires cancel buttons to hide form and clear textarea', () => {
    const body = fnBody(APP, 'function wireDiffInteractions(')
    expect(body).toContain('diff-cancel-btn')
    expect(body).toContain('textarea')
  })

  it('wires submit buttons to call addDiffComment then reload', () => {
    const body = fnBody(APP, 'function wireDiffInteractions(')
    expect(body).toContain('diff-submit-btn')
    expect(body).toContain('addDiffComment')
    expect(body).toContain('loadCardDiffComments')
  })

  it('wires delete buttons to DELETE endpoint and reload', () => {
    const body = fnBody(APP, 'function wireDiffInteractions(')
    expect(body).toContain('diff-comment-delete')
    expect(body).toContain("method: 'DELETE'")
    expect(body).toContain('loadCardDiffComments')
  })
})

describe('diff-inline-comments: showCardDetail integration', () => {
  it('calls loadCardDiffComments on modal open', () => {
    const body = fnBody(APP, 'async function showCardDetail(')
    expect(body).toContain('loadCardDiffComments')
  })
})

describe('diff-inline-comments: HTML', () => {
  it('cardDiffSection exists and is hidden by default', () => {
    expect(HTML).toContain('id="cardDiffSection"')
    const idx = HTML.indexOf('id="cardDiffSection"')
    const tag = HTML.slice(idx - 10, idx + 100)
    expect(tag).toContain('hidden')
  })

  it('cardDiffBody exists for dynamic content', () => {
    expect(HTML).toContain('id="cardDiffBody"')
  })

  it('cardDiffToggle button exists with aria-expanded', () => {
    expect(HTML).toContain('id="cardDiffToggle"')
    const idx = HTML.indexOf('id="cardDiffToggle"')
    const tag = HTML.slice(idx - 10, idx + 80)
    expect(tag).toContain('aria-expanded')
  })

  it('diff section is inside the card detail modal', () => {
    const overlayIdx = HTML.indexOf('id="cardDetailOverlay"')
    const sectionIdx = HTML.indexOf('id="cardDiffSection"', overlayIdx)
    const overlayEnd = HTML.indexOf('id="archivedDetailOverlay"', overlayIdx)
    expect(sectionIdx).toBeGreaterThan(overlayIdx)
    expect(sectionIdx).toBeLessThan(overlayEnd)
  })
})

describe('diff-inline-comments: CSS', () => {
  it('defines #cardDiffSection[hidden]', () => {
    expect(CSS).toContain('#cardDiffSection[hidden]')
  })

  it('defines .diff-file and .diff-file-header', () => {
    expect(CSS).toContain('.diff-file {')
    expect(CSS).toContain('.diff-file-header')
  })

  it('defines .diff-line-add and .diff-line-remove', () => {
    expect(CSS).toContain('.diff-line-add')
    expect(CSS).toContain('.diff-line-remove')
  })

  it('defines .diff-add-comment-btn with opacity transition', () => {
    const idx = CSS.indexOf('.diff-add-comment-btn')
    expect(idx).toBeGreaterThan(-1)
    const slice = CSS.slice(idx, idx + 200)
    expect(slice).toContain('opacity')
  })

  it('defines .diff-inline-comment and .diff-comment-delete', () => {
    expect(CSS).toContain('.diff-inline-comment')
    expect(CSS).toContain('.diff-comment-delete')
  })

  it('defines .diff-add-form[hidden] override', () => {
    expect(CSS).toContain('.diff-add-form[hidden]')
  })

  it('has responsive breakpoint for narrow screens', () => {
    const idx = CSS.indexOf('.diff-line-num')
    const mediaIdx = CSS.indexOf('@media (max-width', idx)
    expect(mediaIdx).toBeGreaterThan(idx)
  })
})

describe('diff-inline-comments: i18n parity', () => {
  const keys = [
    'kanban.diff.title',
    'kanban.diff.collapse',
    'kanban.diff.expand',
    'kanban.diff.empty',
    'kanban.diff.error',
    'kanban.diff.add_comment_ph',
    'kanban.diff.add_btn',
    'kanban.diff.cancel_btn',
    'kanban.diff.delete_btn',
    'kanban.diff.delete_confirm',
  ]
  for (const key of keys) {
    it(`"${key}" exists in both hu.js and en.js`, () => {
      expect(HU).toContain(`'${key}'`)
      expect(EN).toContain(`'${key}'`)
    })
  }
})
