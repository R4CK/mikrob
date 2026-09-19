import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { classifyAgentMessage } from '../web/agent-message-wrap.js'
import { COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID } from '../channel-coordinator/ingest.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'
import { _withVoiceChannelAllowlistForTest } from '../web/voice-channel-device-allowlist.js'

// HANGCSATORNA918 (owner request, 2026-09-18). The owner dictates into an
// external voice assistant which relays the transcript to /api/messages. Before
// this, the relay wrote as the MAIN AGENT, so the message arrived looking like
// the main agent talking to itself and no receiving agent could tell it apart
// from internal fleet traffic.
//
// The fix has THREE parts and they only work together:
//   1. delivery side: 'hanna' is in CHANNEL_COORDINATOR_AGENTS -> channel-inbound
//      framing, so EVERY agent sees the provenance, not just the main agent;
//   2. write side (auth LANE): a 'hanna' POST is accepted only from a device key.
//   3. write side (auth ALLOWLIST, added after Cybersec NO-GO on card 7503bb31):
//      the device key's id must ALSO be on an out-of-band allowlist. Without
//      this, part 2 alone is not per-device: POST /api/auth/device-keys mints
//      a device key for anyone holding the shared dashboard token, so "kind
//      === device" was reachable by exactly the population it meant to exclude.
// Part 1 alone would be a forgery hole (channel-inbound means "the owner,
// reply expected", and the dashboard token is readable by every sub-agent);
// parts 2+3 together are what makes "device" actually mean one specific,
// operator-designated device.

const here = dirname(fileURLToPath(import.meta.url))
const MESSAGES_ROUTE_SRC = readFileSync(join(here, '../web/routes/messages.ts'), 'utf-8')

describe('voice channel identity', () => {
  it('has its own id, distinct from the main agent and the telegram coordinator', () => {
    expect(VOICE_CHANNEL_AGENT_ID).toBe('hanna')
    expect(VOICE_CHANNEL_AGENT_ID).not.toBe(COORDINATOR_AGENT_ID)
  })

  it('classifies as channel-inbound, so every receiving agent sees the provenance', () => {
    const cls = classifyAgentMessage(VOICE_CHANNEL_AGENT_ID, 'marveen')
    expect(cls).not.toBeNull()
    expect(cls!.category).toBe('channel-inbound')
    expect(cls!.safeFrom).toBe(VOICE_CHANNEL_AGENT_ID)
  })

  it('a sub-agent recipient sees the SAME category (the framing is not main-agent-only)', () => {
    for (const to of ['mira', 'samu', 'iris']) {
      expect(classifyAgentMessage(VOICE_CHANNEL_AGENT_ID, to)!.category).toBe('channel-inbound')
    }
  })
})

