// Card ffaa4ff1. A dispatch message is composed against the board as it looked when it was read,
// and the recipient may not read it for hours. The stamp makes that gap visible at a glance.
//
// What these tests are really defending is the SHAPE of the guarantee: it must fire on the reference
// form dispatches actually use, must not fire twice, must not fire on things that merely look like
// card ids, and must never cost a message when the lookup misbehaves. A stamp that is sometimes
// absent is worse than none, because people stop looking for it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendCardStateStamp,
  formatDeliveryStalenessNote,
  CARD_STATE_MARKER,
  CARD_STATE_DELIVERY_MARKER,
  MAX_STAMPED_CARDS,
  supersededDispatch,
  type CardStateSnapshot,
  type CardStateLookup,
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

// ---------------------------------------------------------------------------
// Card 9566a197: delivery-time re-check. The card opened on the theory that the
// SENDER reads a stale board; the queue data refuted it. Msg 19064's stamp was
// correct when written -- the card moved to done 35 minutes later, and the
// message reached its receiver 153 minutes after being written. The stamp is a
// photograph; nothing re-read the board before showing it.
// ---------------------------------------------------------------------------

describe('formatDeliveryStalenessNote (card 9566a197)', () => {
  const board: Record<string, CardStateSnapshot> = {
    '956fdaf5': { id: '956fdaf5', status: 'done', updatedAt: 1787400927 },
    '12f80902': { id: '12f80902', status: 'in_progress', updatedAt: 1787400000 },
  }
  const live = (p: string): CardStateSnapshot | null => board[p.toLowerCase()] ?? null

  // The real shape: a send-time stamp produced by appendCardStateStamp itself,
  // never a hand-written lookalike -- the two must not be allowed to drift.
  const stampedFor = (body: string, snaps: Record<string, CardStateSnapshot>): string =>
    appendCardStateStamp(body, (p) => snaps[p.toLowerCase()] ?? null)

  it('reproduces the incident: a card stamped in_progress that is now done', () => {
    const atSend = { '956fdaf5': { id: '956fdaf5', status: 'in_progress', updatedAt: 1787398822 } }
    const msg = stampedFor('956fdaf5 visszanyitva in_progress-be, QA FAIL', atSend)
    expect(msg).toContain(CARD_STATE_MARKER)

    const note = formatDeliveryStalenessNote(msg, live, 153 * 60)
    expect(note).toContain(CARD_STATE_DELIVERY_MARKER)
    expect(note).toContain('956fdaf5: in_progress -> done')
    expect(note).toContain('153 percet')
  })

  it('CONTROL: a card still in the column it was stamped in produces NO note', () => {
    const atSend = { '12f80902': { id: '12f80902', status: 'in_progress', updatedAt: 1787399000 } }
    const msg = stampedFor('12f80902 leirast javitottam', atSend)
    expect(formatDeliveryStalenessNote(msg, live, 166 * 60)).toBe('')
  })

  it('updated_at churn alone is NOT staleness -- otherwise every healthy dispatch trips it', () => {
    // MikroB moves a card, then dispatches: updated_at differs by seconds, the column does not.
    const atSend = { '12f80902': { id: '12f80902', status: 'in_progress', updatedAt: 1 } }
    const msg = stampedFor('12f80902 vidd', atSend)
    expect(formatDeliveryStalenessNote(msg, live, 30)).toBe('')
  })

  it('a message with no send-time stamp is left alone', () => {
    expect(formatDeliveryStalenessNote('956fdaf5 nezd meg', live, 9999)).toBe('')
    expect(formatDeliveryStalenessNote('', live, 9999)).toBe('')
  })

  it('reports only the cards that moved, when a message stamped several', () => {
    const atSend = {
      '956fdaf5': { id: '956fdaf5', status: 'in_progress', updatedAt: 1 },
      '12f80902': { id: '12f80902', status: 'in_progress', updatedAt: 1 },
    }
    const msg = stampedFor('956fdaf5 es 12f80902 is nalad van', atSend)
    const note = formatDeliveryStalenessNote(msg, live, 600)
    expect(note).toContain('956fdaf5: in_progress -> done')
    expect(note).not.toContain('12f80902')
  })

  it('an unknown card (deleted/archived since) counts as unchanged, never as a crash', () => {
    const atSend = { 'aaaaaaaa': { id: 'aaaaaaaa', status: 'in_progress', updatedAt: 1 } }
    const msg = stampedFor('aaaaaaaa vidd', atSend)
    expect(formatDeliveryStalenessNote(msg, live, 600)).toBe('')
  })

  it('a throwing lookup must not cost the delivery', () => {
    const atSend = { '956fdaf5': { id: '956fdaf5', status: 'in_progress', updatedAt: 1 } }
    const msg = stampedFor('956fdaf5 vidd', atSend)
    const boom = (): CardStateSnapshot | null => {
      throw new Error('db down')
    }
    expect(formatDeliveryStalenessNote(msg, boom, 600)).toBe('')
  })

  it('the two markers are distinct, so a delivery note never reads as a send-time stamp', () => {
    // appendCardStateStamp uses CARD_STATE_MARKER as its own idempotency check; if the delivery
    // marker collided with it, a re-sent message would silently lose its stamp.
    expect(CARD_STATE_DELIVERY_MARKER).not.toBe(CARD_STATE_MARKER)
    expect(CARD_STATE_DELIVERY_MARKER.includes(CARD_STATE_MARKER)).toBe(false)
    expect(CARD_STATE_MARKER.includes(CARD_STATE_DELIVERY_MARKER)).toBe(false)
  })

  it('a card id in the BODY is not a stamped card -- only the stamp block is compared', () => {
    // The body names 956fdaf5 (now done) but the stamp block only covers 12f80902 (unchanged).
    const atSend = { '12f80902': { id: '12f80902', status: 'in_progress', updatedAt: 1 } }
    const msg = stampedFor('12f80902 vidd; a 956fdaf5 mar lezarult, csak kontextus', atSend)
    expect(msg).toContain('12f80902 status=in_progress')
    expect(msg).not.toContain('956fdaf5 status=')
    expect(formatDeliveryStalenessNote(msg, live, 600)).toBe('')
  })
})

