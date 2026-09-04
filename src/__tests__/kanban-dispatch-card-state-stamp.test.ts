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
import { appendCardStateStamp, CARD_STATE_MARKER } from '../web/kanban-state-stamp.js'

const ROUTE = readFileSync(join(import.meta.dirname, '..', 'web', 'routes', 'kanban.ts'), 'utf-8')

/** Source with comment lines removed: a rationale that names a function must not satisfy a wiring
 *  assertion about calling it. */
const CODE = ROUTE.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

describe('the auto-dispatch message is stamped like every other message (card 382dcb15)', () => {
  it('fireKanbanDispatch sends through appendCardStateStamp, not raw content', () => {
    expect(CODE.length).toBeLessThan(ROUTE.length) // the comment stripping actually stripped
    expect(CODE).toContain('createAgentMessage(MAIN_AGENT_ID, target, appendCardStateStamp(content, getKanbanCardStateByIdPrefix))')
  })

  it('the stamp helper is imported, so the call is not a stray reference', () => {
    expect(ROUTE).toMatch(/import \{[^}]*\bappendCardStateStamp\b[^}]*\} from '\.\.\/kanban-state-stamp\.js'/)
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
