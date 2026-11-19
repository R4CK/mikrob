// Card 2ba008f2 (elemzo plan-grilling on d5638d28, comment 32144, C1): the self-declared
// actor==='mikrob' bypass must be refused during a session outage, for every caller, regardless
// of what the body claims -- the SAME auto-clearing marker quota-bridge.py already writes for
// the gemini-fallback engagement decision (store/mikrob-session-outage.json), not a new flag.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Same vi.hoisted pattern as operator-scope-gate.test.ts's ACCESS_FILE: the scratch path must
// exist before the mocked ../config.js module is evaluated, which happens before any ordinary
// top-level statement in this file runs.
const SCRATCH_STORE = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return mkdtempSync(join(tmpdir(), 'force-actors-outage-'))
})

vi.mock('../config.js', async (orig) => {
  const real = await orig<typeof import('../config.js')>()
  return { ...real, STORE_DIR: SCRATCH_STORE }
})

import { isForceActor, forceActors } from '../kanban-force-actors.js'

const OUTAGE_PATH = join(SCRATCH_STORE, 'mikrob-session-outage.json')

function writeOutage(active: boolean, heartbeatAgeSec = 0) {
  writeFileSync(OUTAGE_PATH, JSON.stringify({ active, heartbeat: Math.floor(Date.now() / 1000) - heartbeatAgeSec }))
}

afterEach(() => {
  try { rmSync(OUTAGE_PATH) } catch { /* may not exist */ }
})

describe('isForceActor', () => {
  it('the ordinary case is unaffected: force+mikrob -> true with no outage marker at all', () => {
    expect(isForceActor(true, 'mikrob')).toBe(true)
  })

  it('BLOCKING: force+mikrob is refused while the outage marker is active and fresh', () => {
    writeOutage(true, 0)
    expect(isForceActor(true, 'mikrob')).toBe(false)
  })

  it('a non-mikrob actor stays refused during outage too (no change in that direction)', () => {
    writeOutage(true, 0)
    expect(isForceActor(true, 'someone-else')).toBe(false)
  })

  it('an INACTIVE marker (active: false) does not refuse the bypass', () => {
    writeOutage(false, 0)
    expect(isForceActor(true, 'mikrob')).toBe(true)
  })

  it('a STALE marker (heartbeat older than 15 min) does not refuse the bypass -- fail-safe toward normal', () => {
    writeOutage(true, 20 * 60)
    expect(isForceActor(true, 'mikrob')).toBe(true)
  })

  it('a FUTURE-dated marker (clock skew beyond tolerance) does not refuse the bypass', () => {
    writeOutage(true, -5 * 60)
    expect(isForceActor(true, 'mikrob')).toBe(true)
  })

  it('forceActors() itself is unaffected by outage state (it is just the allowlist, not a decision)', () => {
    expect(forceActors()).toEqual(['mikrob'])
  })

  // Card e3cf26d0 (MikroB addendum, comment 32433): a non-string actor must never match the
  // allowlist, even one that LOOKS like 'mikrob' under coercion (toString/valueOf, or a
  // single-element array). Set.has() uses SameValueZero (no coercion) today -- this pins that, so
  // a mutant that swapped it for a coercing comparison (e.g. FORCE_ACTORS.has(String(actor)), or
  // a loose `==`) goes red here, even though every upstream call site's own `typeof actor ===
  // 'string'` narrowing (kanban.ts, kanbanWriteActor) would normally stop it first.
  it('a non-string actor never matches the allowlist, even if it looks like "mikrob" under coercion', () => {
    const looksLikeMikrob = { toString: () => 'mikrob', valueOf: () => 'mikrob' } as unknown as string
    expect(isForceActor(true, looksLikeMikrob)).toBe(false)
    expect(isForceActor(true, ['mikrob'] as unknown as string)).toBe(false)
  })
})

describe('isForceActor -- Cybered NO-GO (comment 32445, Finding 2): fail CLOSED on a marker that exists but cannot be trusted', () => {
  it('BLOCKING: corrupt JSON refuses the bypass', () => {
    writeFileSync(OUTAGE_PATH, '{not json')
    expect(isForceActor(true, 'mikrob')).toBe(false)
  })

  it('BLOCKING: an empty file refuses the bypass', () => {
    writeFileSync(OUTAGE_PATH, '')
    expect(isForceActor(true, 'mikrob')).toBe(false)
  })

  it('BLOCKING: a directory in place of the file refuses the bypass', () => {
    const { mkdirSync, rmdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(OUTAGE_PATH)
    try {
      expect(isForceActor(true, 'mikrob')).toBe(false)
    } finally {
      rmdirSync(OUTAGE_PATH)
    }
  })

  it('BLOCKING: active as the string "true" (wrong type) refuses the bypass', () => {
    writeFileSync(OUTAGE_PATH, JSON.stringify({ active: 'true', heartbeat: Math.floor(Date.now() / 1000) }))
    expect(isForceActor(true, 'mikrob')).toBe(false)
  })

  it('BLOCKING: heartbeat as a string (wrong type) refuses the bypass', () => {
    writeFileSync(OUTAGE_PATH, JSON.stringify({ active: true, heartbeat: String(Math.floor(Date.now() / 1000)) }))
    expect(isForceActor(true, 'mikrob')).toBe(false)
  })

  it('BLOCKING: heartbeat in milliseconds instead of seconds (implausible value) refuses the bypass', () => {
    writeFileSync(OUTAGE_PATH, JSON.stringify({ active: true, heartbeat: Date.now() }))
    expect(isForceActor(true, 'mikrob')).toBe(false)
  })

  it('BLOCKING: a JSON array instead of an object refuses the bypass', () => {
    writeFileSync(OUTAGE_PATH, JSON.stringify([true, Math.floor(Date.now() / 1000)]))
    expect(isForceActor(true, 'mikrob')).toBe(false)
  })

  it('BLOCKING: a file that cannot be read (permission denied) refuses the bypass', () => {
    const { chmodSync } = require('node:fs') as typeof import('node:fs')
    writeOutage(false, 0)
    chmodSync(OUTAGE_PATH, 0o000)
    try {
      expect(isForceActor(true, 'mikrob')).toBe(false)
    } finally {
      chmodSync(OUTAGE_PATH, 0o644)
    }
  })

  it('NOT BLOCKING (unchanged): a genuinely missing marker does not refuse the bypass', () => {
    expect(isForceActor(true, 'mikrob')).toBe(true)
  })

  it('NOT BLOCKING (unchanged): a stale marker past SESSION_OUTAGE_STALE_MS does not refuse the bypass', () => {
    writeOutage(true, 20 * 60)
    expect(isForceActor(true, 'mikrob')).toBe(true)
  })

  it('NOT BLOCKING (unchanged): a modest future-dated marker within the clock-skew allowance beyond tolerance still does not refuse the bypass', () => {
    writeOutage(true, -5 * 60)
    expect(isForceActor(true, 'mikrob')).toBe(true)
  })
})
