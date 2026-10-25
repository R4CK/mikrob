// The Activity card picks its badge through activityDisplayState() in
// web/app-activity.js: an idle main thread with running background agents
// shows as 'subagents', a working main thread always wins. The function is
// evaluated OUT OF the shipped web/app-activity.js (as
// kanban-owner-filter-accents.test.ts does against web/app-kanban.js), so a
// copy in the test cannot keep passing after the shipped code changed. This
// is the activity module's slice after the monolithic web/app.js ->
// web/app-*.js split (card 4f5e43e6 porting note); it never lived in app.js
// in this fork.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app-activity.js'), 'utf-8')

type Entry = { state: string; bgAgents: { total: number; running: number; queued: number } | null } | null

function loadActivityDisplayState(): (entry: Entry) => string {
  const m = APP.match(/function activityDisplayState\(entry\) \{[\s\S]*?\n\}/)
  // A missing function must fail the test, not quietly produce a stub.
  if (!m) throw new Error('activityDisplayState() not found in web/app-activity.js')
  return new Function(`${m[0]}; return activityDisplayState`)() as (entry: Entry) => string
}

const bg = (running: number, queued = 0) => ({ total: running, running, queued })

describe('activityDisplayState', () => {
  const show = loadActivityDisplayState()

  it('idle main thread with running background agents shows as subagents', () => {
    expect(show({ state: 'idle', bgAgents: bg(1) })).toBe('subagents')
    expect(show({ state: 'idle', bgAgents: bg(3, 2) })).toBe('subagents')
  })

  it('a working main thread wins over running background agents', () => {
    expect(show({ state: 'working', bgAgents: bg(2) })).toBe('working')
  })

  it('idle with no block, or a block with nothing running, stays idle', () => {
    expect(show({ state: 'idle', bgAgents: null })).toBe('idle')
    expect(show({ state: 'idle', bgAgents: { total: 1, running: 0, queued: 1 } })).toBe('idle')
  })

  it('unknown and error keep their own state', () => {
    expect(show({ state: 'unknown', bgAgents: bg(1) })).toBe('unknown')
    expect(show({ state: 'error', bgAgents: bg(1) })).toBe('error')
  })

  it('a missing entry reads unknown', () => {
    expect(show(null)).toBe('unknown')
  })
})

describe('activityDisplayState wiring', () => {
  it('the subagents state has display meta, and the card render goes through the function', () => {
    expect(APP).toMatch(/\n  subagents: \{/)
    // One call site in this fork: renderActivity rebuilds the whole list each
    // poll (no separate card-patching function like upstream's
    // refreshAgentTerminalBusy), so there is exactly one place that picks the
    // badge/border meta.
    expect(APP.split('ACTIVITY_STATE_META[activityDisplayState(a)]').length - 1).toBe(1)
  })
})
