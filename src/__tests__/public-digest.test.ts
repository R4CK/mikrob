// Trust-boundary tests for the UNAUTH public digest (card 5a57ba16 / F2). This endpoint is
// reachable without the dashboard Bearer, so the contract is: ONLY non-identifying aggregate
// status (counts + version) -- never agent names/ids, paths, tokens, PII, or topology. These
// assert the payload SHAPE so a future edit that adds a leaky field fails here.
import { describe, it, expect } from 'vitest'
import { buildPublicDigest } from '../web/routes/public-digest.js'

describe('buildPublicDigest -- no topology leak', () => {
  it('returns ONLY the whitelisted aggregate fields', () => {
    const d = buildPublicDigest(1784913893000)
    expect(Object.keys(d).sort()).toEqual(['agents', 'checkedAt', 'name', 'ok', 'version'])
    expect(Object.keys(d.agents).sort()).toEqual(['running', 'total'])
    expect(d.ok).toBe(true)
    expect(typeof d.version).toBe('string')
    expect(typeof d.name).toBe('string')
    expect(d.checkedAt).toBe(1784913893000)
  })

  it('agents is a pure numeric COUNT object -- never an array of names/ids', () => {
    const d = buildPublicDigest(0)
    expect(Array.isArray(d.agents)).toBe(false)
    for (const v of Object.values(d.agents)) expect(typeof v).toBe('number')
    // The whole payload must carry no obvious topology / secret markers.
    expect(JSON.stringify(d)).not.toMatch(/"roles?"|"path"|"token"|"agentId"|"reports|"userId"/i)
  })

  it('running <= total, both >= 1 (the main agent is always counted)', () => {
    const d = buildPublicDigest(0)
    expect(d.agents.total).toBeGreaterThanOrEqual(1)
    expect(d.agents.running).toBeGreaterThanOrEqual(1)
    expect(d.agents.running).toBeLessThanOrEqual(d.agents.total)
  })
})
