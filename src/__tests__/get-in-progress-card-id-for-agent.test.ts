// getInProgressCardIdForAgent (card f5f78e13): the DB read the new-card-dispatch
// context-guard tier uses to detect "a different card was just dispatched".
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { initDatabase, createKanbanCard, deleteKanbanCard, moveKanbanCard, addKanbanComment, getInProgressCardIdForAgent } from '../db.js'
import { agentDir } from '../web/agent-config.js'
import { scaffoldAgentDir } from '../web/agent-scaffold.js'

const AGENT = 'ipctest-f5f78e13'
const OTHER = 'ipctest2-f5f78e13'

beforeEach(() => {
  initDatabase(':memory:')
  for (const name of [AGENT, OTHER]) {
    if (!existsSync(agentDir(name))) { mkdirSync(agentDir(name), { recursive: true }); scaffoldAgentDir(name) }
  }
})
afterEach(() => {
  for (const name of [AGENT, OTHER]) rmSync(agentDir(name), { recursive: true, force: true })
})

describe('getInProgressCardIdForAgent', () => {
  it('returns null when the agent holds no in_progress card', () => {
    expect(getInProgressCardIdForAgent(AGENT)).toBe(null)
  })

  it('returns the card id once it is in_progress, and null again once it leaves that status', () => {
    const id = 'ipc-card-a'
    try {
      createKanbanCard({ id, title: 't', status: 'planned', assignee: AGENT })
      expect(getInProgressCardIdForAgent(AGENT)).toBe(null)
      moveKanbanCard(id, 'in_progress', 0, AGENT, false, 'test')
      expect(getInProgressCardIdForAgent(AGENT)).toBe(id)
      moveKanbanCard(id, 'waiting', 0, AGENT, false, 'test')
      expect(getInProgressCardIdForAgent(AGENT)).toBe(null)
    } finally {
      deleteKanbanCard(id)
    }
  })

  it('never returns another agent\'s in_progress card', () => {
    const mine = 'ipc-card-mine'
    const theirs = 'ipc-card-theirs'
    try {
      createKanbanCard({ id: mine, title: 't', status: 'in_progress', assignee: AGENT })
      createKanbanCard({ id: theirs, title: 't', status: 'in_progress', assignee: OTHER })
      expect(getInProgressCardIdForAgent(AGENT)).toBe(mine)
      expect(getInProgressCardIdForAgent(OTHER)).toBe(theirs)
    } finally {
      deleteKanbanCard(mine)
      deleteKanbanCard(theirs)
    }
  })

  // CYBERSEC F1 (comment 31757): the OLD query ordered by updated_at, which a
  // comment on EITHER card advances -- so a bearer holder or automated tool
  // commenting on an agent's OTHER in_progress card flipped "the current
  // card" with no real dispatch having happened. Event-ordering must be
  // immune to that: only a real status transition may change the answer.
  it('a comment on an older in_progress card does not flip which one is "current"', () => {
    const older = 'ipc-card-older'
    const newer = 'ipc-card-newer'
    try {
      createKanbanCard({ id: older, title: 't', status: 'in_progress', assignee: AGENT })
      createKanbanCard({ id: newer, title: 't', status: 'in_progress', assignee: AGENT })
      expect(getInProgressCardIdForAgent(AGENT)).toBe(newer)
      // A comment (by anyone -- a gate verdict, an automated tool, the agent
      // itself) bumps the OLDER card's updated_at past the newer card's.
      addKanbanComment(older, 'cybersec', 'CYBERSEC GO on an unrelated finding')
      expect(getInProgressCardIdForAgent(AGENT)).toBe(newer)
    } finally {
      deleteKanbanCard(older)
      deleteKanbanCard(newer)
    }
  })
})
