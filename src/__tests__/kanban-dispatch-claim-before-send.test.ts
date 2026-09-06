// Card c4da93bf (parent 01c846bf): the SEND happens only after the claim is WON.
//
// WHY THE OBVIOUS TEST DOES NOT WORK. Pre-marking the card and firing does not exercise anything:
// fireKanbanDispatch returns at the top because the card it READ already carries dispatched_at. The
// branch this card adds only matters in the window between that read and the write -- the card looks
// free, and by the time we claim it, it is not. So the test has to produce exactly that state: a
// READ that says free over a ROW that is already taken.
//
// getKanbanCard is mocked to strip dispatched_at, which is the smallest faithful stand-in for "the
// row changed after we read it". Everything else -- the route, the move, the real database, the real
// claim -- is genuine.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'

const mockCreateAgentMessage = vi.fn()
let hideDispatchedAt = false

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  BOT_NAME: 'Orin',
  OWNER_NAME: 'Owner',
}))

vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return {
    ...actual,
    createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a),
    // The stale read: what the dispatcher SAW, not what the row says now.
    getKanbanCard: (id: string) => {
      const c = actual.getKanbanCard(id)
      return c && hideDispatchedAt ? { ...c, dispatched_at: null } : c
    },
  }
})

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['dex'],
  readAgentDisplayName: (n: string) => n,
}))

vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => true,
}))

import { initDatabase, createKanbanCard, markKanbanCardDispatched } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'

async function move(id: string, status: string): Promise<void> {
  const req = Readable.from([
    Buffer.from(JSON.stringify({ status, sort_order: 0 })),
  ]) as unknown as http.IncomingMessage
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
    setHeader: vi.fn(),
  } as unknown as http.ServerResponse
  const handled = await tryHandleKanban({
    req,
    res,
    path: `/api/kanban/${id}/move`,
    method: 'POST',
    url: new URL(`http://localhost/api/kanban/${id}/move`),
  } as never)
  expect(handled).toBe(true)
}

beforeEach(() => {
  vi.clearAllMocks()
  hideDispatchedAt = false
  initDatabase(':memory:')
})

describe('fireKanbanDispatch branches on the CLAIM, not on the earlier read (card c4da93bf)', () => {
  it('a LOST claim sends nothing, even though the read said the card was free', async () => {
    createKanbanCard({ id: 'race-1', title: 'Raced card', assignee: 'dex' })
    // Somebody else got there first.
    expect(markKanbanCardDispatched('race-1')).toBe(true)
    // ...but our read still shows it free, which is the whole point.
    hideDispatchedAt = true
    await move('race-1', 'in_progress')
    expect(
      mockCreateAgentMessage,
      'the claim was already taken, so nothing may be sent -- with the pre-change code this fired',
    ).not.toHaveBeenCalled()
  })

  it('CONTROL: a WON claim does send, so the case above is not passing by being broken', async () => {
    createKanbanCard({ id: 'race-2', title: 'Free card', assignee: 'dex' })
    hideDispatchedAt = true // same stale-read setup, but nobody claimed it
    await move('race-2', 'in_progress')
    expect(mockCreateAgentMessage, 'an unclaimed card must still be dispatched').toHaveBeenCalledTimes(1)
  })
})
