// Card 7d47ca16 (parent dc35fa1a): which message classes may ask for a quiet
// delivery, and what happens to everything else.
//
// The shape MikroB asked for (comment 21447) is a STATIC list in source, so the
// gate compares a STRING it can read here rather than judging a caller's
// behaviour. These tests hold that shape in place from both directions: the list
// must not grow to include a class whose own name says it reports a failure, and
// a class that is not on the list must not be able to buy silence by asking.
import { describe, it, expect, beforeAll } from 'vitest'
import { QUIET_MESSAGE_CLASSES, isQuietMessageClass } from '../web/message-wake.js'
import { initDatabase, createAgentMessage, getDb } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'

describe('QUIET_MESSAGE_CLASSES: what may be on the list', () => {
  it('holds exactly the two measured repeat classes', () => {
    // Enumerated on purpose. Growing the list has to edit this line too, so the
    // growth shows up in a diff a gate reads, which is the whole reason the list
    // is code and not configuration.
    expect([...QUIET_MESSAGE_CLASSES]).toEqual([
      'session-stuck-not-ready-repeat',
      'session-stuck-busy-repeat',
    ])
  })

  it('refuses a class whose NAME says it reports a failure, a security event, a quota event or a decision', () => {
    // The card's requirement: adding such a class must fail. This can only be
    // enforced by NAME -- the list is strings, and a string carries no proof of
    // what it is attached to. So this catches `agent-failure-alert` and misses a
    // class called `class-17`, and that limit is written down in DECISIONS.md
    // rather than hidden behind a test that looks stronger than it is. It is
    // still worth having: the plausible mistake is someone naming the class
    // honestly and adding it anyway.
    const forbidden = /fail|error|crash|security|exploit|breach|quota|limit|denied|blocked|approve|decision|dontes|hiba|urgent|alert|kritikus|critical/i
    for (const cls of QUIET_MESSAGE_CLASSES) {
      expect(cls, `${cls} names a class that must always wake its receiver`).not.toMatch(forbidden)
    }
  })

  it('the matcher fires on the exact string, never on a near miss', () => {
    // Exact membership, not substring: a class that merely CONTAINS a listed
    // name is a different class, and treating it as listed is how an allowlist
    // stops being one.
    expect(isQuietMessageClass('session-stuck-busy-repeat')).toBe(true)
    expect(isQuietMessageClass('session-stuck-busy-repeat-failure')).toBe(false)
    expect(isQuietMessageClass('x-session-stuck-busy-repeat')).toBe(false)
    expect(isQuietMessageClass('Session-Stuck-Busy-Repeat')).toBe(false)
    expect(isQuietMessageClass(' session-stuck-busy-repeat')).toBe(false)
    expect(isQuietMessageClass('session-stuck-busy-repeat ')).toBe(false)
  })

  it('says no to anything that is not a listed string at all', () => {
    expect(isQuietMessageClass(undefined)).toBe(false)
    expect(isQuietMessageClass(null)).toBe(false)
    expect(isQuietMessageClass('')).toBe(false)
    expect(isQuietMessageClass(0)).toBe(false)
    expect(isQuietMessageClass(true)).toBe(false)
    expect(isQuietMessageClass(['session-stuck-busy-repeat'])).toBe(false)
    expect(isQuietMessageClass({ toString: () => 'session-stuck-busy-repeat' })).toBe(false)
  })

  it('cannot be grown at runtime', () => {
    // "There is no runtime path that adds to it" is a claim, so it is frozen and
    // the claim is checked. Without this, a list that reads like an allowlist is
    // one `push` away from being a suggestion.
    expect(Object.isFrozen(QUIET_MESSAGE_CLASSES)).toBe(true)
    const before = [...QUIET_MESSAGE_CLASSES]
    try {
      ;(QUIET_MESSAGE_CLASSES as unknown as string[]).push('anything-at-all')
    } catch {
      // Frozen arrays throw in strict mode (ES modules are strict); either way
      // the assertion below is what decides.
    }
    expect([...QUIET_MESSAGE_CLASSES]).toEqual(before)
  })
})

describe('createAgentMessage: the class decides, and the default is to wake', () => {
  beforeAll(() => {
    process.env['NODE_ENV'] = 'test'
    initDatabase(':memory:')
  })

  function wakeOf(id: number): number {
    return (getDb().prepare('SELECT wake FROM agent_messages WHERE id = ?').get(id) as { wake: number }).wake
  }

  it('a listed class delivers quietly to the main agent', () => {
    const msg = createAgentMessage('system', MAIN_AGENT_ID, 'repeat notice', null, null, {
      quietClass: 'session-stuck-busy-repeat',
    })
    expect(msg.wake).toBe(0)
    expect(wakeOf(msg.id)).toBe(0)
  })

  it('an UNLISTED class is fail-closed towards waking, not towards silence', () => {
    // The card's second requirement. Note which way "fail-closed" runs here: the
    // dangerous outcome is a message that stays silent, so refusing to honour a
    // request means WAKING. A gate that refused by suppressing would be fail-open
    // on the axis that costs something.
    const msg = createAgentMessage('system', MAIN_AGENT_ID, 'unknown class', null, null, {
      quietClass: 'agent-failure-alert',
    })
    expect(msg.wake).toBe(1)
    expect(wakeOf(msg.id)).toBe(1)
  })

  it('a near miss of a listed class also wakes', () => {
    const msg = createAgentMessage('system', MAIN_AGENT_ID, 'near miss', null, null, {
      quietClass: 'session-stuck-busy-repeat-2',
    })
    expect(wakeOf(msg.id)).toBe(1)
  })

  it('the returned object agrees with the stored row on a refusal', () => {
    // Same rule as the sub-agent coercion in message-wake-field.test.ts: the row
    // must never report a suppression that did not happen.
    const msg = createAgentMessage('system', MAIN_AGENT_ID, 'refused', null, null, {
      quietClass: 'not-a-class',
    })
    expect(msg.wake).toBe(wakeOf(msg.id))
    expect(msg.wake).toBe(1)
  })

  it('a listed class still cannot silence a message to a sub-agent', () => {
    // The main-agent-only coercion from step 1 is not weakened by the allowlist:
    // a sub-agent has no next natural check, so a quiet row addressed to one
    // would expire rather than wait.
    const msg = createAgentMessage('system', 'backend', 'to a sub-agent', null, null, {
      quietClass: 'session-stuck-busy-repeat',
    })
    expect(msg.wake).toBe(1)
    expect(wakeOf(msg.id)).toBe(1)
  })
})
