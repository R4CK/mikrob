// String-contract guard for app.js modularisation slice 22:
// Per-agent Skills tab (Agent Detail modal) moved to app-skills-detail.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),               'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-skills-detail.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),           'utf-8')

describe('skills-detail modularisation: app-skills-detail.js is the owner', () => {
  it('loadSkills lives in app-skills-detail.js', () => {
    expect(MODULE).toContain('async function loadSkills(')
  })

  it('addSkillBtn handler lives in app-skills-detail.js', () => {
    expect(MODULE).toContain("document.getElementById('addSkillBtn')")
  })

  it('saveSkillBtn handler lives in app-skills-detail.js', () => {
    expect(MODULE).toContain("document.getElementById('saveSkillBtn')")
  })

  it('importSkillBtn handler lives in app-skills-detail.js', () => {
    expect(MODULE).toContain("document.getElementById('importSkillBtn')")
  })

  it('app-skills-detail.js fetches /api/agents/.../skills', () => {
    expect(MODULE).toContain('/skills')
  })

  it('app-skills-detail.js has skill tab switching logic', () => {
    expect(MODULE).toContain('.skill-tab-btn')
  })
})

describe('skills-detail modularisation: app.js delegates, does not define', () => {
  it('loadSkills is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadSkills\(/m)
  })

  it('skills-detail stub is in place in app.js', () => {
    expect(APP).toContain('see web/app-skills-detail.js')
  })
})

describe('skills-detail modularisation: index.html wiring', () => {
  it('index.html loads app-skills-detail.js', () => {
    expect(HTML).toContain('src="/app-skills-detail.js"')
  })

  it('app-skills-detail.js loads after app-skills.js', () => {
    const skillsIdx  = HTML.indexOf('src="/app-skills.js"')
    const detailIdx  = HTML.indexOf('src="/app-skills-detail.js"')
    expect(skillsIdx).toBeGreaterThan(-1)
    expect(detailIdx).toBeGreaterThan(skillsIdx)
  })

  it('app-skills-detail.js loads before fork-updates.js', () => {
    const detailIdx = HTML.indexOf('src="/app-skills-detail.js"')
    const forkIdx   = HTML.indexOf('src="/fork-updates.js"')
    expect(detailIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(detailIdx)
  })
})
