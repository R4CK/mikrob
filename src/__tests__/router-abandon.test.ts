// Contract tests for shouldAbandon: router never drops a report to a
// busy-but-alive session.
//
// Root cause: the pre-fix startMessageRouter() checked `ageMs > window`
// BEFORE the session-existence check (message-router.ts:59-67). So a
// message sent to the main session, which stays alive but busy (dense
// heartbeats or a long turn), was marked "failed" at the 1h abandon mark
// even though the session never actually went away. Two completion reports
// were silently discarded in the incident that exposed this.
//
// Fix: abandon ONLY when the session is ABSENT for the full window.
// shouldAbandon(sessionExists, ageMs, windowMs) is the pure decision
// function extracted from the loop body; the contract tests pin it.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldAbandon } from '../web/message-router.js'
import { REPO_ROOT } from './helpers/repo-location.js'

const WINDOW_MS = 60 * 60 * 1000 // 1 hour, same as MESSAGE_ABANDON_WINDOW_MS

describe('shouldAbandon: abandon only when session is absent past the window', () => {
  it('returns false when session exists regardless of age', () => {
    // The core invariant: a session that is alive (even if busy for days)
    // must NEVER be abandoned. This was the bug -- the old code abandoned
    // at 1h without checking existence first.
    expect(shouldAbandon(true, WINDOW_MS + 1, WINDOW_MS)).toBe(false)
    expect(shouldAbandon(true, WINDOW_MS * 10, WINDOW_MS)).toBe(false)
    expect(shouldAbandon(true, 0, WINDOW_MS)).toBe(false)
  })

  it('returns false when session is absent but within the window', () => {
    // Session is gone but not yet past the retry window -- keep retrying.
    expect(shouldAbandon(false, WINDOW_MS - 1, WINDOW_MS)).toBe(false)
    expect(shouldAbandon(false, 0, WINDOW_MS)).toBe(false)
  })

  it('returns true when session is absent AND past the window', () => {
    // Only case where abandon is justified: session is truly gone AND the
    // full retry window has elapsed with no delivery.
    expect(shouldAbandon(false, WINDOW_MS + 1, WINDOW_MS)).toBe(true)
    expect(shouldAbandon(false, WINDOW_MS * 2, WINDOW_MS)).toBe(true)
  })

  it('returns false at the exact window boundary (strict greater-than)', () => {
    // Boundary: ageMs === windowMs is NOT yet abandoned (strict >).
    expect(shouldAbandon(false, WINDOW_MS, WINDOW_MS)).toBe(false)
  })
})

// Card 99254564 (Cybered/backend2 finding, dbc0b4bf): the router closed a message's OTel span on
// its own SUCCESSFUL delivery but never on its own TERMINAL failures (inject-retry exhaustion, an
// abandon after an earlier tick had already stamped a trace, or an unexpected processing throw) --
// unlike routes/messages.ts's PUT handler, which closes the span for the SAME class of event when
// the RECEIVER reports done/failed. Zero-population today (no abandoned row currently carries a
// trace), so this pins the WIRING rather than a live-loop integration test: mocking the full tmux
// delivery loop (session existence, sendPromptToSession, tick timing) to reach all four failure
// exits would be substantial new test infrastructure for a fix that is otherwise a mechanical,
// idempotent (IF-OPEN semantics) addition at four call sites. This is the same "wired, not just
// present" pattern used elsewhere in this repo for exactly this defect class (a detector or a
// closer that exists but nothing calls, e.g. scaffold-adoption-ec7bdad8.test.ts).
describe('the router closes its OWN span on ITS OWN terminal failures too (card 99254564)', () => {
  const src = readFileSync(join(REPO_ROOT, 'src', 'web', 'message-router.ts'), 'utf-8')
  const strip = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  const stripped = strip(src)

  it('the success path still closes the span -- the baseline this card extends, not replaces', () => {
    expect(stripped).toContain("closeOtelSpanIfOpen(traceCtx.trace_id, traceCtx.span_id, Date.now(), 'ok')")
  })

  it('federated abandon closes the span, after the SAME call that marks it failed', () => {
    const failIdx = stripped.indexOf("markPendingFederatedFailed(msg.id, 'Abandoned: peer unreachable for full retry window')")
    const closeIdx = stripped.indexOf('closeRouterSpanOnFailure(msg.trace_id, msg.span_id)')
    expect(failIdx, 'markPendingFederatedFailed call not found').toBeGreaterThan(-1)
    expect(closeIdx, 'the span close is not wired into the federated abandon path').toBeGreaterThan(-1)
    expect(closeIdx - failIdx).toBeLessThan(400) // same branch, not a coincidental later match
  })

  it('local-queue abandon closes the span too', () => {
    const failIdx = stripped.indexOf("markMessageFailed(msg.id, 'Abandoned: target session absent for full retry window')")
    const closeIdx = stripped.indexOf('closeRouterSpanOnFailure(msg.trace_id, msg.span_id)', failIdx)
    expect(failIdx, 'the local abandon markMessageFailed call not found').toBeGreaterThan(-1)
    expect(closeIdx, 'the span close is not wired into the local abandon path').toBeGreaterThan(-1)
    expect(closeIdx - failIdx).toBeLessThan(400)
  })

  it('inject-retry exhaustion closes the span, using the traceCtx already computed for delivery', () => {
    const failIdx = stripped.indexOf('Failed to inject into tmux session after')
    const closeIdx = stripped.indexOf('closeRouterSpanOnFailure(traceCtx?.trace_id, traceCtx?.span_id)', failIdx)
    expect(failIdx, 'the inject-exhaustion markMessageFailed call not found').toBeGreaterThan(-1)
    expect(closeIdx, 'the span close is not wired into the inject-retry-exhaustion path').toBeGreaterThan(-1)
    expect(closeIdx - failIdx).toBeLessThan(400)
  })

  it('the outer catch-all closes the span too, from the RAW row (traceCtx is out of scope there)', () => {
    const failIdx = stripped.lastIndexOf('markMessageFailed(msg.id, `Delivery error:')
    const closeIdx = stripped.indexOf('closeRouterSpanOnFailure(msg.trace_id, msg.span_id)', failIdx)
    expect(failIdx, 'the outer-catch markMessageFailed call not found').toBeGreaterThan(-1)
    expect(closeIdx, 'the span close is not wired into the outer catch-all').toBeGreaterThan(-1)
    expect(closeIdx - failIdx).toBeLessThan(400)
    // traceCtx is declared inside the inner try this catch is paired with, so it is genuinely out
    // of scope by the time this catch runs -- using it here would be a compile error, not a bug a
    // test could catch at runtime, but pinning the CHOICE (msg.trace_id, not traceCtx) documents
    // why a future edit should not "simplify" this back to the pattern the other three use.
    const region = stripped.slice(failIdx, closeIdx + 100)
    expect(region).not.toContain('closeRouterSpanOnFailure(traceCtx')
  })

  it('closeRouterSpanOnFailure itself is a no-op without both trace_id and span_id', () => {
    const fnIdx = stripped.indexOf('function closeRouterSpanOnFailure(')
    expect(fnIdx).toBeGreaterThan(-1)
    const body = stripped.slice(fnIdx, fnIdx + 300)
    expect(body).toMatch(/if\s*\(\s*trace_id\s*&&\s*span_id\s*\)/)
  })
})
