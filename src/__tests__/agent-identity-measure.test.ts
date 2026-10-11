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
    measureAgentIdentityClaim(fakeCtx({ kind: 'token' }), 'POST /api/messages', 'qa')
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]![0]).toMatchObject({ endpoint: 'POST /api/messages', authKind: 'legacy-token' })
    expect(warn).not.toHaveBeenCalled()
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
