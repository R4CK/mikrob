// A card waiting on an unanswered REVIEW must not be pulled back into in_progress (card c4f2de32).
//
// The failure it prevents, seen three times in one afternoon: a card sits at waiting with a REVIEW
// comment and a commit behind it, something flips it to in_progress, and the next agent to read the
// board sees "in progress, not moving" and rebuilds work that already exists. Worse, the status was
// rewritten through updateKanbanCard, which wrote no audit row -- so kanban_card_events showed the
// moves OUT of in_progress and nothing moving it back in.
//
// A gate FAIL is the legitimate way back, and it always leaves a verdict comment -- which is exactly
// what tells the two cases apart.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createKanbanCard,
  getKanbanCard,
  addKanbanComment,
  moveKanbanCard,
  updateKanbanCard,
  latestKanbanSignal,
  getKanbanCardEvents,
} from '../db.js'

function seedWaitingCard(id = 'card-1'): void {
  createKanbanCard({ id, title: 'Some work', assignee: 'backend' })
  moveKanbanCard(id, 'in_progress', 0, 'backend')
  moveKanbanCard(id, 'waiting', 0, 'backend')
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('latestKanbanSignal', () => {
  it('reports the REVIEW when nothing has judged it yet', () => {
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész. Commit: abc1234.')
    expect(latestKanbanSignal('card-1')).toBe('review')
  })

  it('reports a verdict once a gate answers', () => {
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész. Commit: abc1234.')
    addKanbanComment('card-1', 'cybersec', 'CYBERSEC NO-GO -- the proof gate is bypassable.')
    expect(latestKanbanSignal('card-1')).toBe('verdict')
  })

  it('is none for a card nobody has commented on', () => {
    seedWaitingCard()
    expect(latestKanbanSignal('card-1')).toBe('none')
  })
})

describe('a waiting+REVIEW card is not re-opened', () => {
  it('moveKanbanCard refuses waiting -> in_progress and changes nothing', () => {
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész. Commit: abc1234.')
    expect(moveKanbanCard('card-1', 'in_progress', 0, 'someone')).toBe(false)
    expect(getKanbanCard('card-1')?.status).toBe('waiting')
  })

  it('updateKanbanCard refuses the same transition -- the path that had no guard at all', () => {
    // This is how it actually happened: a PUT carrying `status` rewrote the column directly.
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész. Commit: abc1234.')
    expect(updateKanbanCard('card-1', { status: 'in_progress' })).toBe(false)
    expect(getKanbanCard('card-1')?.status).toBe('waiting')
  })

  it('a gate FAIL re-opens it -- the legitimate way back', () => {
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész. Commit: abc1234.')
    addKanbanComment('card-1', 'cybersec', 'CYBERSEC NO-GO -- reproduced with a forged key.')
    expect(moveKanbanCard('card-1', 'in_progress', 0, 'mikrob')).toBe(true)
    expect(getKanbanCard('card-1')?.status).toBe('in_progress')
  })

  it('force overrides it for a deliberate human decision', () => {
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész.')
    expect(moveKanbanCard('card-1', 'in_progress', 0, 'peti', true)).toBe(true)
    expect(getKanbanCard('card-1')?.status).toBe('in_progress')
  })

  it('other transitions out of waiting are untouched (done, planned)', () => {
    // The guard is about re-opening reviewed work, not about freezing the card.
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész.')
    expect(moveKanbanCard('card-1', 'done', 0, 'mikrob')).toBe(true)
    expect(getKanbanCard('card-1')?.status).toBe('done')
  })

  it('a card that is NOT waiting can still enter in_progress', () => {
    // The guard only ever looks at waiting -> in_progress; a planned card is untouched even with a
    // stale REVIEW comment on it.
    createKanbanCard({ id: 'card-2', title: 'Fresh work', assignee: 'backend' })
    addKanbanComment('card-2', 'backend', 'REVIEW: leftover comment from an earlier round')
    expect(moveKanbanCard('card-2', 'in_progress', 0, 'mikrob')).toBe(true)
  })
})

describe('only a GATE agent can answer a REVIEW (card c4f2de32, Cybered)', () => {
  it("the orchestrator's tiering sentence is NOT a verdict", () => {
    // MikroB routinely writes "DONE csak QA PASS + Cybersec GO" while tiering a card. Counting that
    // as a verdict switched the guard off for exactly the cards it was written for -- the churn back.
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész. Commit: abc1234.')
    addKanbanComment('card-1', 'mikrob', 'GATE-TIER: DONE csak QA PASS + Cybersec GO.')
    expect(latestKanbanSignal('card-1')).toBe('review')
    expect(moveKanbanCard('card-1', 'in_progress', 0, 'mikrob')).toBe(false)
  })

  it('a real gate verdict still re-opens the card', () => {
    for (const author of ['qa', 'qa2', 'cybersec', 'cybered']) {
      initDatabase(':memory:')
      seedWaitingCard()
      addKanbanComment('card-1', 'backend', 'REVIEW: kész.')
      addKanbanComment('card-1', author, `${author.toUpperCase()} NO-GO -- reproduced.`)
      expect(latestKanbanSignal('card-1'), author).toBe('verdict')
      expect(moveKanbanCard('card-1', 'in_progress', 0, 'mikrob'), author).toBe(true)
    }
  })

  it("an author who is not a gate cannot clear the guard by writing PASS", () => {
    // Including the card's own author -- otherwise "REVIEW ... tests PASS" would self-clear.
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész.')
    addKanbanComment('card-1', 'fron-ted', 'A FE oldalon minden teszt PASS, mehet tovább.')
    expect(latestKanbanSignal('card-1')).toBe('review')
  })
})

describe('the guard cannot be talked out of (card c4f2de32, Cybersec NO-GO)', () => {
  it('a verdict MENTION mid-comment does not clear the review', () => {
    // "the paired card got its GO" is a progress note, not a judgement of THIS card.
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész. Commit: abc1234.')
    addKanbanComment('card-1', 'cybersec', 'A pár-kártya megkapta a GO-t, ezt még nézem.')
    expect(latestKanbanSignal('card-1')).toBe('review')
    expect(moveKanbanCard('card-1', 'in_progress', 0, 'mikrob')).toBe(false)
  })

  it('a LOCAL-LLM DRAFT comment is skipped -- 7B free text decides no control', () => {
    // The offload script posts these automatically; a phrase inside one must never open a guard
    // (same class as the 3307b428 draft-guard finding).
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész.')
    addKanbanComment('card-1', 'cybered', '[LOCAL-LLM DRAFT] CYBERED GO -- looks fine to me.')
    expect(latestKanbanSignal('card-1')).toBe('review')
    expect(moveKanbanCard('card-1', 'in_progress', 0, 'mikrob')).toBe(false)
  })

  it('comment VOLUME does not push the REVIEW out of sight', () => {
    // The old fixed 20-comment window meant a chatty card silently lost its own guard.
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész.')
    for (let i = 0; i < 25; i += 1) addKanbanComment('card-1', 'mikrob', `Napló ${i}: haladás.`)
    expect(latestKanbanSignal('card-1')).toBe('review')
    expect(moveKanbanCard('card-1', 'in_progress', 0, 'mikrob')).toBe(false)
  })

  it('an unclassifiable waiting card blocks too (fail-closed)', () => {
    // No REVIEW, no verdict: re-opening silently is exactly what this guard is for. `force` is the
    // deliberate way through, and it is recorded.
    seedWaitingCard()
    expect(latestKanbanSignal('card-1')).toBe('none')
    expect(moveKanbanCard('card-1', 'in_progress', 0, 'mikrob')).toBe(false)
    expect(moveKanbanCard('card-1', 'in_progress', 0, 'peti', true)).toBe(true)
  })

  it('a gate verdict AFTER the review still opens the way back, even with chatter in between', () => {
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész.')
    addKanbanComment('card-1', 'mikrob', 'GATE-TIER: DONE csak QA PASS + Cybersec GO.')
    addKanbanComment('card-1', 'cybersec', 'CYBERSEC NO-GO -- reprodukálva, részletek a kártyán.')
    for (let i = 0; i < 5; i += 1) addKanbanComment('card-1', 'mikrob', `Napló ${i}`)
    expect(latestKanbanSignal('card-1')).toBe('verdict')
    expect(moveKanbanCard('card-1', 'in_progress', 0, 'mikrob')).toBe(true)
  })

  it('a NEW review after a verdict blocks again (the cycle repeats cleanly)', () => {
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: első kör.')
    addKanbanComment('card-1', 'cybersec', 'CYBERSEC NO-GO -- javítsd.')
    expect(moveKanbanCard('card-1', 'in_progress', 0, 'mikrob')).toBe(true)
    moveKanbanCard('card-1', 'waiting', 0, 'backend')
    addKanbanComment('card-1', 'backend', 'REVIEW: javítva, második kör.')
    expect(moveKanbanCard('card-1', 'in_progress', 0, 'mikrob')).toBe(false)
  })
})

describe('a forced re-open is marked as such', () => {
  it('records forced=1 only for the transition the guard would have refused', () => {
    seedWaitingCard()
    addKanbanComment('card-1', 'backend', 'REVIEW: kész.')
    expect(moveKanbanCard('card-1', 'in_progress', 0, 'peti', true)).toBe(true)
    const last = getKanbanCardEvents('card-1').at(-1)
    expect(last?.to_status).toBe('in_progress')
    expect(last?.forced).toBe(1)
  })

  it('an ordinary move carrying force is NOT marked (force is not an override of anything)', () => {
    createKanbanCard({ id: 'card-5', title: 'Plain', assignee: 'backend' })
    expect(moveKanbanCard('card-5', 'in_progress', 0, 'mikrob', true)).toBe(true)
    expect(getKanbanCardEvents('card-5').at(-1)?.forced).toBe(0)
  })
})

describe('a status change through updateKanbanCard is audited', () => {
  it('records the transition, so a silent re-open is impossible to miss', () => {
    // Before this card, updateKanbanCard rewrote `status` with no event row -- which is why the
    // audit trail showed cards leaving in_progress and never entering it.
    createKanbanCard({ id: 'card-3', title: 'Audited', assignee: 'backend' })
    expect(updateKanbanCard('card-3', { status: 'in_progress' }, { actor: 'tester' })).toBe(true)
    const events = getKanbanCardEvents('card-3')
    expect(events.map((e) => `${e.from_status}->${e.to_status}`)).toContain('planned->in_progress')
    expect(events[events.length - 1]?.actor).toBe('tester')
  })

  it('does NOT record an event when only the title moves (the [NN%] marker case)', () => {
    createKanbanCard({ id: 'card-4', title: '[10%] Work', assignee: 'backend' })
    expect(updateKanbanCard('card-4', { title: '[60%] Work' })).toBe(true)
    expect(getKanbanCardEvents('card-4')).toHaveLength(0)
  })
})
