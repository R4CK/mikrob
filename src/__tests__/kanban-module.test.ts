// String-contract guard for app.js modularisation slice 30:
// Kanban board, Drag & Drop, and Card modals moved to app-kanban.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),       'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-kanban.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),   'utf-8')

describe('kanban modularisation: app-kanban.js is the owner', () => {
  it('loadKanban lives in the module', () => {
    expect(MODULE).toContain('async function loadKanban(')
  })

  it('renderKanban lives in the module', () => {
    expect(MODULE).toContain('function renderKanban(')
  })

  it('kanbanCards state variable is in the module', () => {
    expect(MODULE).toContain('let kanbanCards = []')
  })

  it('drag & drop logic is in the module', () => {
    expect(MODULE).toContain('dragover')
  })

  it('card detail section is in the module', () => {
    expect(MODULE).toContain('cardDetailOverlay')
  })
})

describe('kanban modularisation: app.js delegates, does not define', () => {
  it('loadKanban is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadKanban\(/m)
  })

  it('kanbanCards is not declared in app.js', () => {
    expect(APP).not.toContain('let kanbanCards = []')
  })
})

describe('kanban modularisation: index.html wiring', () => {
  it('index.html loads app-kanban.js', () => {
    expect(HTML).toContain('src="/app-kanban.js"')
  })

  it('app-kanban.js loads before app-modals.js (which it may depend on at call time)', () => {
    const kanbanIdx = HTML.indexOf('src="/app-kanban.js"')
    const modalsIdx = HTML.indexOf('src="/app-modals.js"')
    expect(kanbanIdx).toBeGreaterThan(-1)
    expect(modalsIdx).toBeGreaterThan(kanbanIdx)
  })

  it('app-kanban.js loads before fork-updates.js', () => {
    const kanbanIdx = HTML.indexOf('src="/app-kanban.js"')
    const forkIdx   = HTML.indexOf('src="/fork-updates.js"')
    expect(kanbanIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(kanbanIdx)
  })
})
