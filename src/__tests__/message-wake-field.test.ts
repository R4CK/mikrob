// Card 3bd457ed (parent dc35fa1a, grandparent ee2d6220): the `wake` field.
//
// WHAT THE FIELD IS. Every inter-agent message in this fleet interrupts its
// receiver. The router softens that (main-agent wakeup cooldown, busy-pane
// deferral), but there is no MESSAGE-LEVEL class: a sender cannot say "this is
// for your next natural check, do not start a turn for it". Measured over 7
// days: 3388 messages, 472 of them automated, and 464 of those 472 addressed to
// the main agent -- with literally repeating lines (a session-stuck not-ready
// notice 13x, 10x, 9x; a BUSY notice 7x).
//
// WHAT THIS STEP SHIPS, AND WHAT IT DELIBERATELY DOES NOT. Step 1 is the field
// plus the two deciders that must honour it (their behaviour is pinned in
// message-wake-deciders.test.ts). It does NOT open the field on the HTTP
// endpoint: the allowlist that says which message classes may ask for
// wake:false is card 7d47ca16, and shipping a free-form wake:false over
// /api/messages before that allowlist exists would give any token holder a
// window in which to silence any class -- including a failure or a security
// notice. The last test in this file pins that gap so the next step cannot
// quietly assume it was already closed.
import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_MESSAGES_DDL, AGENT_MESSAGES_ALTER_COLUMNS } from '../schema/agent-messages-ddl.js'
import { messageWakesReceiver } from '../web/message-wake.js'
import { initDatabase, createAgentMessage, getPendingMessages, getDb } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Source with line comments stripped: a symbol or call named only in a comment
 *  satisfies a naive presence check (cards 06d36307, 2f0c7d24). */
