// Voice-channel device allowlist (Cybersec NO-GO fix, card 7503bb31).
//
// Cybersec proved that `ctx.auth?.kind === 'device'` alone does not bind the
// 'hanna' guard to any SPECIFIC device: POST /api/auth/device-keys accepts the
// shared dashboard token (kind:'token') as admin auth and mints a fresh device
// key on demand, so any token holder self-escalates into the device lane with
// one call. The guard's own premise -- "a device key is a per-device secret
// the sub-agents do not have" -- was false: they can mint one.
//
// FIX: the guard must also check that the PRESENTED device key's numeric id is
// on an allowlist that is NOT reachable through any HTTP endpoint, mirroring
// how store/.dashboard-token itself works (dashboard-auth.ts): env override,
// else a plain file read directly off disk, with NO corresponding write route
// anywhere in this codebase. Minting or enrolling a device key over HTTP can
// never add an id here -- only a human with filesystem/SSH access to the box
// can, by editing the file or setting the env var. Zero entries = the voice
// channel is OFF (same "zero rows = feature off" convention as device_keys
// itself), so a fresh install is unaffected until Peti deliberately configures
// which device (his phone / the Bridge relay) may speak as the owner.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'

const ALLOWLIST_PATH = join(STORE_DIR, '.voice-channel-device-ids')

function parseIds(raw: string): Set<number> {
  const ids = new Set<number>()
  for (const part of raw.split(/[,\s]+/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const n = Number(trimmed)
    if (Number.isInteger(n) && n > 0) ids.add(n)
  }
  return ids
}

function loadAllowlist(): Set<number> {
  const fromEnv = process.env.VOICE_CHANNEL_DEVICE_IDS?.trim()
  if (fromEnv) return parseIds(fromEnv)
  try {
    if (existsSync(ALLOWLIST_PATH)) {
      return parseIds(readFileSync(ALLOWLIST_PATH, 'utf-8'))
    }
  } catch { /* fall through to empty (fail-closed) */ }
  return new Set()
}

/** True iff `deviceId` (the numeric id resolved by auth-gate.ts for a
 *  presented device key) is on the out-of-band voice-channel allowlist. Reads
 *  fresh every call (no cache): the allowlist is a low-traffic, admin-edited
 *  file, and a stale cache would mean a revocation (removing an id from the
 *  file) does not take effect until a restart. */
export function isAllowedVoiceChannelDevice(deviceId: number): boolean {
  return loadAllowlist().has(deviceId)
}

/** Test seam: override the allowlist via the SAME env var production reads,
 *  without touching the filesystem. Works with an async `fn` (awaited),
 *  restoring the prior value (or deleting it) once `fn` settles either way. */
export async function _withVoiceChannelAllowlistForTest<T>(
  ids: readonly number[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const prevEnv = process.env.VOICE_CHANNEL_DEVICE_IDS
  process.env.VOICE_CHANNEL_DEVICE_IDS = ids.join(',')
  try {
    return await fn()
  } finally {
    if (prevEnv === undefined) delete process.env.VOICE_CHANNEL_DEVICE_IDS
    else process.env.VOICE_CHANNEL_DEVICE_IDS = prevEnv
  }
}
