// Card 7560bb6a: the nudger wrote straight into a tmux pane from a cron process.
//
// The dashboard's pane mutex (session-send-lock.ts) is IN-PROCESS, so it could never reach a
// separate cron process. Worse than a narrow race: the old line sent the text and the Enter as two
// calls with a `sleep 1` between them, leaving a full second in which the dashboard's chunked
// writer could interleave into the same pane. It happened -- a self-advance reminder from this
// script spliced itself into the MIDDLE of inter-agent message 8701, and foreign text inside a
// trusted-sender frame is a prompt-injection surface.
//
// The fix routes delivery through /api/messages, which is already serialised
// (message-router -> sendPromptToSession -> withSessionSendLock). These tests exist because the
// obvious "fix" for a future nudge problem is to write to the pane again -- it is one line, it
// looks direct, and it silently reopens the hole. Asserted against the script text: there is no
// unit to import, and the property IS textual.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'store',
  'fleet-nudger.sh',
)
const src = readFileSync(SCRIPT, 'utf-8')
/** Lines that actually run, so a mention inside the explanatory comment does not count as a write. */
const code = src
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n')

describe('fleet-nudger never writes into a pane directly (card 7560bb6a)', () => {
  it('sends no keystrokes to any tmux pane', () => {
    // The exact regression: this is the line that spliced into message 8701.
    expect(code, 'the nudger is writing into a pane again -- an in-process lock cannot reach a cron process').not.toMatch(
      /tmux[^\n]*send[-\s]keys/,
    )
  })

  it('has no sleep between a text write and an Enter -- the one-second interleave window', () => {
    expect(code).not.toMatch(/send[-\s]keys[^\n]*;\s*sleep/)
  })

  it('delivers through the messages API instead', () => {
    // Positive half: without it, deleting the nudge body entirely would pass the two checks above.
    expect(code).toContain('/api/messages')
    expect(code).toMatch(/-X POST/)
  })

  it('still reads the pane to skip a busy agent -- a read cannot corrupt anything', () => {
    // Pinned so the cleanup does not also throw away the idle pre-filter, which is why the nudger
    // does not spam working agents.
    expect(code).toMatch(/capture-pane/)
    expect(code).toContain('esc to interrupt')
  })

  it('says in the message text that it is automated', () => {
    // It is sent as `mikrob` so the framing is trusted-peer rather than untrusted -- an
    // untrusted-framed nudge is data the agent is told NOT to act on. That borrows MikroB's
    // authority, so the text must not let a reader think MikroB looked at their card.
    expect(src).toMatch(/fleet-nudger, automatikus/)
  })

  it('never puts the bearer token in argv', () => {
    // The pre-existing property (card edb7559f): /proc/<pid>/cmdline is world-readable. The new
    // curl call must keep using the 0600 header file.
    expect(code).not.toMatch(/-H\s+['"]?Authorization:/)
    expect(code).toMatch(/-H @"\$hdr_file"/)
  })
})