// A pure function nobody calls is a decoration. There are exactly TWO delivery paths -- the router's
// tmux push for sub-agents and the main agent's drain-inbox pull -- and the wrap module's own header
// warns that anything landing in only one of them is a drift bug. These assert BOTH call the
// re-check AND concatenate its result into the text that is actually delivered; a call whose return
// value is dropped would satisfy a bare grep for the function name.
describe('supersededDispatch (card 790c962d)', () => {
  const board = (status: string): CardStateLookup => (id) => ({ id, status, updatedAt: 1 })
  const DISPATCH = '[Kanban feladat #4a3c75a5]: [marveen][INFRA][NORMAL] 3 vendorolt skill-fajl\n\nmove it'

  it('reproduces the incident: a dispatch for a card that is already done', () => {
    // backend's queue held 10 dispatches; 7 were obsolete on arrival, 5 of them exactly like this --
    // the agent had already finished the card off the board (fleet rule 11), so the message informed
    // it of nothing while still costing a turn to read and another to say "this is stale".
    expect(supersededDispatch(DISPATCH, board('done'))).toEqual({ id: '4a3c75a5', status: 'done' })
  })

  it('waiting counts too -- the work is BUILT and in a gate', () => {
    expect(supersededDispatch(DISPATCH, board('waiting'))).toEqual({ id: '4a3c75a5', status: 'waiting' })
  })

  it('CONTROL: in_progress is NOT superseded -- a gate FAIL reopens a card and the dispatch lives', () => {
    expect(supersededDispatch(DISPATCH, board('in_progress'))).toBeNull()
  })

  it('CONTROL: planned is NOT superseded -- a card moved back may genuinely need picking up', () => {
    expect(supersededDispatch(DISPATCH, board('planned'))).toBeNull()
  })

  it('a message that merely MENTIONS a dispatch header is never suppressed', () => {
    // The anchoring case, and the whole safety of this feature. Someone writing "the
    // [Kanban feladat #4a3c75a5] you sent is stale" must not have their message eaten. Same lesson
    // isUrgentMessage records for verdict words in a body.
    //
    // TWO cases, and the second is the one that matters. My first version only had the first: a
    // mention on a LATER line, which the "first non-empty line" rule already excludes -- so removing
    // the `^` anchor left that test GREEN. The mutation caught the gap. The anchor's real job is a
    // mention that sits mid-line on the FIRST line, where only `^` separates it from a dispatch.
    const laterLine = 'Errol irok:\nA [Kanban feladat #4a3c75a5] amit kuldtel mar nem aktualis.'
    expect(supersededDispatch(laterLine, board('done'))).toBeNull()
    const sameLine = 'Errol: a [Kanban feladat #4a3c75a5] amit kuldtel mar nem aktualis.'
    expect(supersededDispatch(sameLine, board('done')), 'mid-line on line 1 needs the ^').toBeNull()
  })

  it('an ordinary message is left alone', () => {
    expect(supersededDispatch('Vettem, koszi a jelzest.', board('done'))).toBeNull()
  })

  it('FAIL-OPEN: an unknown card is delivered, not dropped', () => {
    // Opposite posture to the gates elsewhere in this repo, on purpose: delivering a stale dispatch
    // costs one wasted turn, dropping a live one loses work nobody notices is missing.
    expect(supersededDispatch(DISPATCH, () => null)).toBeNull()
  })

  it('FAIL-OPEN: a throwing lookup must not eat the message', () => {
    expect(() =>
      supersededDispatch(DISPATCH, () => {
        throw new Error('db down')
      }),
    ).not.toThrow()
    expect(
      supersededDispatch(DISPATCH, () => {
        throw new Error('db down')
      }),
    ).toBeNull()
  })

  it('the header it matches is the one routes/kanban.ts actually produces', () => {
    // Non-vacuity against the real producer rather than against my idea of it: if the dispatch
    // template is ever reworded, this fails instead of the matcher silently going inert -- which is
    // exactly how a suppression can look shipped while never firing.
    const src = readFileSync(join(process.cwd(), 'src', 'web', 'routes', 'kanban.ts'), 'utf8')
    expect(src).toContain('`[Kanban feladat #${id}]:')
  })
})

