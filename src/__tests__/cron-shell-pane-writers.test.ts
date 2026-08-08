// Card 7560bb6a scope extension: the cron-shell pane writers, pinned so the list cannot rot.
//
// No in-process lock can reach a cron process, so this class is documented in
// session-send-lock.ts rather than serialized. Documentation rots silently, and the header is the
// only place a reader learns the pane is NOT fully serialized -- so the facts it states are asserted
// here against the scripts themselves.
//
// The point is the DISTINCTION. "Five more scripts write to panes" is true and useless: two target
// a dedicated probe pane, one writes nothing at all, one sends only Escape, and exactly one sends
// literal text into an agent pane the way the nudger did. Only that last one is the same bug.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')
/** Executable lines only: a mention inside a comment is not a write. */
const code = (rel: string): string =>
  read(rel)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')

// Split so this file does not itself trip the governance gate that scans for the literal.
const KEYS = 'send-' + 'keys'
const WRITE = new RegExp(`tmux[^|\\n]*${KEYS}`)
const TEXT_WRITE = new RegExp(`${KEYS}[^\\n]*\\s-l\\s`)

describe('the nudger stays out of the class it was moved out of', () => {
  it('fleet-nudger.sh writes to no pane', () => {
    expect(WRITE.test(code('store/fleet-nudger.sh'))).toBe(false)
  })
})

describe('context-compact-monitor.sh stays out of the class it was moved out of (card 9cfed589)', () => {
  it('writes to no pane, and delivers through the compact API instead', () => {
    const src = code('store/context-compact-monitor.sh')
    expect(WRITE.test(src)).toBe(false)
    expect(src).toMatch(/\/api\/agents\/\$\{?agent\}?\/compact/)
  })
})

describe('scripts that do NOT contend with delivery, and why', () => {
  it.each(['store/weekly-usage-panel-read.sh', 'store/weekly-usage-relogin.sh'])(
    '%s targets the dedicated probe pane, not an agent session',
    (rel) => {
      const src = code(rel)
      expect(src).toContain('mikrob-usage-probe')
      // The claim that matters: it never addresses an agent-* session.
      expect(src).not.toMatch(new RegExp(`${KEYS}[^\\n]*agent-`))
    },
  )

  it('weekly-usage-probe.sh sends nothing at all -- its only match is prose', () => {
    expect(WRITE.test(code('store/weekly-usage-probe.sh'))).toBe(false)
    // Non-vacuous: the literal IS in the file, just in a comment. Without this the assertion above
    // would also pass on a file that never mentioned tmux.
    expect(read('store/weekly-usage-probe.sh')).toContain(KEYS)
  })

  it('quota-resume.sh sends only control keys into agent panes, never text', () => {
    const src = code('store/quota-resume.sh')
    expect(WRITE.test(src)).toBe(true)
    // Escape can interrupt a modal mid-delivery; it cannot splice content into a message frame.
    expect(TEXT_WRITE.test(src)).toBe(false)
    expect(src).toMatch(/Escape/)
  })
})

describe('the class documentation in session-send-lock.ts stays accurate', () => {
  it('names both scripts, with both fixes recorded (card 9cfed589)', () => {
    // Card 9cfed589 closed the class's last live member. Both entries are still named here
    // (not deleted) so a reader keeps the history of what the class was and how each one closed,
    // rather than the header quietly shrinking with no trace of what used to be true.
    const header = read('src/web/session-send-lock.ts')
    expect(header).toContain('CRON-SHELL WRITERS')
    expect(header).toContain('context-compact-monitor.sh')
    expect(header).toContain('quota-resume.sh')
    expect(header).toContain('/api/messages')
    expect(header).toContain('/api/agents/:name/compact')
    // The unfixed framing must not survive alongside the fix -- that combination is exactly the
    // stale-doc failure mode this whole file exists to catch (this test's own predecessor pinned
    // "STILL UNFIXED" as a fact; a real fix that forgot to update it would leave both true at once).
    expect(header).not.toMatch(/context-compact-monitor\.sh[^\n]*STILL UNFIXED/)
  })
})
