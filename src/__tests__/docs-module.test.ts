// String-contract guard for app.js modularisation slice 14:
// Docs viewer + Research viewer + Mobile login moved to app-docs.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),      'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-docs.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),  'utf-8')

describe('docs modularisation: app-docs.js is the owner', () => {
  it('renderMarkdown lives in app-docs.js', () => {
    expect(MODULE).toContain('function renderMarkdown(')
  })

  it('escapeAttr lives in app-docs.js', () => {
    expect(MODULE).toContain('function escapeAttr(')
  })

  it('loadDocs lives in app-docs.js', () => {
    expect(MODULE).toContain('async function loadDocs()')
  })

  it('loadResearch lives in app-docs.js', () => {
    expect(MODULE).toContain('async function loadResearch()')
  })

  it('setupMobileLogin IIFE lives in app-docs.js', () => {
    expect(MODULE).toContain('function setupMobileLogin(')
  })
})

describe('docs modularisation: app.js delegates, does not define', () => {
  it('renderMarkdown is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function renderMarkdown\b/m)
  })

  it('loadDocs is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadDocs\(\)/m)
  })

  it('loadResearch is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function loadResearch\(\)/m)
  })
})

describe('docs modularisation: index.html wiring', () => {
  it('index.html loads app-docs.js', () => {
    expect(HTML).toContain('src="/app-docs.js"')
  })

  it('app-docs.js loads after app-federation.js', () => {
    const fedIdx  = HTML.indexOf('src="/app-federation.js"')
    const docsIdx = HTML.indexOf('src="/app-docs.js"')
    expect(fedIdx).toBeGreaterThan(-1)
    expect(docsIdx).toBeGreaterThan(fedIdx)
  })

  it('app-docs.js loads before fork-updates.js', () => {
    const docsIdx = HTML.indexOf('src="/app-docs.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(docsIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(docsIdx)
  })
})
