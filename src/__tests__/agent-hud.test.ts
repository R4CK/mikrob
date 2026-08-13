import { describe, it, expect } from 'vitest'
import { pairToolActivity } from '../web/agent-hud.js'

// Card e9504aba. These fixtures use the transcript shape MEASURED on real fleet
// transcripts, not the shape the docs describe: a `tool_use` block carries
// { type, id, name, input, caller } on an assistant message, and the completion is a
// `tool_result` block carrying { type, tool_use_id, content, is_error } on the next
// user message. The sub-agent tool is named `Agent` in this codebase (measured: 15
// calls across six agents in the 25 newest transcripts), NOT `Task`.
//
// The point of pairing rather than "read the last tool_use" is that the newest call
// tells you what was STARTED; only the absence of its result tells you it is still
// running. A test that only checked the last tool_use would pass on an implementation
// that reports a finished tool as active -- so the finished cases below carry the
// weight, not the in-flight ones.

const use = (id: string, name: string, input: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })

const result = (id: string) =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] },
  })

describe('pairToolActivity -- what the agent is doing RIGHT NOW', () => {
  it('reports no active tool when every call has returned', () => {
    const signals = pairToolActivity([use('t1', 'Bash'), result('t1')])
    expect(signals.activeTool).toBeNull()
    expect(signals.runningSubAgents).toBe(0)
  })

  it('reports the tool whose result has NOT arrived', () => {
    const signals = pairToolActivity([use('t1', 'Bash'), result('t1'), use('t2', 'Read')])
    expect(signals.activeTool).toBe('Read')
  })

  it('does NOT report a finished tool as active just because it was the newest call', () => {
    // The mutation this is aimed at: an implementation that reverse-scans for the last
    // tool_use and returns its name. That reads 'Read' here, where the truth is null.
    const signals = pairToolActivity([use('t1', 'Read'), result('t1')])
    expect(signals.activeTool).toBeNull()
  })

  it('counts a dispatched sub-agent as running until its result arrives', () => {
    const dispatched = pairToolActivity([use('a1', 'Agent')])
    expect(dispatched.runningSubAgents).toBe(1)
    expect(dispatched.activeTool).toBe('Agent')

    const returned = pairToolActivity([use('a1', 'Agent'), result('a1')])
    expect(returned.runningSubAgents).toBe(0)
  })

  it('counts several sub-agents at once, and only the open ones', () => {
    const signals = pairToolActivity([
      use('a1', 'Agent'),
      use('a2', 'Agent'),
      use('a3', 'Agent'),
      result('a2'),
    ])
    expect(signals.runningSubAgents).toBe(2)
  })

  it('accepts Task as a sub-agent name too, so an upstream rename cannot zero the counter', () => {
    expect(pairToolActivity([use('a1', 'Task')]).runningSubAgents).toBe(1)
  })

  it('does not count an ordinary tool as a sub-agent', () => {
    const signals = pairToolActivity([use('t1', 'Bash'), use('t2', 'Edit')])
    expect(signals.runningSubAgents).toBe(0)
    expect(signals.activeTool).toBe('Edit')
  })

  it('NEVER surfaces tool arguments -- the binding constraint on this card', () => {
    // A tool input carrying a path, a token-shaped string and a tenant id. The returned
    // shape must be reconstructible into none of it: the assertion is on the WHOLE
    // serialised result, so a future field that leaks input fails here rather than
    // slipping past a field-by-field check.
    const signals = pairToolActivity([
      use('t1', 'Bash', {
        command: 'cat /home/neon/marveen/store/.dashboard-token',
        secret: 'sk-live-should-never-appear',
        tenantId: 'acme-gmbh',
      }),
    ])
    const serialised = JSON.stringify(signals)
    expect(serialised).not.toContain('dashboard-token')
    expect(serialised).not.toContain('sk-live-should-never-appear')
    expect(serialised).not.toContain('acme-gmbh')
    expect(serialised).not.toContain('command')
    expect(signals.activeTool).toBe('Bash') // the name, and nothing but the name
  })

  it('survives a half-written last line, which a live transcript always has', () => {
    const signals = pairToolActivity([use('t1', 'Bash'), '{"type":"assistant","message":{"cont'])
    expect(signals.activeTool).toBe('Bash')
  })

  it('ignores entries with no content array (mode/system/attachment records)', () => {
    const signals = pairToolActivity([
      JSON.stringify({ type: 'mode', mode: 'default' }),
      JSON.stringify({ type: 'system', message: { content: 'plain string, not blocks' } }),
      use('t1', 'Grep'),
    ])
    expect(signals.activeTool).toBe('Grep')
  })

  it('pairs a result that arrives before the use in the scanned window (tail cut mid-call)', () => {
    // The tail bound can slice between a use and its result. A result whose use is not in
    // the window must not resurrect that call as active when the use scrolls in later.
    const signals = pairToolActivity([result('t1'), use('t1', 'Bash')])
    expect(signals.activeTool).toBeNull()
    expect(signals.runningSubAgents).toBe(0)
  })
})
