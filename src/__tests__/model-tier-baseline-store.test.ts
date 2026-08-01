import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import {
  readBaselineModel,
  recordBaselineIfAbsent,
  clearBaseline,
  readAllBaselines,
} from '../web/model-tier-baseline-store.js'

const FILE = join(PROJECT_ROOT, 'store', 'model-tier-baseline.json')

// The store reads the file fresh on every call, so a fresh call IS what happens after a dashboard
// restart -- there is no in-memory cache to lose. That is the whole point of the card: the base
// survives a restart because it lives on disk, not in the runner's memory.
afterEach(() => {
  if (existsSync(FILE)) rmSync(FILE)
})

describe('the durable per-agent base survives a restart (card 5d2002b5)', () => {
  it('a recorded base is readable by a subsequent (post-restart) call', () => {
    expect(readBaselineModel('backend')).toBeNull()
    recordBaselineIfAbsent('backend', 'claude-opus-5')
    // A separate call re-reads the file from disk -- the restart case.
    expect(readBaselineModel('backend')).toBe('claude-opus-5')
  })

  it('recording is IDEMPOTENT: a later step-down does not overwrite the original base', () => {
    // The base is whatever the agent ran on the FIRST time it was stepped down. When tier 1 -> tier 2
    // records again, the current model is already the cheaper one, and must NOT replace the base --
    // otherwise the revert would climb back only to the tier-1 model, not the real home.
    recordBaselineIfAbsent('backend', 'claude-opus-5')
    recordBaselineIfAbsent('backend', 'claude-sonnet-5') // the tier-1 model; must be ignored
    expect(readBaselineModel('backend')).toBe('claude-opus-5')
  })

  it('clearing removes the record, so the agent is back home', () => {
    recordBaselineIfAbsent('backend', 'claude-opus-5')
    clearBaseline('backend')
    expect(readBaselineModel('backend')).toBeNull()
  })

  it('keeps agents separate, and exposes the whole map for the dashboard', () => {
    recordBaselineIfAbsent('backend', 'claude-opus-5')
    recordBaselineIfAbsent('qa', 'claude-sonnet-5')
    expect(readAllBaselines()).toEqual({ backend: 'claude-opus-5', qa: 'claude-sonnet-5' })
    clearBaseline('backend')
    expect(readAllBaselines()).toEqual({ qa: 'claude-sonnet-5' })
  })

  it('an empty or non-string value is ignored, never becoming a phantom base', () => {
    recordBaselineIfAbsent('backend', '')
    expect(readBaselineModel('backend')).toBeNull()
  })
})
