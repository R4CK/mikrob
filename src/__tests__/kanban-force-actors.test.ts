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
})
