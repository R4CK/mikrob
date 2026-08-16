// String-contract guard for app.js modularisation slice 10 (card 7a2a7ef3):
// Skills Page section moved to app-skills.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-skills.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('skills modularisation: app-skills.js is the owner', () => {
  it('loadGlobalSkills lives in app-skills.js', () => {
    expect(MODULE).toContain('async function loadGlobalSkills()')
  })

  it('deriveSkillCategory lives in app-skills.js', () => {
    expect(MODULE).toContain('function deriveSkillCategory(')
  })

  it('filterAndRenderSkills or renderSkillCard lives in app-skills.js', () => {
    expect(MODULE.includes('function filterAndRenderSkills') || MODULE.includes('function renderSkillCard')).toBe(true)
  })

  it('globalSkills state lives in app-skills.js', () => {
    expect(MODULE).toContain('let globalSkills = []')
  })

  it('skillsActiveFilter state lives in app-skills.js', () => {
    expect(MODULE).toContain("let skillsActiveFilter = 'all'")
  })
})

describe('skills modularisation: app.js delegates, does not define', () => {
  it('loadGlobalSkills is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadGlobalSkills\(\)/m)
  })

  it('globalSkills is not declared in app.js', () => {
    expect(APP).not.toContain('let globalSkills = []')
  })
})

describe('skills modularisation: index.html wiring', () => {
  it('index.html loads app-skills.js', () => {
    expect(HTML).toContain('src="/app-skills.js"')
  })

  it('app-skills.js loads after app-messages.js', () => {
    const messagesIdx = HTML.indexOf('src="/app-messages.js"')
    const skillsIdx = HTML.indexOf('src="/app-skills.js"')
    expect(messagesIdx).toBeGreaterThan(-1)
    expect(skillsIdx).toBeGreaterThan(messagesIdx)
  })

  it('app-skills.js loads before fork-updates.js', () => {
    const skillsIdx = HTML.indexOf('src="/app-skills.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(skillsIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(skillsIdx)
  })
})
