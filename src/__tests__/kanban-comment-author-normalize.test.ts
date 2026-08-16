// Card c9b0b0c4: the "cybered" agent's comments landed under two case variants -- "cybered" (839)
// and "Cybered" (45) -- because the author field was free-text with no case-folding, same root
// cause as the project-name drift normalizeProjectName already fixes. Any per-agent gate stat
// built by grouping on `author` silently undercounts cybered by those 45 rows.
//
// normalizeCommentAuthor must fold a KNOWN fleet agent id onto its canonical lowercase form --
// including the main agent itself (isKnownAgent matches MAIN_AGENT_ID case-sensitively, so
// "MikroB" IS the same identity as "mikrob", just case-drifted) -- while leaving a genuine
// non-agent label (OWNER_NAME "Peti", or any other free-text author) untouched, since those never
// match a known agent id at all.
import { describe, it, expect } from 'vitest'
import { normalizeCommentAuthor } from '../web/routes/kanban.js'

describe('normalizeCommentAuthor', () => {
  it('folds a case-variant of a real fleet agent id onto the canonical lowercase form', () => {
    expect(normalizeCommentAuthor('Cybered')).toBe('cybered')
    expect(normalizeCommentAuthor('CYBERED')).toBe('cybered')
    expect(normalizeCommentAuthor('cybered')).toBe('cybered')
  })

  it('folds any other known agent id the same way', () => {
    expect(normalizeCommentAuthor('Backend2')).toBe('backend2')
    expect(normalizeCommentAuthor('QA')).toBe('qa')
  })

  it('folds a case-drifted main-agent id too -- "MikroB" IS "mikrob", not a different identity', () => {
    expect(normalizeCommentAuthor('MikroB')).toBe('mikrob')
  })

  it('leaves a name that matches NO known agent id untouched', () => {
    expect(normalizeCommentAuthor('Peti')).toBe('Peti')
    expect(normalizeCommentAuthor('some-random-caller')).toBe('some-random-caller')
  })

  it('is a no-op on an already-canonical author', () => {
    expect(normalizeCommentAuthor('backend2')).toBe('backend2')
  })
})
