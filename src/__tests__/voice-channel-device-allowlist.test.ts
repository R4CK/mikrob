import { describe, it, expect, afterEach } from 'vitest'
import {
  isAllowedVoiceChannelDevice,
  _withVoiceChannelAllowlistForTest,
} from '../web/voice-channel-device-allowlist.js'

// Cybersec NO-GO fix (card 7503bb31): kind==='device' alone is mintable by any
// dashboard-token holder via POST /api/auth/device-keys, so it cannot be the
// whole guard. This module is the second half -- an allowlist that is NEVER
// reachable through any HTTP route, so no token-authenticated call can add an
// id to it. These tests cover the module's own parsing/lookup logic; the
// wiring into the /api/messages guard is covered by voice-channel-hanna.test.ts.

describe('isAllowedVoiceChannelDevice', () => {
  afterEach(() => {
    delete process.env.VOICE_CHANNEL_DEVICE_IDS
  })

  it('fail-closed default: no env, no file -> nothing is allowed', () => {
    expect(isAllowedVoiceChannelDevice(1)).toBe(false)
    expect(isAllowedVoiceChannelDevice(0)).toBe(false)
  })

  it('an id present in VOICE_CHANNEL_DEVICE_IDS is allowed', async () => {
    await _withVoiceChannelAllowlistForTest([42], () => {
      expect(isAllowedVoiceChannelDevice(42)).toBe(true)
      expect(isAllowedVoiceChannelDevice(43)).toBe(false)
    })
  })

  it('accepts multiple comma-separated ids', async () => {
    await _withVoiceChannelAllowlistForTest([1, 2, 3], () => {
      expect(isAllowedVoiceChannelDevice(1)).toBe(true)
      expect(isAllowedVoiceChannelDevice(2)).toBe(true)
      expect(isAllowedVoiceChannelDevice(3)).toBe(true)
      expect(isAllowedVoiceChannelDevice(4)).toBe(false)
    })
  })

  it('ignores garbage entries rather than throwing (0, negative, non-numeric)', () => {
    process.env.VOICE_CHANNEL_DEVICE_IDS = '0,-5,abc,,7'
    expect(isAllowedVoiceChannelDevice(0)).toBe(false)
    expect(isAllowedVoiceChannelDevice(-5)).toBe(false)
    expect(isAllowedVoiceChannelDevice(7)).toBe(true)
  })

  it('the test seam restores the prior env value afterwards', async () => {
    process.env.VOICE_CHANNEL_DEVICE_IDS = '9'
    await _withVoiceChannelAllowlistForTest([1], () => {
      expect(isAllowedVoiceChannelDevice(1)).toBe(true)
    })
    expect(isAllowedVoiceChannelDevice(9)).toBe(true)
    expect(isAllowedVoiceChannelDevice(1)).toBe(false)
  })
})
