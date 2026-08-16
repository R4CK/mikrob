// Card 115c21e7: eight independently-typed copies of the Claude usage-limit banner regex had
// drifted -- quota-check.sh was missing the "session" alternative (would not match "You hit your
// session limit"), pre-dispatch-check.sh and quota-bridge.py were missing 3 real modal phrasings,
// and quota-resume.sh had a hand-picked 3-phrase subset of its own. Consolidated to ONE physical
// source, store/session-limit-pattern.json, read at runtime by the 6 non-TS consumers.
//
// src/model-fallback.ts is the one exception: its own header states "every decision is still
// unit-testable without a clock, tmux, or the filesystem" -- a load-bearing zero-fs-dependency
// property this consolidation does not get to break. So it keeps a literal, in-memory
// USAGE_LIMIT_FRAGMENTS array instead of reading the JSON at runtime. This test is what keeps that
// literal array and the JSON file from drifting apart again -- the exact failure mode this whole
// card exists to close, now pinned by a guard instead of hoped for.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { USAGE_LIMIT_FRAGMENTS } from '../model-fallback.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PATTERN_JSON = join(REPO_ROOT, 'store', 'session-limit-pattern.json')

describe('session-limit-pattern.json stays equal to model-fallback.ts USAGE_LIMIT_FRAGMENTS', () => {
  it('the JSON file parses and is non-trivial (the guard is not vacuously passing)', () => {
    const data = JSON.parse(readFileSync(PATTERN_JSON, 'utf-8')) as { fragments: string[] }
    expect(Array.isArray(data.fragments)).toBe(true)
    expect(data.fragments.length).toBeGreaterThan(5)
  })

  it('the two fragment lists are IDENTICAL, in the same order', () => {
    const data = JSON.parse(readFileSync(PATTERN_JSON, 'utf-8')) as { fragments: string[] }
    expect(data.fragments).toEqual(USAGE_LIMIT_FRAGMENTS)
  })

  it('every fragment is ERE-safe -- no \\d and no (?:...), which bash grep -E and POSIX-ish tools cannot compile', () => {
    for (const f of USAGE_LIMIT_FRAGMENTS) {
      expect(f).not.toContain('\\d')
      expect(f).not.toContain('(?:')
    }
  })

  it('mutation control: a fragment list that has actually drifted is NOT reported as equal', () => {
    // Proves the comparison above is a real check, not `expect(x).toBeTruthy()`-shaped.
    const drifted = [...USAGE_LIMIT_FRAGMENTS, 'a phrase only one side has']
    expect(drifted).not.toEqual(USAGE_LIMIT_FRAGMENTS)
  })
})
