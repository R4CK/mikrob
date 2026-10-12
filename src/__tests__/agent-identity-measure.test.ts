// Card 2520b85a (measurement-only slice of the per-agent-identity plan; see the plan-grilling
// comment on the card for the full verdict). This module must NEVER change a response or throw --
// it only emits log lines, so these tests pin: (a) legacy-token calls are distinguished from
// per-agent-key calls, (b) a mismatched claim is a WARN, a matching one is INFO, (c) a missing/
// non-agent-key auth is a silent no-op, (d) the AGENT_IDENTITY_MEASURE=off flag disables all of it,
// (e) an internal failure is swallowed (fail-open) and never reaches the caller.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { logger } from '../logger.js'
import { measureAgentIdentityClaim, isAgentIdentityMeasureEnabled } from '../web/agent-identity-measure.js'
import { createDeviceKey } from '../web/auth-device-keys.js'
import { initDatabase } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(auth: RouteContext['auth']): RouteContext {
  return { auth } as RouteContext
}

describe('measureAgentIdentityClaim', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    delete process.env.AGENT_IDENTITY_MEASURE
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.AGENT_IDENTITY_MEASURE
  })

  it('legacy shared token: logs info with authKind legacy-token, nothing else', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    measureAgentIdentityClaim(fakeCtx({ kind: 'token' }), 'POST /api/messages', undefined)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]![0]).toMatchObject({ endpoint: 'POST /api/messages', authKind: 'legacy-token' })
    expect(info.mock.calls[0]![0]).not.toHaveProperty('claimed')
    expect(warn).not.toHaveBeenCalled()
  })

  // L2 (WhiteHat2 16476): the legacy-token line previously omitted the claim entirely, so the
  // measurement could not say WHO still uses the shared token.
  it('legacy shared token WITH a claim: the claim is included so the measurement can attribute it', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    measureAgentIdentityClaim(fakeCtx({ kind: 'token' }), 'POST /api/messages', 'qa')
    expect(info.mock.calls[0]![0]).toMatchObject({ endpoint: 'POST /api/messages', authKind: 'legacy-token', claimed: 'qa' })
  })

  // L2: an unbounded claim is itself a cost (a multi-MB claim -> a multi-MB log line). Pinning the
  // bound here means a future call site cannot silently reopen it.
  it('an over-long claim is truncated in the log line, on both the legacy-token and agent-key paths', () => {
    createDeviceKey('agent:backend')
    const longClaim = 'x'.repeat(200)
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    measureAgentIdentityClaim(fakeCtx({ kind: 'token' }), 'POST /api/messages', longClaim)
    const legacyClaimed = info.mock.calls[0]![0] as { claimed: string }
    expect(legacyClaimed.claimed.length).toBeLessThan(longClaim.length)

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    measureAgentIdentityClaim(fakeCtx({ kind: 'device', device: 'agent:backend', deviceId: 1 }), 'POST /api/kanban/:id/comments', longClaim)
    const mismatchClaimed = warn.mock.calls[0]![0] as { claimed: string }
    expect(mismatchClaimed.claimed.length).toBeLessThan(longClaim.length)
  })

  // L3: the match/mismatch comparison is case-insensitive by design (device-key names and claimed
  // actor strings are not guaranteed to share casing convention) -- pin it so a future refactor
  // cannot silently make it case-sensitive.
  it('case-insensitive match: differently-cased claim matching the agent id logs info, not warn', () => {
    createDeviceKey('agent:backend')
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    measureAgentIdentityClaim(fakeCtx({ kind: 'device', device: 'agent:backend', deviceId: 1 }), 'POST /api/kanban/:id/move', 'BACKEND')
    expect(warn).not.toHaveBeenCalled()
    expect(info.mock.calls[0]![0]).toMatchObject({ authKind: 'agent-key', agentId: 'backend' })
  })

  // L3 counterpart: a genuinely different claim, even after case-folding, is still a mismatch.
  it('case-insensitive compare does not mask a real mismatch', () => {
    createDeviceKey('agent:backend')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    measureAgentIdentityClaim(fakeCtx({ kind: 'device', device: 'agent:backend', deviceId: 1 }), 'POST /api/kanban/:id/move', 'BACKEND2')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  // L2 comparison-vs-logging split: truncation must never feed back into the match decision --
  // otherwise a pathologically long claim that happens to share its first 64 chars with the
  // agent id would falsely log as a mismatch even though the full strings are identical.
  it('truncation never changes the match/mismatch verdict: a long claim identical to a long agent id still matches', () => {
    const longId = 'backend-' + 'y'.repeat(100)
    createDeviceKey(`agent:${longId}`)
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    measureAgentIdentityClaim(fakeCtx({ kind: 'device', device: `agent:${longId}`, deviceId: 1 }), 'POST /api/kanban/:id/move', longId)
    expect(warn).not.toHaveBeenCalled()
    expect(info.mock.calls[0]![0]).toMatchObject({ authKind: 'agent-key', agentId: longId })
  })

  it('agent device key with a MATCHING claim: logs info, no warn', () => {
    createDeviceKey('agent:backend')
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    measureAgentIdentityClaim(fakeCtx({ kind: 'device', device: 'agent:backend', deviceId: 1 }), 'POST /api/kanban/:id/move', 'backend')
    expect(warn).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]![0]).toMatchObject({ endpoint: 'POST /api/kanban/:id/move', authKind: 'agent-key', agentId: 'backend' })
  })

  it('agent device key with a MISMATCHING claim: logs warn with both identities, never throws', () => {
    createDeviceKey('agent:backend')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    expect(() =>
      measureAgentIdentityClaim(fakeCtx({ kind: 'device', device: 'agent:backend', deviceId: 1 }), 'POST /api/kanban/:id/comments', 'qa'),
    ).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatchObject({ endpoint: 'POST /api/kanban/:id/comments', agentId: 'backend', claimed: 'qa' })
  })

  it('agent device key with no claim to compare (field absent/empty): logs info, no warn', () => {
    createDeviceKey('agent:backend')
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    measureAgentIdentityClaim(fakeCtx({ kind: 'device', device: 'agent:backend', deviceId: 1 }), 'POST /api/messages', undefined)
    expect(warn).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('a non-agent device key (Bridge/phone, no "agent:" prefix): silent no-op', () => {
    createDeviceKey("Peti's iPhone")
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    measureAgentIdentityClaim(fakeCtx({ kind: 'device', device: "Peti's iPhone", deviceId: 2 }), 'POST /api/messages', 'qa')
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('no auth at all (ungated public path reached without a principal): silent no-op', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    measureAgentIdentityClaim(fakeCtx(undefined), 'POST /api/messages', 'qa')
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('session or federation auth kinds: silent no-op (out of scope for this measurement)', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    measureAgentIdentityClaim(fakeCtx({ kind: 'session', user: 'peti' }), 'POST /api/messages', 'qa')
    measureAgentIdentityClaim(fakeCtx({ kind: 'federation', peer: 'other-system' }), 'POST /api/messages', 'qa')
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('AGENT_IDENTITY_MEASURE=off: zero log calls, flag correctly read', () => {
    process.env.AGENT_IDENTITY_MEASURE = 'off'
    expect(isAgentIdentityMeasureEnabled()).toBe(false)
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    measureAgentIdentityClaim(fakeCtx({ kind: 'token' }), 'POST /api/messages', 'qa')
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('default (flag unset): enabled', () => {
    expect(isAgentIdentityMeasureEnabled()).toBe(true)
  })

  // Mutation-style proof: an internal failure must never escape -- fail-open is the whole point
  // of a measurement-only module living on a hot request path. A non-string `device` (defeats the
  // RouteContext type at runtime, as an untrusted/corrupted auth object could) makes
  // agentKeyToAgentId's own `.startsWith` call throw a real TypeError, with no mocking needed.
  it('an internal failure never throws and is logged as its own warn, not propagated', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    const corruptAuth = { kind: 'device', device: 42 as unknown as string, deviceId: 1 } as RouteContext['auth']
    expect(() => measureAgentIdentityClaim(fakeCtx(corruptAuth), 'POST /api/messages', 'qa')).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('measurement itself failed'))
  })
})