describe('the superseded-dispatch drop is wired into the ROUTER path only (card 790c962d)', () => {
  const readSrc = (rel: string): string => readFileSync(join(process.cwd(), 'src', rel), 'utf8')

  it('the router drops the row instead of delivering it', () => {
    const src = readSrc('web/message-router.ts')
    expect(src).toContain('supersededDispatch(msg.content, getKanbanCardStateByIdPrefix)')
    expect(src).toContain('closeMessagesWithoutDelivery(')
  })

  it('and it runs BEFORE the readiness/session work, or it would not clear a backlog', () => {
    // Placement is the feature. Every check after it waits on the receiver's pane being free, and a
    // busy receiver is the whole problem -- suppressing later would clear the queue only at the rate
    // the agent drains it, which is the rate that built the queue.
    const src = readSrc('web/message-router.ts')
    expect(src.indexOf('supersededDispatch(')).toBeLessThan(src.indexOf('sendPromptToSession(session'))
  })

  it('drain-inbox deliberately does NOT drop -- recorded so it never reads as an oversight', () => {
    // The sibling control (formatDeliveryStalenessNote) IS in both paths, and the test above says why.
    // This one is router-only for two measured reasons, and the decision is pinned here rather than
    // left to look like a forgotten half:
    //   1. drain-inbox serves the MAIN agent only, whose queue does not go stale -- measured over 6
    //      hours, 118 messages at 0.1 min average wait, 0.7 min worst case. There is nothing to drop.
    //   2. It calls claimPendingForAgent FIRST, which flips the row to 'delivered' before the loop.
    //      Suppressing after that would be a row marked delivered that the agent never saw -- the
    //      exact "invisible message loss" shape the file's own from_agent branch warns about.
    const src = readSrc('web/routes/agents.ts')
    expect(src).not.toContain('supersededDispatch(')
    expect(src, 'the claim-before-frame ordering is the reason').toContain('claimPendingForAgent(name, INBOX_DRAIN_CAP)')
  })
})

describe('the delivery-time re-check is wired into BOTH delivery paths', () => {
  const readSrc = (rel: string): string => readFileSync(join(process.cwd(), 'src', rel), 'utf8')

  it('the router appends it to the injected prompt', () => {
    const src = readSrc('web/message-router.ts')
    expect(src).toContain('formatDeliveryStalenessNote(')
    expect(src).toContain('sendPromptToSession(session, prefix + wrapped + staleNote, host)')
  })

  it('drain-inbox appends it to the block it returns', () => {
    const src = readSrc('web/routes/agents.ts')
    expect(src).toContain('formatDeliveryStalenessNote(')
    expect(src).toContain('blocks.push(prefix + wrapped + staleNote)')
  })

  it('both paths append AFTER the wrapper, never inside the sender-attributed payload', () => {
    // The note is the router's own text. Inside the wrapper it would read as part of what the
    // sender wrote -- and for an untrusted sender that is precisely the framing the wrap module
    // exists to keep straight.
    for (const rel of ['web/message-router.ts', 'web/routes/agents.ts']) {
      expect(readSrc(rel)).toContain('wrapped + staleNote')
    }
  })
})
