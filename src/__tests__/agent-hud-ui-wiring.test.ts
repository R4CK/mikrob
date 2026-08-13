// String-contract guard for the per-agent live HUD strip (kanban f07c5b7c, BE sibling
// e9504aba). Follows the house idiom (see project-priority-ui-wiring.test.ts): app.js is
// a single global script with no module boundary, so the frontend files are read as
// strings and asserted against short, formatting-proof fragments.
//
// Scope note: this covers the part that shipped in this pass -- context-pct bar +
// active-model line, both sourced from ALREADY-EXISTING endpoints (GET /api/context-guard,
// GET /api/agents). Active-tool + running-sub-agent are NOT covered here: BE (e9504aba)
// had not yet exposed a consolidated read endpoint for those signals at the time this
// landed, and the binding constraint on the card (no tool arguments, no transcript quotes)
// applies to the endpoint response, not the FE -- FE only renders whatever derived fields
// that endpoint returns once it exists.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

function fnBody(source: string, startMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nfunction ', start + startMarker.length)
  const nextAsyncFn = source.indexOf('\nasync function ', start + startMarker.length)
  const candidates = [nextFn, nextAsyncFn].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + 4000
  return source.slice(start, end)
}

describe('per-agent HUD shell (agentHudBlockHtml)', () => {
  it('keys the HUD block on the agent id, for later DOM lookup by the poller', () => {
    expect(APP).toContain('function agentHudBlockHtml(hudKey, activeModel)')
    const body = fnBody(APP, 'function agentHudBlockHtml(hudKey, activeModel)')
    expect(body).toContain('data-hud-agent="${escapeHtml(hudKey)}"')
  })

  it('is only inserted for RUNNING sub-agent cards, not stopped ones', () => {
    const anchor = '${isRunning ? agentHudBlockHtml(agent.name, agent.activeModel) : \'\'}'
    expect(APP).toContain(anchor)
  })

  it('is inserted into the marveen (main-agent) card too, keyed by mainAgentId()', () => {
    expect(APP).toContain("${agentHudBlockHtml(mainAgentId(), null)}")
  })

  it('the active-model line is escaped, matching the existing model-badge convention', () => {
    const body = fnBody(APP, 'function agentHudBlockHtml(hudKey, activeModel)')
    expect(body).toMatch(/escapeHtml\(t\('agents\.hud\.active_model'/)
  })
})

describe('per-agent HUD live poll (refreshAgentHud)', () => {
  it('reads the ALREADY-EXISTING context-guard endpoint -- no new backend route', () => {
    expect(APP).toContain('async function refreshAgentHud()')
    const body = fnBody(APP, 'async function refreshAgentHud()')
    expect(body).toContain("fetch('/api/context-guard')")
  })

  it('is polled on the same cadence as the existing busy-poll, not a second new interval', () => {
    const body = fnBody(APP, 'function startAgentsBusyPoll()')
    expect(body).toContain('refreshAgentHud()')
    expect(body).toMatch(/setInterval\(\(\) => \{ refreshAgentTerminalBusy\(\); refreshAgentHud\(\) \}, 3000\)/)
  })

  it('shows the disabled label instead of a bar when context-guard is opt-in-off for that agent (pct is not always a number)', () => {
    const body = fnBody(APP, 'async function refreshAgentHud()')
    expect(body).toContain('entry.enabled && typeof entry.pct === \'number\'')
    expect(body).toContain('disabledLabel.hidden = false')
  })

  it('color-codes the bar at 70% and 90%, reusing existing CSS tokens (no invented thresholds)', () => {
    const body = fnBody(APP, 'async function refreshAgentHud()')
    expect(body).toContain('pct >= 70 && pct < 90')
    expect(body).toContain('pct >= 90')
  })

  it('keeps the LAST GOOD value on a failed fetch, and never shows a raw error (rule 12)', () => {
    const body = fnBody(APP, 'async function refreshAgentHud()')
    expect(body).toContain('if (!res.ok) return')
    expect(body).toContain('catch { return }')
    expect(body).not.toMatch(/err\.message/)
  })

  it('surfaces staleness only past a threshold, via the localized agents.hud.stale key, not a raw timestamp', () => {
    const body = fnBody(APP, 'async function refreshAgentHud()')
    expect(body).toContain('ageSec >= 15')
    expect(body).toContain("t('agents.hud.stale', { sec: ageSec })")
  })
})

describe('per-agent HUD i18n (rule 12: no hardcoded, HU+EN parity)', () => {
  const KEYS = [
    'agents.hud.context_label',
    'agents.hud.context_disabled',
    'agents.hud.active_model',
    'agents.hud.stale',
  ]
  it.each(KEYS)('%s exists in hu.js', (key) => {
    expect(HU).toContain(`'${key}':`)
  })
  it.each(KEYS)('%s exists in en.js', (key) => {
    expect(EN).toContain(`'${key}':`)
  })
})

describe('per-agent HUD CSS', () => {
  it('defines the bar + fill + threshold color classes', () => {
    expect(CSS).toContain('.agent-hud-bar {')
    expect(CSS).toContain('.agent-hud-bar-fill {')
    expect(CSS).toContain('.agent-hud-bar-fill--mid { background: var(--info); }')
    expect(CSS).toContain('.agent-hud-bar-fill--danger { background: var(--danger); }')
  })

  it('the fill defaults to the success token, matching a healthy/low-context state', () => {
    const idx = CSS.indexOf('.agent-hud-bar-fill {')
    const body = CSS.slice(idx, idx + 300)
    expect(body).toContain('background: var(--success);')
  })
})
