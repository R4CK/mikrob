// String-contract guard for app.js modularisation slice 15:
// Archived cards + Naplo (Audit Timeline) + Kanban Gantt moved to app-archive-timeline.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),                  'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-archive-timeline.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),              'utf-8')

describe('archive-timeline modularisation: app-archive-timeline.js is the owner', () => {
  it('archived cards IIFE lives in app-archive-timeline.js', () => {
    expect(MODULE).toContain('let archivedInit = false')
  })

  it('naploInitialized state lives in app-archive-timeline.js', () => {
    expect(MODULE).toContain('let naploInitialized = false')
  })

  it('renderGantt lives in app-archive-timeline.js', () => {
    expect(MODULE).toContain('window.renderGantt = renderGantt')
  })

  it('Gantt IIFE exposes initGanttViewSwitcher via window', () => {
    expect(MODULE).toContain('window._initGanttViewSwitcher = initGanttViewSwitcher')
  })

  it('naploActiveSource state lives in app-archive-timeline.js', () => {
    expect(MODULE).toContain("let naploActiveSource = ''")
  })
})

describe('archive-timeline modularisation: app.js delegates, does not define', () => {
  it('archivedInit is not defined in app.js', () => {
    expect(APP).not.toContain('let archivedInit = false')
  })

  it('naploInitialized is not defined in app.js', () => {
    expect(APP).not.toContain('let naploInitialized = false')
  })

  it('renderGantt window export is not in app.js', () => {
    expect(APP).not.toContain('window.renderGantt = renderGantt')
  })
})

describe('archive-timeline modularisation: index.html wiring', () => {
  it('index.html loads app-archive-timeline.js', () => {
    expect(HTML).toContain('src="/app-archive-timeline.js"')
  })

  it('app-archive-timeline.js loads after app-docs.js', () => {
    const docsIdx    = HTML.indexOf('src="/app-docs.js"')
    const archiveIdx = HTML.indexOf('src="/app-archive-timeline.js"')
    expect(docsIdx).toBeGreaterThan(-1)
    expect(archiveIdx).toBeGreaterThan(docsIdx)
  })

  it('app-archive-timeline.js loads before fork-updates.js', () => {
    const archiveIdx = HTML.indexOf('src="/app-archive-timeline.js"')
    const forkIdx    = HTML.indexOf('src="/fork-updates.js"')
    expect(archiveIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(archiveIdx)
  })
})
