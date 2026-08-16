// String-contract guard for app.js modularisation slice 18:
// Agent reauth login flow + Agent terminal modal moved to app-terminal.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP    = readFileSync(join(__dirname, '../../web/app.js'),          'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-terminal.js'), 'utf-8')
const HTML   = readFileSync(join(__dirname, '../../web/index.html'),      'utf-8')

describe('terminal modularisation: app-terminal.js is the owner', () => {
  it('handleAgentLogin lives in app-terminal.js', () => {
    expect(MODULE).toContain('async function handleAgentLogin(')
  })

  it('terminalInstance state lives in app-terminal.js', () => {
    expect(MODULE).toContain('let terminalInstance = null')
  })

  it('terminalSSE state lives in app-terminal.js', () => {
    expect(MODULE).toContain('let terminalSSE = null')
  })

  it('terminal section opens via openModal in app-terminal.js', () => {
    expect(MODULE).toContain('openModal(overlay)')
  })

  it('terminal section closes via closeModal in app-terminal.js', () => {
    expect(MODULE).toContain('closeModal(overlay)')
  })
})

describe('terminal modularisation: app.js delegates, does not define', () => {
  it('handleAgentLogin is not defined in app.js', () => {
    expect(APP).not.toMatch(/^async function handleAgentLogin\(/m)
  })

  it('terminalInstance is not declared in app.js', () => {
    expect(APP).not.toContain('let terminalInstance = null')
  })

  it('terminal stub is in place in app.js', () => {
    expect(APP).toContain('see web/app-terminal.js')
  })
})

describe('terminal modularisation: index.html wiring', () => {
  it('index.html loads app-terminal.js', () => {
    expect(HTML).toContain('src="/app-terminal.js"')
  })

  it('app-terminal.js loads after app-autonomy.js', () => {
    const autonomyIdx  = HTML.indexOf('src="/app-autonomy.js"')
    const terminalIdx  = HTML.indexOf('src="/app-terminal.js"')
    expect(autonomyIdx).toBeGreaterThan(-1)
    expect(terminalIdx).toBeGreaterThan(autonomyIdx)
  })

  it('app-terminal.js loads before fork-updates.js', () => {
    const terminalIdx = HTML.indexOf('src="/app-terminal.js"')
    const forkIdx     = HTML.indexOf('src="/fork-updates.js"')
    expect(terminalIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(terminalIdx)
  })
})
