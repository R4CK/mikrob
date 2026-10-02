// Cybersec MEDIUM (card 55885cb1 @ 68949451, fixed on card 82f05633): both repo-pull buttons
// now share one path (card 55885cb1), but marveen-land.sh pushes a batch BEFORE its own gate
// closes -- a landed-but-ungated UPSTREAM-SYNC batch (like ef6a8031's ed4633c2 before its fix)
// can sit on origin for a while, and a button press in that window pulls it onto the live host
// regardless. These tests exercise the REAL exported functions with fake inputs -- not a
// static source-text regex -- per Cybersec's own LOW note on this card that a static-regex
// guard lets a value arriving through a variable sail through unnoticed.
import { describe, it, expect } from 'vitest'
import { cardsInSubject, findOpenUpstreamSyncCards, type KanbanCardLookup } from '../web/routes/updates.js'

describe('cardsInSubject', () => {
  // Mirrors store/landing-downward-check.sh's cards_in_subject selftest cases exactly (same
  // regex, ported rather than reinvented) so the two extractors cannot silently diverge.
  it('extracts a single card id', () => {
    expect(cardsInSubject('feat(x): thing (card 0f7f7fe9, round 4)')).toEqual(['0f7f7fe9'])
  })

  it('extracts multiple ids separated by a slash', () => {
    expect(cardsInSubject("docs: proto (card e90505bb / 96ff46d4)")).toEqual(['e90505bb', '96ff46d4'])
  })

  it('extracts multiple ids separated by a comma (card 6500e1d3 fix)', () => {
    expect(cardsInSubject('fix(x): thing (card 11111111, deadbeef)')).toEqual(['11111111', 'deadbeef'])
  })

  it('stops at an id that is not introduced by the card/cards keyword', () => {
    expect(cardsInSubject('fix(x): thing (card 11111111) and deadbeef elsewhere')).toEqual(['11111111'])
  })

  it('is case-insensitive on the keyword and lowercases the id', () => {
    expect(cardsInSubject('fix: thing (CARDS ABCDEF01)')).toEqual(['abcdef01'])
  })

  it('finds nothing in a subject naming no card', () => {
    expect(cardsInSubject('chore(fork-guard): re-acknowledge drift')).toEqual([])
  })
})

describe('findOpenUpstreamSyncCards', () => {
  const upstreamSync = (status: string) => ({ title: '[MikroB][UPSTREAM-SYNC][HIGH] batch', status })
  const ordinaryCard = (status: string) => ({ title: '[MikroB][SEC][LOW] something else', status })
  const lookup = (table: Record<string, { title: string; status: string } | undefined>): KanbanCardLookup =>
    (id) => table[id]

  it('flags an UPSTREAM-SYNC card that is not done', () => {
    const result = findOpenUpstreamSyncCards(
      ['feat(agents): thing (card ef6a8031)'],
      lookup({ ef6a8031: upstreamSync('waiting') }),
    )
    expect(result).toEqual(['ef6a8031'])
  })

  it('does NOT flag an UPSTREAM-SYNC card that has reached done', () => {
    const result = findOpenUpstreamSyncCards(
      ['feat(agents): thing (card ef6a8031)'],
      lookup({ ef6a8031: upstreamSync('done') }),
    )
    expect(result).toEqual([])
  })

  it('does NOT flag a non-UPSTREAM-SYNC card even if open', () => {
    const result = findOpenUpstreamSyncCards(
      ['fix(x): thing (card 82f05633)'],
      lookup({ '82f05633': ordinaryCard('in_progress') }),
    )
    expect(result).toEqual([])
  })

  it('does NOT flag a card id that names no kanban card at all (unknown to lookup)', () => {
    const result = findOpenUpstreamSyncCards(['chore: thing (card 00000000)'], lookup({}))
    expect(result).toEqual([])
  })

  it('a commit naming no card at all is neutral, not a false positive', () => {
    const result = findOpenUpstreamSyncCards(['chore(fork-guard): re-acknowledge drift'], lookup({}))
    expect(result).toEqual([])
  })

  it('dedupes and sorts across multiple commits naming the same or different cards', () => {
    const result = findOpenUpstreamSyncCards(
      [
        'feat(agents): A (card bbbbbbbb)',
        'feat(agents): B (card aaaaaaaa)',
        'fix(agents): A again (card bbbbbbbb)',
      ],
      lookup({ aaaaaaaa: upstreamSync('planned'), bbbbbbbb: upstreamSync('waiting') }),
    )
    expect(result).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  })

  it('an empty commit range (nothing to pull) is trivially safe', () => {
    expect(findOpenUpstreamSyncCards([], lookup({}))).toEqual([])
  })
})
