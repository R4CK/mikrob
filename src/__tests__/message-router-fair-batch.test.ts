// Regression test for the starvation bug found investigating a NEW symptom
// under the same MikroB report that opened card 4a406989: cybersec/cybered/
// qa/qa2/backend2 all had pending messages, their panes were genuinely empty
// and ready, yet the router logged NOTHING for them -- not even a "busy"
// retry -- while fron-ted (stuck mid-turn for 3+ hours) kept generating
// activity. Measured live: the oldest 25 pending messages, globally, were
// almost entirely fron-ted's own backlog. `localPending.slice(0, 25)` took
// that global-oldest-first prefix every tick, and since fron-ted's messages
// are never abandoned (the session EXISTS, just stays busy), the same ~24
// slots were re-selected forever -- every other agent's messages, however
// new, never even reached isSessionReadyForPrompt.

import { describe, it, expect } from 'vitest'
import { selectFairBatch, MAX_MESSAGES_PER_TICK } from '../web/message-router.js'
import type { AgentMessage } from '../db.js'

function makePending(toAgent: string, count: number, startId: number, startAgeSec: number): AgentMessage[] {
  const nowSec = Math.floor(Date.now() / 1000)
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    from_agent: 'mikrob',
    to_agent: toAgent,
    content: 'ping',
    status: 'pending' as const,
    result: null,
    created_at: nowSec - startAgeSec + i, // oldest first within the agent's own bucket
    delivered_at: null,
    completed_at: null,
    origin_note: null,
    trace_id: null,
    span_id: null,
    parent_span_id: null,
  }))
}

describe('selectFairBatch (starvation fix)', () => {
  it('reproduces the measured starvation on the OLD slice(0, cap) selection', () => {
    // The exact shape measured live: one chronically-busy agent's backlog
    // dwarfs everyone else's and sits at the front of global creation order.
    const sorted = [
      ...makePending('fron-ted', 200, 1, 12000), // oldest, dominates by count
      ...makePending('cybersec', 3, 10000, 600),
      ...makePending('cybered', 3, 10100, 600),
      ...makePending('qa', 3, 10200, 600),
    ].sort((a, b) => a.created_at - b.created_at)

    const naive = sorted.slice(0, MAX_MESSAGES_PER_TICK)
    const naiveAgents = new Set(naive.map((m) => m.to_agent))
    // This IS the bug: the naive prefix is fron-ted only, nothing else is
    // even represented in this tick's batch.
    expect(naiveAgents.size).toBe(1)
    expect(naiveAgents.has('fron-ted')).toBe(true)
  })

  it('every distinct receiver with a pending message is represented in one tick', () => {
    const sorted = [
      ...makePending('fron-ted', 200, 1, 12000),
      ...makePending('cybersec', 3, 10000, 600),
      ...makePending('cybered', 3, 10100, 600),
      ...makePending('qa', 3, 10200, 600),
      ...makePending('qa2', 3, 10300, 600),
      ...makePending('backend2', 1, 10400, 600),
    ].sort((a, b) => a.created_at - b.created_at)

    const fair = selectFairBatch(sorted, MAX_MESSAGES_PER_TICK)
    const agents = new Set(fair.map((m) => m.to_agent))

    expect(agents).toEqual(new Set(['fron-ted', 'cybersec', 'cybered', 'qa', 'qa2', 'backend2']))
    expect(fair.length).toBe(MAX_MESSAGES_PER_TICK)
  })

  it('within one agent, the oldest message is still picked first', () => {
    const sorted = [
      ...makePending('fron-ted', 200, 1, 12000),
      ...makePending('cybersec', 5, 10000, 600), // ids 10000..10004, oldest to newest
    ].sort((a, b) => a.created_at - b.created_at)

    const fair = selectFairBatch(sorted, MAX_MESSAGES_PER_TICK)
    const cybersecPicked = fair.filter((m) => m.to_agent === 'cybersec')
    expect(cybersecPicked[0]?.id).toBe(10000) // the OLDEST cybersec message, not a later one
  })

  it('a single agent with a small backlog under the cap gets ALL of it in one round', () => {
    const sorted = makePending('dex', 4, 1, 100)
    const fair = selectFairBatch(sorted, MAX_MESSAGES_PER_TICK)
    expect(fair.map((m) => m.id)).toEqual([1, 2, 3, 4])
  })

  it('never returns more than cap, even with a huge multi-agent backlog', () => {
    const sorted = [
      ...makePending('a', 100, 1, 1000),
      ...makePending('b', 100, 200, 1000),
      ...makePending('c', 100, 400, 1000),
    ].sort((a, b) => a.created_at - b.created_at)

    const fair = selectFairBatch(sorted, MAX_MESSAGES_PER_TICK)
    expect(fair.length).toBe(MAX_MESSAGES_PER_TICK)
  })

  it('an empty backlog returns an empty batch', () => {
    expect(selectFairBatch([], MAX_MESSAGES_PER_TICK)).toEqual([])
  })
})
