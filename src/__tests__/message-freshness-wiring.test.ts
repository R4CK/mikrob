// Both delivery paths must pass the freshness signal (card f27c999b, B-wave 4/6).
//
// Upstream ships message-freshness-suffix.test.ts, adopted here unchanged -- but it covers the PURE
// function: given an age and a newer-count, what string comes out. It says nothing about whether
// anything actually calls it with real numbers.
//
// That gap matters in this fork specifically, because there are TWO near-identical delivery paths:
// message-router.ts (sub-agents, via tmux) and routes/agents.ts (the main agent's inbox drain).
// routes/agents.ts already carries a comment saying exactly this about the sibling board-re-check
// control -- "a control that lands in only one of two near-identical delivery paths is the classic
// way a fix reads as shipped while half the traffic never sees it". This file makes that mechanical
// for the freshness signal rather than leaving it to whoever edits next.
//
// Kept in a SEPARATE file from the adopted upstream one on purpose: that file stays byte-identical
// to upstream, so it needs no entry in the conflict map and cannot drift into a merge decision.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..')

const DELIVERY_PATHS = [
  ['message-router.ts', join(SRC, 'web', 'message-router.ts')],
  ['routes/agents.ts', join(SRC, 'web', 'routes', 'agents.ts')],
] as const

describe('the freshness signal reaches BOTH delivery paths', () => {
  it.each(DELIVERY_PATHS)('%s computes the newer-message count from the database', (_label, path) => {
    const src = readFileSync(path, 'utf-8')
    expect(src).toContain('countNewerMessagesFromSameSender(msg.from_agent, msg.to_agent, msg.id)')
  })

  it.each(DELIVERY_PATHS)('%s passes freshness INTO the wrapper, not just computes it', (_label, path) => {
    // Computing the value and forgetting the argument is the failure this catches: it costs a query
    // per delivery and annotates nothing, and every test of the pure function stays green.
    const src = readFileSync(path, 'utf-8')
    expect(src).toMatch(/wrapAgentMessageForDelivery\([^)]*,\s*freshness\)/)
  })

  it.each(DELIVERY_PATHS)('%s still appends the fork\'s own board-re-check note as well', (_label, path) => {
    // The two signals answer different questions -- "has the sender said more since?" versus "did
    // the board move while this waited?" -- and adopting the upstream one must not quietly replace
    // the fork's. Verified as non-overlapping before adopting; this keeps them both.
    const src = readFileSync(path, 'utf-8')
    expect(src).toContain('formatDeliveryStalenessNote(')
  })
})
