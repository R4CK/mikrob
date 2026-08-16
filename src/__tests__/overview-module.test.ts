// String-contract guard for app.js modularisation slice 16:
// Overview page + live local-LLM utilization spectrum moved to app-overview.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),          'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-overview.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),      'utf-8')

describe('overview modularisation: app-overview.js is the owner', () => {
  it('loadOverview lives in app-overview.js', () => {
    expect(MODULE).toContain('async function loadOverview(')
  })

  it('app-overview.js self-initialises (calls loadOverview at module bottom)', () => {
    // The call must appear AFTER the function definitions, so it resolves correctly
    const fnIdx   = MODULE.indexOf('async function loadOverview(')
    const callIdx = MODULE.lastIndexOf('loadOverview()')
    expect(fnIdx).toBeGreaterThan(-1)
    expect(callIdx).toBeGreaterThan(fnIdx)
  })

  it('LLM spectrum canvas setup lives in app-overview.js', () => {
    expect(MODULE).toContain('ovwSpectrumCanvas')
  })

  it('formatRelative lives in app-overview.js', () => {
    expect(MODULE).toContain('function formatRelative(')
  })

  it('PWA viewport lock statement is in app-overview.js', () => {
    expect(MODULE).toContain('display-mode: standalone')
  })
})

describe('overview modularisation: app.js delegates, does not define', () => {
  it('loadOverview is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadOverview\(/m)
  })

  it('loadOverview() call removed from app.js Init (self-init in module)', () => {
    // The Init section's direct call is replaced by a comment
    expect(APP).toContain('loadOverview() -- called by app-overview.js')
  })

  it('formatRelative is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function formatRelative\(/m)
  })
})

describe('overview modularisation: index.html wiring', () => {
  it('index.html loads app-overview.js', () => {
    expect(HTML).toContain('src="/app-overview.js"')
  })

  it('app-overview.js loads after app-archive-timeline.js', () => {
    const archiveIdx  = HTML.indexOf('src="/app-archive-timeline.js"')
    const overviewIdx = HTML.indexOf('src="/app-overview.js"')
    expect(archiveIdx).toBeGreaterThan(-1)
    expect(overviewIdx).toBeGreaterThan(archiveIdx)
  })

  it('app-overview.js loads before fork-updates.js', () => {
    const overviewIdx = HTML.indexOf('src="/app-overview.js"')
    const forkIdx     = HTML.indexOf('src="/fork-updates.js"')
    expect(overviewIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(overviewIdx)
  })
})
