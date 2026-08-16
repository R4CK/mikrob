// String-contract guard for app.js modularisation slice 37:
// Collapsible sidebar groups moved to app-sidebar-groups.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),              'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-sidebar-groups.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),          'utf-8')

describe('sidebar-groups modularisation: app-sidebar-groups.js is the owner', () => {
  it('openSidebarGroupForPage lives in the module', () => {
    expect(MODULE).toContain('function openSidebarGroupForPage(')
  })

  it('setSidebarGroupOpen lives in the module', () => {
    expect(MODULE).toContain('function setSidebarGroupOpen(')
  })

  it('SIDEBAR_GROUPS definition lives in the module', () => {
    expect(MODULE).toContain('const SIDEBAR_GROUPS =')
  })

  it('PAGE_SIDEBAR_GROUP lives in the module', () => {
    expect(MODULE).toContain('PAGE_SIDEBAR_GROUP')
  })
})

describe('sidebar-groups modularisation: app.js delegates, does not define', () => {
  it('openSidebarGroupForPage is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function openSidebarGroupForPage\(/m)
  })

  it('SIDEBAR_GROUPS is not defined in app.js', () => {
    expect(APP).not.toMatch(/^const SIDEBAR_GROUPS =/m)
  })
})

describe('sidebar-groups modularisation: index.html wiring', () => {
  it('index.html loads app-sidebar-groups.js', () => {
    expect(HTML).toContain('src="/app-sidebar-groups.js"')
  })

  it('app-sidebar-groups.js loads before fork-updates.js', () => {
    const grpIdx  = HTML.indexOf('src="/app-sidebar-groups.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(grpIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(grpIdx)
  })
})