function codeOf(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

describe('the wake column migrates without changing a single existing row', () => {
  it('backfills 1 into rows written BEFORE the column existed', () => {
    const db = new Database(':memory:')
    // Build the table as it stood before this card: the base DDL plus every
    // ALTER except the last one (the wake column).
    for (const stmt of AGENT_MESSAGES_DDL) db.exec(stmt)
    for (const stmt of AGENT_MESSAGES_ALTER_COLUMNS.slice(0, -1)) db.exec(stmt)
    db.prepare(
      "INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES ('a','b','old row','pending', 1)",
    ).run()

    // Now migrate.
    db.exec(AGENT_MESSAGES_ALTER_COLUMNS[AGENT_MESSAGES_ALTER_COLUMNS.length - 1]!)

    const row = db.prepare('SELECT wake FROM agent_messages').get() as { wake: number }
    // NOT NULL DEFAULT 1: the pre-existing row reads back as a waking message,
    // not as NULL. Nothing downstream has to guess what a NULL would mean.
    expect(row.wake).toBe(1)
  })

  it('a writer that does not know the column still writes a WAKING row -- the rollback direction', () => {
    // This is the "reverting the code is safe" evidence (code-quality rule 11):
    // the column stays behind, and an INSERT from the old code path -- which
    // names neither the column nor a value -- still produces exactly today's
    // behaviour rather than a row nobody wakes for.
    const db = new Database(':memory:')
    for (const stmt of AGENT_MESSAGES_DDL) db.exec(stmt)
    for (const stmt of AGENT_MESSAGES_ALTER_COLUMNS) db.exec(stmt)
    db.prepare(
      "INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, origin_note, trace_id, span_id, parent_span_id) VALUES ('a','b','old code','pending', 1, NULL, NULL, NULL, NULL)",
    ).run()
    const row = db.prepare('SELECT wake FROM agent_messages').get() as { wake: number }
    expect(row.wake).toBe(1)
  })
})

describe('messageWakesReceiver -- the single predicate both deciders use', () => {
  it('only an explicit 0 suppresses; everything else wakes', () => {
    expect(messageWakesReceiver({ wake: 0 })).toBe(false)
    expect(messageWakesReceiver({ wake: 1 })).toBe(true)
    // Fail-OPEN, deliberately: a row read from an unmigrated database, or any
    // value nobody anticipated, wakes. A wrongly-woken receiver loses one
    // interruption; a wrongly-silenced failure notice is invisible until
    // someone happens to look.
    expect(messageWakesReceiver({ wake: undefined as unknown as number })).toBe(true)
    expect(messageWakesReceiver({ wake: null as unknown as number })).toBe(true)
  })

  it('is the predicate ACTUALLY used at both decision sites, not just exported', () => {
    // Matched on comment-stripped source. The watcher matters most: it is the
    // path that spends a paid autonomous turn, so a hardening that lived only
    // in the router would sit in the fallback and not in the primary.
    expect(codeOf('web/message-router.ts')).toContain('messageWakesReceiver(msg)')
    expect(codeOf('web/inbox-nudge-watcher.ts')).toContain('pending.filter(messageWakesReceiver)')
  })
})

describe('createAgentMessage stores what actually happened', () => {
  beforeAll(() => {
    process.env['NODE_ENV'] = 'test'
    initDatabase(':memory:')
  })

  function wakeOf(id: number): number {
    return (getDb().prepare('SELECT wake FROM agent_messages WHERE id = ?').get(id) as { wake: number }).wake
  }

  it("defaults to waking -- today's behaviour is bit-identical for every existing caller", () => {
    const noOpts = createAgentMessage('backend', MAIN_AGENT_ID, 'no opts at all')
    expect(noOpts.wake).toBe(1)
    expect(wakeOf(noOpts.id)).toBe(1)

    const explicitTrue = createAgentMessage('backend', MAIN_AGENT_ID, 'wake true', null, null, { wake: true })
    expect(wakeOf(explicitTrue.id)).toBe(1)

    const emptyOpts = createAgentMessage('backend', MAIN_AGENT_ID, 'empty opts', null, null, {})
    expect(wakeOf(emptyOpts.id)).toBe(1)
  })

  it('honours wake:false for the main agent', () => {
    const quiet = createAgentMessage('backend', MAIN_AGENT_ID, 'quiet notice', null, null, { wake: false })
    expect(quiet.wake).toBe(0)
    expect(wakeOf(quiet.id)).toBe(0)
  })

  it('the wake:false row is STILL in the queue -- suppression is not deletion', () => {
    const quiet = createAgentMessage('backend', MAIN_AGENT_ID, 'still queued', null, null, { wake: false })
    const pending = getPendingMessages(MAIN_AGENT_ID)
    expect(pending.map((m) => m.id)).toContain(quiet.id)
  })

  it('COERCES wake:false back to a wake for a sub-agent, because a sub-agent has no next natural check', () => {
    // drain-inbox is main-agent only (the route refuses anyone else by design),
    // so a sub-agent's delivery IS the router's tmux inject. A wake:false row
    // addressed to one would not wait quietly -- it would sit pending until the
    // 60-minute abandon window marked it FAILED. That is the message
    // disappearing, which is exactly what this field must never do.
    const toSub = createAgentMessage('mikrob', 'backend', 'to a sub-agent', null, null, { wake: false })
    expect(toSub.wake).toBe(1)
    expect(wakeOf(toSub.id)).toBe(1)
  })

  it('a coerced row does not LIE: the returned object and the stored row agree', () => {
    // The failure this pins is a suppression the queue reports but never
    // performed -- an operator reading the row would conclude the message was
    // deliberately silenced when it was in fact delivered normally.
    const toSub = createAgentMessage('mikrob', 'qa', 'coerced', null, null, { wake: false })
    expect(toSub.wake).toBe(wakeOf(toSub.id))
  })
})

describe('the HTTP endpoint does NOT accept wake yet (card 7d47ca16 opens it)', () => {
  it('POST /api/messages passes no wake option through to createAgentMessage', () => {
    // Structural, on comment-stripped source: the handler builds its
    // createAgentMessage call from exactly four arguments, so a `wake` key in
    // the request body is inert. When 7d47ca16 opens the field behind its
    // allowlist, this test fails and has to be rewritten -- which is the point.
    // A silently-ignored body field is otherwise indistinguishable from a
    // working one, and step 1 shipping a no-op is precisely the outcome that
    // would go unnoticed.
    const src = codeOf('web/routes/messages.ts')
    expect(src).toContain('createAgentMessage(from.trim(), storedTo, stampedContent, trimmedOriginNote)')
    expect(src).not.toMatch(/wake\s*:/)
  })
})