describe('/api/messages write guard for the voice channel', () => {
  async function postAs(from: string, auth?: { kind: string; device?: string; deviceId?: number }) {
    const payload = JSON.stringify({ from, to: 'marveen', content: 'a dictated line' })
    const req = Readable.from([Buffer.from(payload)]) as any
    let status = 0
    let body = ''
    const res = {
      writeHead(s: number) { status = s },
      end(b?: string) { body = b ?? '' },
    } as any
    const handled = await tryHandleMessages({
      req, res, path: '/api/messages', method: 'POST',
      url: new URL('http://x/api/messages'), auth,
    } as unknown as RouteContext)
    expect(handled).toBe(true)
    return { status, body: body ? JSON.parse(body) : null }
  }

  it('REJECTS the voice-channel id on the shared dashboard token (the forgery path)', async () => {
    const { status, body } = await postAs(VOICE_CHANNEL_AGENT_ID, { kind: 'token' })
    expect(status).toBe(403)
    expect(String(body?.error)).toMatch(/device key/i)
  })

  it('REJECTS it with no credential at all', async () => {
    const { status } = await postAs(VOICE_CHANNEL_AGENT_ID)
    expect(status).toBe(403)
  })

  it('REJECTS a browser session too -- a logged-in human is still not the relay', async () => {
    const { status } = await postAs(VOICE_CHANNEL_AGENT_ID, { kind: 'session' })
    expect(status).toBe(403)
  })

  it('rejects the sanitize-bypass spellings on the same lane (router-symmetric)', async () => {
    for (const forged of ['@hanna', 'hanna.', ' hanna ', 'hanna!']) {
      const { status } = await postAs(forged, { kind: 'token' })
      expect(status, `forged from=${JSON.stringify(forged)} must be blocked`).toBe(403)
    }
  })

  it('REJECTS a device key that is NOT on the allowlist (the Cybersec NO-GO exploit, card 7503bb31)', async () => {
    // This is exactly the attack Cybersec proved live: mint/hold ANY device
    // key (e.g. one self-minted via the token-authenticated device-keys
    // endpoint) and present it. With no allowlist entries configured (the
    // default -- fail-closed, "zero entries = feature off"), it must still
    // 403, even though kind==='device' alone would have passed the OLD guard.
    const { status, body } = await postAs(VOICE_CHANNEL_AGENT_ID, {
      kind: 'device', device: 'self-minted', deviceId: 999,
    })
    expect(status).toBe(403)
    expect(String(body?.error)).toMatch(/allowlisted/i)
  })

  it('PASSES all guards on an ALLOWLISTED device key (it has no agents/<id>/ dir either)', async () => {
    // Three guards could refuse this: the device-key lane check, the
    // allowlist check, and the known-agent check (the voice id has no
    // agents/<id>/ directory, so it needs an explicit exemption). Passing ALL
    // means the handler runs on to the insert -- which throws here because
    // this harness has no DB. That throw is the PROOF of passage, so we
    // assert on it rather than skipping: a guard rejection would have
    // returned a 403 instead of ever reaching db.
    await _withVoiceChannelAllowlistForTest([5], () =>
      expect(
        postAs(VOICE_CHANNEL_AGENT_ID, { kind: 'device', device: 'the-real-relay', deviceId: 5 }),
      ).rejects.toThrow(/prepare/),
    )
  })

  it('an allowlist for a DIFFERENT device id still rejects this one', async () => {
    // Proves the check compares the actual presented id, not just "is the
    // allowlist non-empty".
    await _withVoiceChannelAllowlistForTest([5], async () => {
      const { status } = await postAs(VOICE_CHANNEL_AGENT_ID, {
        kind: 'device', device: 'some-other-device', deviceId: 6,
      })
      expect(status).toBe(403)
    })
  })

  it('NEGATIVE CONTROL: an unknown non-voice id is refused by the known-agent guard', async () => {
    // Without this the test above proves nothing: it would pass even if the
    // handler let EVERY sender through to the insert.
    await _withVoiceChannelAllowlistForTest([5], async () => {
      const { status, body } = await postAs('zack-the-stranger', { kind: 'device', device: 'a-device', deviceId: 5 })
      expect(status).toBe(403)
      expect(String(body?.error)).toMatch(/unknown agent/i)
    })
  })
})

describe('the guard pieces stay paired in the source', () => {
  it('the route guards the voice id on the AUTH LANE, not with a blanket 403', () => {
    expect(MESSAGES_ROUTE_SRC).toMatch(/sanitizeAgentIdent\(from\)\s*===\s*VOICE_CHANNEL_AGENT_ID\s*&&\s*!isAllowedVoiceDevice/)
  })

  it('the lane check is ANDed with the allowlist check, not standing alone', () => {
    // Pins the actual defect Cybersec found: kind==='device' alone must never
    // be sufficient. isAllowedVoiceDevice (what the guard above negates) has
    // to be defined as BOTH kind==='device' AND isAllowedVoiceChannelDevice(id)
    // -- a regression here (e.g. dropping the isAllowedVoiceChannelDevice half)
    // would silently reopen the Cybersec exploit.
    expect(MESSAGES_ROUTE_SRC).toMatch(
      /voiceAuth\?\.kind\s*===\s*'device'\s*&&\s*isAllowedVoiceChannelDevice\(voiceAuth\.deviceId\)/,
    )
  })

  it('the allowlist check imports from the dedicated module, not an inline literal', () => {
    expect(MESSAGES_ROUTE_SRC).toMatch(
      /import \{ isAllowedVoiceChannelDevice \} from '\.\.\/voice-channel-device-allowlist\.js'/,
    )
  })

  it('the id comes from the shared constant, never a literal in the route', () => {
    expect(MESSAGES_ROUTE_SRC).toMatch(/import \{ COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID \}/)
    // The id must not appear as a bare literal anywhere in the route, not even
    // in a comment: a future reader copying the comment would fork the source of truth.
    expect(MESSAGES_ROUTE_SRC).not.toMatch(/['\"`]hanna['\"`]/)
  })
})
