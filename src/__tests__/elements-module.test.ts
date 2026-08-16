// String-contract guard for app.js modularisation slice 38:
// Core element globals + modal helpers + avatar gallery moved to app-elements.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),         'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-elements.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),     'utf-8')

describe('elements modularisation: app-elements.js is the owner', () => {
  it('openModal lives in the module', () => {
    expect(MODULE).toContain('function openModal(')
  })

  it('closeModal lives in the module', () => {
    expect(MODULE).toContain('function closeModal(')
  })

  it('agentsGrid declaration is in the module', () => {
    expect(MODULE).toContain("document.getElementById('agentsGrid')")
  })

  it('AVATARS declaration is in the module', () => {
    expect(MODULE).toContain('const AVATARS =')
  })

  it('populateAvatarGrid lives in the module', () => {
    expect(MODULE).toContain('function populateAvatarGrid(')
  })

  it('currentAgent variable is in the module', () => {
    expect(MODULE).toContain('let currentAgent =')
  })
})

describe('elements modularisation: app.js delegates, does not define', () => {
  it('openModal is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function openModal\(/m)
  })

  it('closeModal is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function closeModal\(/m)
  })

  it('AVATARS is not defined in app.js', () => {
    expect(APP).not.toMatch(/^const AVATARS =/m)
  })
})

describe('elements modularisation: index.html wiring', () => {
  it('index.html loads app-elements.js', () => {
    expect(HTML).toContain('src="/app-elements.js"')
  })

  it('app-elements.js loads right after app.js (before app-kanban.js)', () => {
    const elemIdx   = HTML.indexOf('src="/app-elements.js"')
    const kanbanIdx = HTML.indexOf('src="/app-kanban.js"')
    const appIdx    = HTML.indexOf('src="/app.js"')
    expect(elemIdx).toBeGreaterThan(-1)
    expect(elemIdx).toBeGreaterThan(appIdx)
    expect(elemIdx).toBeLessThan(kanbanIdx)
  })

  it('app-elements.js loads before fork-updates.js', () => {
    const elemIdx = HTML.indexOf('src="/app-elements.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(elemIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(elemIdx)
  })
})
