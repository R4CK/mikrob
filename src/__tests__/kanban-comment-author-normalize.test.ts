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
//
// The real isKnownAgent reads agents/<id>/ off disk and MAIN_AGENT_ID from .env -- both absent
// or different in an isolated test worktree (agents/ is gitignored, card measured this directly:
// the real predicate returned false for a real fleet agent id here). So this suite injects a
// deterministic stand-in via the function's optional second parameter, exercising the same
// case-fold/pass-through LOGIC without depending on runtime install state.
import { describe, it, expect } from 'vitest'
import { normalizeCommentAuthor } from '../web/routes/kanban.js'

const knownAgent = (name: string): boolean => ['cybered', 'backend2', 'qa', 'mikrob'].includes(name)

describe('normalizeCommentAuthor', () => {
  it('folds a case-variant of a real fleet agent id onto the canonical lowercase form', () => {
    expect(normalizeCommentAuthor('Cybered', knownAgent)).toBe('cybered')
    expect(normalizeCommentAuthor('CYBERED', knownAgent)).toBe('cybered')
    expect(normalizeCommentAuthor('cybered', knownAgent)).toBe('cybered')
  })

  it('folds any other known agent id the same way', () => {
    expect(normalizeCommentAuthor('Backend2', knownAgent)).toBe('backend2')
    expect(normalizeCommentAuthor('QA', knownAgent)).toBe('qa')
  })

  it('folds a case-drifted main-agent id too -- "MikroB" IS "mikrob", not a different identity', () => {
    expect(normalizeCommentAuthor('MikroB', knownAgent)).toBe('mikrob')
  })

  it('leaves a name that matches NO known agent id untouched', () => {
    expect(normalizeCommentAuthor('Peti', knownAgent)).toBe('Peti')
    expect(normalizeCommentAuthor('some-random-caller', knownAgent)).toBe('some-random-caller')
  })

  it('is a no-op on an already-canonical author', () => {
    expect(normalizeCommentAuthor('backend2', knownAgent)).toBe('backend2')
  })

  it('defaults to the real isKnownAgent when no predicate is injected', () => {
    // Not asserting a specific fold here (that depends on install state, see header comment) --
    // just that the default path runs without throwing and returns a string.
    expect(typeof normalizeCommentAuthor('some-caller')).toBe('string')
  })
})
