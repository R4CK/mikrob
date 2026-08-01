// Weekly hard-stop flag (card d08b98f4). This flag parks the fleet, so the two mistakes that matter
// are parking MikroB (nothing would restart the fleet) and failing CLOSED on an unreadable file
// (a corrupt flag would park everything until a human noticed).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readHardStop, isParkedByHardStop } from '../costops/weekly-hard-stop.js'

let dir: string
const p = () => join(dir, 'weekly-hard-stop.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hard-stop-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (o: Record<string, unknown>) => writeFileSync(p(), JSON.stringify(o))

describe('readHardStop', () => {
  it('reads an active flag with its numbers and reason', () => {
    write({ active: true, percent: 98, testStop: 97, exemptAgents: ['mikrob'], reason: 'over', updatedAt: 5 })
    expect(readHardStop(p())).toEqual({
      active: true,
      percent: 98,
      testStop: 97,
      newDevStop: 90,
      newDevStopActive: true,
      exemptAgents: ['mikrob'],
      reason: 'over',
      updatedAt: 5,
    })
  })

  it('a MISSING flag is not a stop (fail-open: a stop signal, not a permission)', () => {
    expect(readHardStop(p()).active).toBe(false)
  })

  it('a CORRUPT flag is not a stop either -- a bad file must not park the fleet', () => {
    writeFileSync(p(), 'not json at all')
    expect(readHardStop(p()).active).toBe(false)
  })

  it('only a literal true activates it (a truthy string does not)', () => {
    write({ active: 'true', percent: 98, testStop: 97 })
    expect(readHardStop(p()).active).toBe(false)
  })
})

describe('isParkedByHardStop', () => {
  const active = (exempt: unknown = ['mikrob']) => {
    write({ active: true, percent: 99, testStop: 97, exemptAgents: exempt, reason: 'over' })
    return readHardStop(p())
  }

  it('parks a role agent while the stop is active', () => {
    expect(isParkedByHardStop('qa', active())).toBe(true)
    expect(isParkedByHardStop('cybersec', active())).toBe(true)
  })

  it('NEVER parks MikroB -- it is what restarts the fleet after the reset (rule 7)', () => {
    expect(isParkedByHardStop('mikrob', active())).toBe(false)
  })

  it('keeps MikroB exempt even when the flag file forgot to say so', () => {
    // A hand-edited or older-script flag must not become an instruction to park the one agent that
    // can undo the stop.
    expect(isParkedByHardStop('mikrob', active([]))).toBe(false)
    expect(isParkedByHardStop('mikrob', active('nonsense'))).toBe(false)
  })

  it('parks nobody while the stop is inactive', () => {
    write({ active: false, percent: 50, testStop: 97 })
    expect(isParkedByHardStop('qa', readHardStop(p()))).toBe(false)
  })

  it('matches the agent id case-insensitively (a config typo must not un-exempt MikroB)', () => {
    expect(isParkedByHardStop('MikroB', active())).toBe(false)
  })
})
