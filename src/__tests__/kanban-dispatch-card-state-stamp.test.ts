// The AUTO-dispatch message must carry the send-time card-state stamp (card 382dcb15).
//
// THE MEASURED DEFECT, and it is the inverse of what the card's title assumed. The stamp is applied
// in POST /api/messages, so every message that goes through the HTTP route gets it -- including
// hand-written ones. fireKanbanDispatch does NOT go through that route: it calls createAgentMessage
// directly, in-process, because it runs inside the card-move request. So the ONE message class that
// always names a card -- the auto-dispatch -- was the only one arriving with no card-state at all.
//
// Measured on the incident that opened the card: message 22192, "[Kanban feladat #fe06da0c]",
// mikrob -> backend, 19555 seconds (5.4 hours) in the queue, and no [card-state @send] block.
// Hand-written messages from the same sender in the same window DO carry one.
//
// It is not cosmetic: the send stamp is the PRECONDITION for the delivery-time footer.
// formatDeliveryStalenessNote returns '' when the content carries no stamp, so an unstamped
// dispatch can never tell its recipient that the card moved while it waited -- which is exactly the
// failure this card is about.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendCardStateStamp, appendCardStateStampForDispatch, CARD_STATE_MARKER, type CardStateLookup } from '../web/kanban-state-stamp.js'

const ROUTE = readFileSync(join(import.meta.dirname, '..', 'web', 'routes', 'kanban.ts'), 'utf-8')

/** Source with comment lines removed: a rationale that names a function must not satisfy a wiring
 *  assertion about calling it. */
const CODE = ROUTE.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

describe('the auto-dispatch message is stamped like every other message (card 382dcb15)', () => {
  it('fireKanbanDispatch sends through appendCardStateStamp, not raw content', () => {
    expect(CODE.length).toBeLessThan(ROUTE.length) // the comment stripping actually stripped
    expect(CODE).toContain('createAgentMessage(MAIN_AGENT_ID, target, appendCardStateStampForDispatch(content, getKanbanCardStateByIdPrefix))')
  })

  it('the stamp helper is imported, so the call is not a stray reference', () => {
    expect(ROUTE).toMatch(/import \{[^}]*\bappendCardStateStampForDispatch\b[^}]*\} from '\.\.\/kanban-state-stamp\.js'/)
  })

  it('the helper stamps a dispatch-shaped body -- the property, not just the call site', () => {
    // A real dispatch body names its card as `#<hex8>`; the lookup resolves it.
    const body = '[Kanban feladat #a1b2c3d4]: some title\n\ninstructions here'
    const out = appendCardStateStamp(body, (id) =>
      id === 'a1b2c3d4' ? { id, status: 'in_progress', updatedAt: 1788000000 } : null,
    )
    expect(out).toContain(CARD_STATE_MARKER)
    expect(out).toContain('a1b2c3d4 status=in_progress')
    expect(out.startsWith(body)).toBe(true) // appended, never rewriting the dispatch itself
  })

  it('a body naming no resolvable card is returned untouched -- a decoration never costs a message', () => {
    const body = 'no card here'
    expect(appendCardStateStamp(body, () => null)).toBe(body)
  })
})

// Card 382dcb15 round 2, Cybered F1 (BLOCKER). The send-time stamp's idempotency guard asks whether
// the CONTENT already contains the marker. On the auto-dispatch path the content is built from the
// card's own title and description, so a card whose description merely MENTIONS `[card-state @send]`
// answered yes and went out silently unstamped -- and because the delivery-time note takes the send
// stamp as its input, the miss was invisible twice over.
//
// The inputs below are the REAL descriptions of the two cards Cybered named, not invented lookalikes:
// 382dcb15 (this card, about the stamp) and 790c962d (the queue-latency card). That is the sharp edge
// of the defect -- the cards most likely to be dispatched while someone works on this feature were
// exactly the ones that would not be stamped.
const REAL_382dcb15 =
  '[Kanban feladat #382dcb15]: Kezi dispatch-uzenetek is kapjanak [card-state @delivery] lablecet\n\n' +
  'AZ AUTOMATA dispatch-uzenetek (POST /api/messages -> [card-state @send] lablec) csak a KULDES ' +
  'pillanatat mutatjak, nem a KEZBESITES pillanatat.\n' +
  'FELADAT: a message-router kuldesi/kezbesitesi utjaba (ahol a [card-state @send] mar bekotve van) ' +
  'tegyunk egy MASODIK, kezbesitesi-idoben ujra-lekerdezett kartyaallapot-lablecet.'
const REAL_790c962d =
  '[Kanban feladat #790c962d]: inter-agent uzenetsor kesleltetes\n\n' +
  'Backend tobbszor jelezte: a dispatch inter-agent uzenetek 30-97 percet allnak a sorban. ' +
  'A [card-state @send] lablec ezt nem oldja meg magatol.'

const lookupFor = (id: string, status: string): CardStateLookup =>
  (probe) => (probe === id ? { id, status, updatedAt: 1788000000 } : null)

describe('a card whose DESCRIPTION mentions the marker still gets stamped on dispatch (Cybered F1)', () => {
  it('382dcb15: the real description defeated the re-send guard -- the dispatch entry point ignores it', () => {
    const out = appendCardStateStampForDispatch(REAL_382dcb15, lookupFor('382dcb15', 'in_progress'))
    expect(out).not.toBe(REAL_382dcb15)
    expect(out).toContain('382dcb15 status=in_progress')
    // The real stamp is APPENDED; the description's own mentions are left exactly as written.
    expect(out.startsWith(REAL_382dcb15)).toBe(true)
  })

  it('790c962d: same defect, second real card', () => {
    const out = appendCardStateStampForDispatch(REAL_790c962d, lookupFor('790c962d', 'planned'))
    expect(out).toContain('790c962d status=planned')
  })

  it('RED-BEFORE: the POST-path helper still returns these bodies UNCHANGED', () => {
    // Not a bug in appendCardStateStamp -- for author-written text a present marker really does mean
    // a re-send. This pins WHY a second entry point exists: same input, deliberately opposite answer.
    // If this ever starts stamping, the re-send guard has been lost and double stamps are back.
    expect(appendCardStateStamp(REAL_382dcb15, lookupFor('382dcb15', 'in_progress'))).toBe(REAL_382dcb15)
    expect(appendCardStateStamp(REAL_790c962d, lookupFor('790c962d', 'planned'))).toBe(REAL_790c962d)
  })

  it('the dispatch path stamps ONCE even though the body mentions the marker twice', () => {
    const out = appendCardStateStampForDispatch(REAL_382dcb15, lookupFor('382dcb15', 'in_progress'))
    const realStamps = out.split('\n').filter((l) => l.startsWith(CARD_STATE_MARKER)).length
    expect(realStamps).toBe(1)
  })
})
