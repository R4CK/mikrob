// String-contract guard for card c4325698: app.js modularisation slice 2 -- LocalLLM page.
// Verifies that the extraction is structurally correct:
//   - app-local-llm.js contains the key public functions
//   - app.js contains the stub comment (NOT the original code)
//   - index.html loads app-local-llm.js after app-conversation.js and before fork-updates.js
//   - switchPage() call sites in app.js still reference loadLocalLlm / stopLocalLlmPoll
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP     = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const MODULE  = readFileSync(join(__dirname, '../../web/app-local-llm.js'), 'utf-8')
const HTML    = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('local-llm-module: app-local-llm.js contains key functions', () => {
  it('contains loadLocalLlm (main entry point)', () => {
    expect(MODULE).toContain('async function loadLocalLlm(')
  })

  it('contains stopLocalLlmPoll (called from switchPage on page leave)', () => {
    expect(MODULE).toContain('function stopLocalLlmPoll(')
  })

  it('contains llmLoadOffload', () => {
    expect(MODULE).toContain('async function llmLoadOffload(')
  })

  it('contains llmSetupOffload', () => {
    expect(MODULE).toContain('function llmSetupOffload(')
  })

  it('contains loadStatus (status tab inside LocalLLM page)', () => {
    expect(MODULE).toContain('async function loadStatus(')
  })

  it('contains _llmPollTimer state variable', () => {
    expect(MODULE).toContain('let _llmPollTimer')
  })

  it('has header comment explaining loading order', () => {
    expect(MODULE).toContain('app-local-llm.js')
    expect(MODULE).toContain('app.js')
  })
})

describe('local-llm-module: app.js contains stub, NOT original code', () => {
  it('app.js has stub comment for the LLM section', () => {
    expect(APP).toContain('app-local-llm.js')
    expect(APP).toContain('modularisation')
  })

  it('app.js does NOT contain loadLocalLlm function body (moved to module)', () => {
    expect(APP).not.toContain('async function loadLocalLlm(')
  })

  it('app.js does NOT contain stopLocalLlmPoll function body (moved to module)', () => {
    expect(APP).not.toContain('function stopLocalLlmPoll(')
  })

  it('app.js does NOT contain _llmPollTimer declaration (moved to module)', () => {
    expect(APP).not.toContain('let _llmPollTimer')
  })

  it('app.js still calls loadLocalLlm from switchPage (call site preserved)', () => {
    expect(APP).toContain('loadLocalLlm()')
  })

  it('app.js still calls stopLocalLlmPoll from switchPage (call site preserved)', () => {
    expect(APP).toContain('stopLocalLlmPoll()')
  })
})

describe('local-llm-module: index.html loading order', () => {
  it('loads app-local-llm.js as a script tag', () => {
    expect(HTML).toContain('src="/app-local-llm.js"')
  })

  it('loads app-local-llm.js after app-conversation.js', () => {
    const convIdx = HTML.indexOf('src="/app-conversation.js"')
    const llmIdx  = HTML.indexOf('src="/app-local-llm.js"')
    expect(llmIdx).toBeGreaterThan(convIdx)
  })

  it('loads app-local-llm.js before fork-updates.js', () => {
    const llmIdx  = HTML.indexOf('src="/app-local-llm.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(llmIdx).toBeLessThan(forkIdx)
  })
})
