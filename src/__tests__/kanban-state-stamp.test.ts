// Card ffaa4ff1. A dispatch message is composed against the board as it looked when it was read,
// and the recipient may not read it for hours. The stamp makes that gap visible at a glance.
//
// What these tests are really defending is the SHAPE of the guarantee: it must fire on the reference
// form dispatches actually use, must not fire twice, must not fire on things that merely look like
// card ids, and must never cost a message when the lookup misbehaves. A stamp that is sometimes
// absent is worse than none, because people stop looking for it.
import { describe, it, expect } from 'vitest'
import {
  appendCardStateStamp,
  CARD_STATE_MARKER,
  MAX_STAMPED_CARDS,
  type CardStateSnapshot,
} from '../web/kanban-state-stamp.js'

const CARDS: Record<string, CardStateSnapshot> = {
  '45331a93': { id: '45331a93', status: 'waiting', updatedAt: 1_786_200_000 },
  '6357a636': { id: '6357a636', status: 'done', updatedAt: 1_786_200_100 },
  c5afca66: { id: 'c5afca66', status: 'in_progress', updatedAt: 1_786_200_200 },
  ffaa4ff1: { id: 'ffaa4ff1', status: 'planned', updatedAt: 1_786_200_300 },
}
const lookup = (p: string): CardStateSnapshot | null => CARDS[p.toLowerCase()] ?? null

describe('the stamp fires on the form dispatch messages actually use', () => {
  it('stamps a BARE card id -- not just a #-prefixed one', () => {
    // The load-bearing case. By the time this runs, normalizeKanbanRefs has already rewritten every
    // `#<hex8>` into `#<seq>`, and a dispatch typically writes the id bare anyway ("45331a93 vettem").
    // Matching only `#<hex>` would make the stamp fire almost never.
    const out = appendCardStateStamp('45331a93 vettem, jo munka', lookup)
    expect(out).toContain(CARD_STATE_MARKER)
    expect(out).toContain('45331a93 status=waiting updated_at=1786200000')
  })

  it('keeps the original content intact, and appends at the END', () => {
    const original = 'Kerlek nezd meg a c5afca66 kartyat.'
    const out = appendCardStateStamp(original, lookup)
    expect(out.startsWith(original)).toBe(true)
    expect(out.indexOf(CARD_STATE_MARKER)).toBeGreaterThan(original.length - 1)
  })

  it('stamps several distinct cards in one message', () => {
    const out = appendCardStateStamp('45331a93 es 6357a636 is gate-en van', lookup)
    expect(out).toContain('45331a93 status=waiting')
    expect(out).toContain('6357a636 status=done')
  })

  it('a repeated id is stamped ONCE', () => {
    const out = appendCardStateStamp('45331a93 ... megint 45331a93 ... es 45331a93', lookup)
    expect(out.match(/45331a93 status=/g) ?? []).toHaveLength(1)
  })

  it(`caps the block at ${MAX_STAMPED_CARDS} cards -- a report is not a dispatch`, () => {
    const out = appendCardStateStamp('45331a93 6357a636 c5afca66 ffaa4ff1', lookup)
    expect(out.match(/status=/g) ?? []).toHaveLength(MAX_STAMPED_CARDS)
  })
})

describe('it stays quiet when it has nothing true to say', () => {
  it('a message naming NO card is returned byte-identical', () => {
    const original = 'Kesz vagyok, megyek tovabb.'
    expect(appendCardStateStamp(original, lookup)).toBe(original)
  })

  it('an 8-hex token that is NOT a card (a commit sha) is left alone', () => {
    // Commit ids are 8-hex too. The lookup gate is what separates them -- not the regex, which
    // cannot tell. Without this the stamp would append an empty block to half the fleet's messages.
    const original = 'Commit 2dfaee0c pusholva, a branch tipje az.'
    expect(appendCardStateStamp(original, lookup)).toBe(original)
  })

  it('an ALREADY stamped message is not stamped again', () => {
    // Idempotency matters because messages get re-sent and quoted. Two stamps disagreeing with each
    // other is worse than one stale stamp: the reader cannot tell which is the fresh one.
    const once = appendCardStateStamp('45331a93 nezd meg', lookup)
    expect(appendCardStateStamp(once, lookup)).toBe(once)
  })

  it('empty content is returned as-is', () => {
    expect(appendCardStateStamp('', lookup)).toBe('')
  })
})

describe('a decoration must never cost a message', () => {
  it('a THROWING lookup does not propagate -- the message survives unstamped', () => {
    // The whole feature is a hint. If the DB read fails, the correct outcome is a plain message,
    // never a 500 on POST /api/messages -- that would turn a convenience into a fleet-wide outage
    // of inter-agent delivery.
    const original = 'Nezd meg a 45331a93 kartyat'
    const boom = (): CardStateSnapshot | null => {
      throw new Error('db is down')
    }
    expect(appendCardStateStamp(original, boom)).toBe(original)
  })

  it('one card throwing does not lose the others', () => {
    const flaky = (p: string): CardStateSnapshot | null => {
      if (p === '45331a93') throw new Error('boom')
      return CARDS[p] ?? null
    }
    const out = appendCardStateStamp('45331a93 es 6357a636', flaky)
    expect(out).toContain('6357a636 status=done')
    expect(out).not.toContain('45331a93 status=')
  })
})

describe('the stamp says what it is', () => {
  it('tells the reader to re-read the card, so it is not mistaken for permission', () => {
    // It is a staleness HINT. If it ever reads like an authorization, someone will act on it
    // without re-checking -- which is the exact behaviour this card exists to stop.
    const out = appendCardStateStamp('45331a93', lookup)
    expect(out).toMatch(/olvasd ujra a kartyat/i)
    expect(out).toMatch(/a kuldes pillanataban/i)
  })
})
