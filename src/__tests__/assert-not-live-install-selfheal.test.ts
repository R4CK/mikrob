// Card 5dcde7d3 (MikroB decision): assert-not-live-install.ts's self-heal logic, tested directly
// against a throwaway root -- see that file's own header for why this exists (three exhaustive,
// independently-verified instrumentation passes each caught zero real opens of the live
// store/claudeclaw.db across several reproductions of this exact refusal).
//
// selfHealFreshMarkers/runStartedAtMs are pure functions of an explicit `root` parameter
// specifically so this can drive them against a tmpdir instead of needing to fake this file's own
// on-disk location (repoRoot is derived from import.meta.url at module scope).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selfHealFreshMarkers, runStartedAtMs } from './setup/assert-not-live-install.js'
import { sentinelPathFor } from './setup/record-run-start.js'

let root: string
let sentinelPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'selfheal-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  sentinelPath = sentinelPathFor(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  try { rmSync(sentinelPath) } catch { /* may not have been written this case */ }
})

const MARKER = join('store', 'claudeclaw.db')

function writeMarker(mtimeMs: number) {
  const full = join(root, MARKER)
  writeFileSync(full, 'x')
  const t = new Date(mtimeMs)
  utimesSync(full, t, t)
}

describe('runStartedAtMs', () => {
  it('reads back exactly what the sentinel holds', () => {
    writeFileSync(sentinelPath, '123456789')
    expect(runStartedAtMs(root)).toBe(123456789)
  })

  it('returns null when no sentinel exists (never wired through globalSetup)', () => {
    expect(runStartedAtMs(root)).toBeNull()
  })

  it('returns null on unparsable sentinel content, rather than throwing or coercing to NaN-as-0', () => {
    writeFileSync(sentinelPath, 'not-a-number')
    expect(runStartedAtMs(root)).toBeNull()
  })
})

describe('selfHealFreshMarkers', () => {
  it('CONTROL: with no sentinel, every marker is left exactly as found -- the original fail-closed behaviour', () => {
    writeMarker(Date.now())
    expect(selfHealFreshMarkers([MARKER], root)).toEqual([MARKER])
    expect(existsSync(join(root, MARKER))).toBe(true)
  })

  it('a marker NEWER than the run start is deleted and dropped from the result (healed)', () => {
    const runStart = Date.now()
    writeFileSync(sentinelPath, String(runStart))
    writeMarker(runStart + 60_000) // one minute after the run started
    expect(selfHealFreshMarkers([MARKER], root)).toEqual([])
    expect(existsSync(join(root, MARKER))).toBe(false)
  })

  it('a marker OLDER than the run start is left in place and still reported -- a genuine pre-existing install must still refuse', () => {
    const runStart = Date.now()
    writeFileSync(sentinelPath, String(runStart))
    writeMarker(runStart - 60_000) // one minute BEFORE the run started
    expect(selfHealFreshMarkers([MARKER], root)).toEqual([MARKER])
    expect(existsSync(join(root, MARKER))).toBe(true)
  })

  it('a marker with the EXACT same mtime as the run start is treated as pre-existing (strictly-after, not >=)', () => {
    const runStart = Date.now()
    writeFileSync(sentinelPath, String(runStart))
    writeMarker(runStart)
    expect(selfHealFreshMarkers([MARKER], root)).toEqual([MARKER])
  })

  it('a marker that vanished between the caller\'s existsSync and this call is dropped, not treated as still live', () => {
    const runStart = Date.now()
    writeFileSync(sentinelPath, String(runStart))
    // Never actually created: simulates the TOCTOU window the caller's own existsSync leaves.
    expect(selfHealFreshMarkers([MARKER], root)).toEqual([])
  })

  it('mixed markers: only the fresh one is healed, the pre-existing one still refuses -- a partial live install is not waved through', () => {
    const runStart = Date.now()
    writeFileSync(sentinelPath, String(runStart))
    const tokenMarker = join('store', '.dashboard-token')
    writeMarker(runStart + 60_000) // fresh: claudeclaw.db
    const tokenFull = join(root, tokenMarker)
    writeFileSync(tokenFull, 'x')
    const oldTime = new Date(runStart - 60_000)
    utimesSync(tokenFull, oldTime, oldTime) // pre-existing: .dashboard-token

    const result = selfHealFreshMarkers([MARKER, tokenMarker], root)
    expect(result).toEqual([tokenMarker])
    expect(existsSync(join(root, MARKER))).toBe(false) // healed
    expect(existsSync(tokenFull)).toBe(true) // untouched, still counts
  })
})
