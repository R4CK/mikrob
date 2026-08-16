// String-contract guard for app.js modularisation slice 9 (card 7ee1e236):
// Messages page section moved to app-messages.js.
// House idiom: source files read as strings, asserted against short formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const MODULE = readFileSync(join(__dirname, '../../web/app-messages.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('messages modularisation: app-messages.js is the owner', () => {
  it('loadMessagesPage lives in app-messages.js', () => {
    expect(MODULE).toContain('async function loadMessagesPage()')
  })

  it('loadChatAgentList lives in app-messages.js', () => {
    expect(MODULE).toContain('async function loadChatAgentList()')
  })

  it('loadChatThread lives in app-messages.js', () => {
    expect(MODULE).toContain('async function loadChatThread(')
  })

  it('buildBubbleHtml lives in app-messages.js', () => {
    expect(MODULE).toContain('function buildBubbleHtml(')
  })

  it('chatDisplayName lives in app-messages.js', () => {
    expect(MODULE).toContain('function chatDisplayName(')
  })

  it('chatAgentHasAvatar state lives in app-messages.js', () => {
    expect(MODULE).toContain('const chatAgentHasAvatar = new Map()')
  })

  it('CHAT_SYSTEM_AGENTS lives in app-messages.js', () => {
    expect(MODULE).toContain("const CHAT_SYSTEM_AGENTS = new Set(")
  })
})

describe('messages modularisation: app.js delegates, does not define', () => {
  it('loadMessagesPage is not defined in app.js (only called at switchPage)', () => {
    expect(APP).not.toMatch(/^async function loadMessagesPage\(\)/m)
  })

  it('chatAgentHasAvatar is not declared in app.js', () => {
    expect(APP).not.toContain('const chatAgentHasAvatar = new Map()')
  })

  it('chatDisplayName is not defined in app.js', () => {
    expect(APP).not.toMatch(/^function chatDisplayName\(/m)
  })
})

describe('messages modularisation: index.html wiring', () => {
  it('index.html loads app-messages.js', () => {
    expect(HTML).toContain('src="/app-messages.js"')
  })

  it('app-messages.js loads after app-recall.js', () => {
    const recallIdx = HTML.indexOf('src="/app-recall.js"')
    const messagesIdx = HTML.indexOf('src="/app-messages.js"')
    expect(recallIdx).toBeGreaterThan(-1)
    expect(messagesIdx).toBeGreaterThan(recallIdx)
  })

  it('app-messages.js loads before fork-updates.js', () => {
    const messagesIdx = HTML.indexOf('src="/app-messages.js"')
    const forkIdx = HTML.indexOf('src="/fork-updates.js"')
    expect(messagesIdx).toBeGreaterThan(-1)
    expect(forkIdx).toBeGreaterThan(messagesIdx)
  })
})
