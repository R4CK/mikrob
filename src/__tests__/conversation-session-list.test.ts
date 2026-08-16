// String-contract guard for card 03d2ae9c: session-list replay in the
// conversation modal. House idiom: source files read as strings, asserted
// against short, formatting-proof fragments -- no DOM/runtime needed.
//
// Key contracts:
//   - GET /api/agents/:agent/sessions fetched when modal opens; selector hidden on 404/error
//   - Session dropdown hidden by default (hidden attr); shown only when sessions exist
//   - Selecting a session passes ?sessionId= to the conversation endpoint
//   - loadOlderConversation also passes sessionId for consistent pagination
//   - Graceful fallback: 404 on /sessions hides the selector, chat loads normally
//   - i18n parity: all new keys in both hu.js and en.js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Conversation modal was extracted to app-conversation.js (card b33fc5f7).
// Reading the new module file; the stub comment left in app.js is intentional
// and prevents old tests that still read app.js from false-passing.
const APP = readFileSync(join(__dirname, '../../web/app-conversation.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

function fnBody(source: string, startMarker: string, maxLen = 6000): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nfunction ', start + startMarker.length)
  const nextAsyncFn = source.indexOf('\nasync function ', start + startMarker.length)
  const candidates = [nextFn, nextAsyncFn].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + maxLen
  return source.slice(start, end)
}

describe('conversation-session-list: state variables', () => {
  it('declares conversationCurrentSessionId state variable', () => {
    expect(APP).toContain('let conversationCurrentSessionId')
  })

  it('declares conversationSessions state variable', () => {
    expect(APP).toContain('let conversationSessions')
  })

  it('resets both on modal open', () => {
    const body = fnBody(APP, 'async function openConversationModal(')
    expect(body).toContain('conversationCurrentSessionId = null')
    expect(body).toContain('conversationSessions = []')
  })
})

describe('conversation-session-list: loadConversationSessions', () => {
  it('fetches /api/agents/:agent/sessions', () => {
    const body = fnBody(APP, 'async function loadConversationSessions(')
    expect(body).toContain('/api/agents/')
    expect(body).toContain('/sessions')
  })

  it('hides the row on non-ok response (graceful fallback for 404)', () => {
    const body = fnBody(APP, 'async function loadConversationSessions(')
    expect(body).toContain('row.hidden = true')
    expect(body).toContain('!r.ok')
  })

  it('hides the row when sessions array is empty', () => {
    const body = fnBody(APP, 'async function loadConversationSessions(')
    expect(body).toContain('!sessions.length')
    // After the empty check, the row is hidden
    const emptyIdx = body.indexOf('!sessions.length')
    const hideAfter = body.indexOf('row.hidden = true', emptyIdx)
    expect(hideAfter).toBeGreaterThan(emptyIdx)
  })

  it('shows the row and populates options when sessions exist', () => {
    const body = fnBody(APP, 'async function loadConversationSessions(')
    expect(body).toContain('row.hidden = false')
    expect(body).toContain('sel.innerHTML')
    expect(body).toContain('session_newest')
  })

  it('hides the row on catch (network error)', () => {
    const body = fnBody(APP, 'async function loadConversationSessions(')
    const catchIdx = body.indexOf('} catch {')
    expect(catchIdx).toBeGreaterThan(-1)
    const hideInCatch = body.indexOf('row.hidden = true', catchIdx)
    expect(hideInCatch).toBeGreaterThan(catchIdx)
  })

  it('uses session_entries i18n key for entry count', () => {
    const body = fnBody(APP, 'async function loadConversationSessions(')
    expect(body).toContain("session_entries")
  })
})

describe('conversation-session-list: loadConversation passes sessionId', () => {
  it('includes sessionId param when conversationCurrentSessionId is set', () => {
    const body = fnBody(APP, 'async function loadConversation(')
    expect(body).toContain('sessionParam')
    expect(body).toContain('sessionId=')
    expect(body).toContain('conversationCurrentSessionId')
  })

  it('omits sessionId param when conversationCurrentSessionId is null (newest)', () => {
    const body = fnBody(APP, 'async function loadConversation(')
    // The ternary produces empty string when null
    expect(body).toContain("conversationCurrentSessionId ? ")
    expect(body).toMatch(/\?\s*`[^`]*sessionId[^`]*`\s*:\s*''/)
  })
})

describe('conversation-session-list: loadOlderConversation passes sessionId', () => {
  it('also passes sessionId for consistent pagination when paging further back', () => {
    const body = fnBody(APP, 'async function loadOlderConversation(')
    expect(body).toContain('sessionParam')
    expect(body).toContain('sessionId=')
  })
})

describe('conversation-session-list: session select change handler', () => {
  it('updates conversationCurrentSessionId on change', () => {
    // The change listener is wired after all function definitions; find the
    // addEventListener call site, not the const-sel inside loadConversationSessions.
    const listenerIdx = APP.indexOf("getElementById('conversationSessionSelect')?.addEventListener('change'")
    expect(listenerIdx).toBeGreaterThan(-1)
    const handlerSlice = APP.slice(listenerIdx, listenerIdx + 400)
    expect(handlerSlice).toContain('conversationCurrentSessionId')
    expect(handlerSlice).toContain('loadConversation()')
  })
})

describe('conversation-session-list: HTML', () => {
  it('session row is hidden by default', () => {
    expect(HTML).toContain('id="conversationSessionRow"')
    const rowIdx = HTML.indexOf('id="conversationSessionRow"')
    const rowTag = HTML.slice(rowIdx - 20, rowIdx + 80)
    expect(rowTag).toContain('hidden')
  })

  it('session select element exists with correct id', () => {
    expect(HTML).toContain('id="conversationSessionSelect"')
  })

  it('session row is inside the conversation toolbar', () => {
    const toolbarIdx = HTML.indexOf('class="conversation-toolbar"')
    const rowIdx = HTML.indexOf('id="conversationSessionRow"', toolbarIdx)
    const toolbarEnd = HTML.indexOf('</div>', toolbarIdx + 200)
    expect(rowIdx).toBeGreaterThan(toolbarIdx)
    expect(rowIdx).toBeLessThan(toolbarEnd + 2000)
  })
})

describe('conversation-session-list: CSS', () => {
  it('defines .conversation-session-row with hidden override', () => {
    expect(CSS).toContain('.conversation-session-row')
    expect(CSS).toContain('.conversation-session-row[hidden]')
  })

  it('defines .conversation-session-select', () => {
    expect(CSS).toContain('.conversation-session-select')
  })

  it('has responsive breakpoint for narrow screens', () => {
    const idx = CSS.indexOf('.conversation-session-row')
    const mediaIdx = CSS.indexOf('@media (max-width', idx)
    expect(mediaIdx).toBeGreaterThan(idx)
  })
})

describe('conversation-session-list: i18n parity', () => {
  const keys = [
    'conversation.session_label',
    'conversation.session_newest',
    'conversation.session_entries',
    'conversation.sessions_error',
  ]
  for (const key of keys) {
    it(`"${key}" exists in both hu.js and en.js`, () => {
      expect(HU).toContain(`'${key}'`)
      expect(EN).toContain(`'${key}'`)
    })
  }
})
