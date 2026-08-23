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
import { selectFairBatch, isUrgentMessage, MAX_MESSAGES_PER_TICK } from '../web/message-router.js'
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

// ---------------------------------------------------------------------------
// Card f951ec53: the SECOND ordering bug in the same function. Backend reported
// (2026-08-22, msg 19164) that five fresh messages -- two gate FAIL verdicts and
// one urgent Cybersec security bug report -- sat pending for ~30 minutes while
// its pane received four OLDER dispatches about cards that had already been
// closed. Nothing was broken; the queue is strict FIFO, and every delivery costs
// the receiver a full turn, so worthless-but-older rows block urgent ones by
// construction. Delivery order now knows the difference.
// ---------------------------------------------------------------------------

function makeMsg(toAgent: string, id: number, ageSec: number, content: string): AgentMessage {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    id,
    from_agent: 'mikrob',
    to_agent: toAgent,
    content,
    status: 'pending' as const,
    result: null,
    created_at: nowSec - ageSec,
    delivered_at: null,
    completed_at: null,
    origin_note: null,
    trace_id: null,
    span_id: null,
    parent_span_id: null,
  }
}

describe('isUrgentMessage', () => {
  it('flags the marker vocabulary from the measured incident', () => {
    expect(isUrgentMessage('f951ec53 -- SURGOS, MikroB-fejlesztes')).toBe(true)
    expect(isUrgentMessage('SÜRGŐS biztonsagi bug-jelentes')).toBe(true)
    expect(isUrgentMessage('[URGENT] session wedged')).toBe(true)
    expect(isUrgentMessage('CRITICAL: token leak in the dashboard')).toBe(true)
    expect(isUrgentMessage('KRITIKUS hiba a landolasban')).toBe(true)
    expect(isUrgentMessage('QA FAIL a 3f21 kartyan, itt a repro')).toBe(true)
    expect(isUrgentMessage('CYBERSEC NO-GO -- exploit csatolva')).toBe(true)
    expect(isUrgentMessage('Cybered NO GO on the auth path')).toBe(true)
  })

  it('leaves an ordinary dispatch alone', () => {
    expect(isUrgentMessage('af580149 -- skill-drift, olvasd ujra a kartyat')).toBe(false)
    expect(isUrgentMessage('')).toBe(false)
    expect(isUrgentMessage('   \n\n  ')).toBe(false)
  })

  it('does NOT promote lowercase prose -- otherwise nearly everything is urgent, which is the same as nothing', () => {
    expect(isUrgentMessage('this is urgent, but it can wait until tomorrow')).toBe(false)
    expect(isUrgentMessage('the build failed again, no-go for now')).toBe(false)
  })

  it('only the FIRST non-empty line counts -- a body that MENTIONS a verdict is not a verdict', () => {
    // Same anchoring lesson card c4f2de32 recorded for gate verdicts on cards.
    expect(isUrgentMessage('routine status update\n\nthe QA FAIL from yesterday is already fixed')).toBe(false)
    // ...and a leading blank line must not hide a real marker.
    expect(isUrgentMessage('\n\nQA FAIL on the merge')).toBe(true)
  })

  it('a marker must stand alone as a word, accents included', () => {
    expect(isUrgentMessage('XSURGOSY telemetry batch')).toBe(false)
    expect(isUrgentMessage('MEGSÜRGŐSÍTETT batch')).toBe(false)
    expect(isUrgentMessage('FAILOVER completed cleanly')).toBe(false)
  })
})

describe('selectFairBatch urgency ordering (card f951ec53)', () => {
  it('reproduces the incident: without promotion the urgent rows sit behind four stale dispatches', () => {
    // Four older dispatches about already-closed cards, then the fresh urgent ones.
    const stale = [1, 2, 3, 4].map((i) => makeMsg('backend', i, 3600 - i, `kartya ${i} -- olvasd ujra`))
    const urgent = makeMsg('backend', 99, 60, 'CYBERSEC NO-GO -- exploit a magic-link pathon')
    const sorted = [...stale, urgent]

    // The old behaviour is exactly the bucket in creation order.
    expect(sorted.map((m) => m.id).indexOf(99)).toBe(4)

    const fair = selectFairBatch(sorted, MAX_MESSAGES_PER_TICK)
    expect(fair[0]?.id).toBe(99)
  })

  it('CONTROL: with no urgent message present the bucket stays strictly oldest-first', () => {
    const sorted = makePending('backend', 5, 1, 600)
    const fair = selectFairBatch(sorted, MAX_MESSAGES_PER_TICK)
    expect(fair.map((m) => m.id)).toEqual([1, 2, 3, 4, 5])
  })

  it('FIFO still holds INSIDE each class -- promotion reorders classes, not messages', () => {
    const sorted = [
      makeMsg('backend', 1, 900, 'regi dispatch'),
      makeMsg('backend', 2, 800, 'QA FAIL -- elso'),
      makeMsg('backend', 3, 700, 'masik regi dispatch'),
      makeMsg('backend', 4, 600, 'CYBERSEC NO-GO -- masodik'),
    ]
    const fair = selectFairBatch(sorted, MAX_MESSAGES_PER_TICK)
    expect(fair.map((m) => m.id)).toEqual([2, 4, 1, 3])
  })

  it('promotion is per-receiver only: it must not let one agent jump another agent\'s slot', () => {
    // The cross-receiver round-robin is a separate, earlier fix (a chronically
    // busy agent starving every other receiver). Urgency must not weaken it.
    const sorted = [
      ...makePending('fron-ted', 200, 1, 12000),
      makeMsg('backend', 10000, 60, 'QA FAIL -- friss'),
      makeMsg('cybersec', 10001, 60, 'rutin kerdes'),
    ]
    const fair = selectFairBatch(sorted, MAX_MESSAGES_PER_TICK)
    const agents = new Set(fair.map((m) => m.to_agent))
    expect(agents).toEqual(new Set(['fron-ted', 'backend', 'cybersec']))
    // Round-robin order is by first appearance in the input, unchanged.
    expect(fair.slice(0, 3).map((m) => m.to_agent)).toEqual(['fron-ted', 'backend', 'cybersec'])
  })

  it('an all-urgent bucket is still delivered oldest-first (no reordering to do)', () => {
    const sorted = [
      makeMsg('backend', 1, 900, 'QA FAIL -- a'),
      makeMsg('backend', 2, 800, 'QA FAIL -- b'),
      makeMsg('backend', 3, 700, 'QA FAIL -- c'),
    ]
    expect(selectFairBatch(sorted, MAX_MESSAGES_PER_TICK).map((m) => m.id)).toEqual([1, 2, 3])
  })
})
