// String-contract guard for the per-agent live HUD strip (kanban f07c5b7c, BE sibling
// e9504aba). Follows the house idiom (see project-priority-ui-wiring.test.ts): app.js is
// a single global script with no module boundary, so the frontend files are read as
// strings and asserted against short, formatting-proof fragments.
//
// Covers all four signals: context-pct + active-model (GET /api/context-guard +
// GET /api/agents, wired first) and active-tool + running-sub-agent (GET /api/agent-hud,
// card e9504aba, wired once BE shipped the consolidated read endpoint).
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
  it('reads context-guard AND the consolidated agent-hud endpoint in the same poll', () => {
    expect(APP).toContain('async function refreshAgentHud()')
    const body = fnBody(APP, 'async function refreshAgentHud()')
    expect(body).toContain("fetchJsonOrNull('/api/context-guard')")
    expect(body).toContain("fetchJsonOrNull('/api/agent-hud')")
  })

  it('is polled on the same cadence as the existing busy-poll, not a second new interval', () => {
    const body = fnBody(APP, 'function startAgentsBusyPoll()')
    expect(body).toContain('refreshAgentHud()')
    expect(body).toMatch(/setInterval\(\(\) => \{ refreshAgentTerminalBusy\(\); refreshAgentHud\(\) \}, 3000\)/)
  })

  it('shows the disabled label instead of a bar when context-guard is opt-in-off for that agent (pct is not always a number)', () => {
    const body = fnBody(APP, 'async function refreshAgentHud()')
    expect(body).toContain('guardEntry.enabled && typeof guardEntry.pct === \'number\'')
    expect(body).toContain('disabledLabel.hidden = false')
  })

  it('color-codes the bar at 70% and 90%, reusing existing CSS tokens (no invented thresholds)', () => {
    const body = fnBody(APP, 'async function refreshAgentHud()')
    expect(body).toContain('pct >= 70 && pct < 90')
    expect(body).toContain('pct >= 90')
  })

  it('a poll where BOTH endpoints fail bails out, keeping the last known DOM state (rule 12: never a raw error)', () => {
    const body = fnBody(APP, 'async function refreshAgentHud()')
    expect(body).toContain('if (!guardData && !hudData) return')
    expect(body).not.toMatch(/err\.message/)
    const helper = fnBody(APP, 'async function fetchJsonOrNull(url)')
    expect(helper).toContain('if (!res.ok) return null')
    expect(helper).toContain('catch { return null }')
  })

  it('surfaces staleness only past a threshold, via the localized agents.hud.stale key, not a raw timestamp', () => {
    const body = fnBody(APP, 'async function refreshAgentHud()')
    expect(body).toContain('ageSec >= 15')
    expect(body).toContain("t('agents.hud.stale', { sec: ageSec })")
  })
})

describe('per-agent HUD active-tool + running-sub-agent (GET /api/agent-hud)', () => {
  it('renders the tool row only when activeTool is a non-empty string -- an idle agent shows neither row', () => {
    const body = fnBody(APP, 'async function refreshAgentHud()')
    expect(body).toContain("typeof hudEntry.activeTool === 'string' && hudEntry.activeTool")
    expect(body).toContain("t('agents.hud.active_tool', { tool: hudEntry.activeTool })")
  })

  it('renders the sub-agent row only when runningSubAgents > 0', () => {
    const body = fnBody(APP, 'async function refreshAgentHud()')
    expect(body).toContain('typeof n === \'number\' && n > 0')
    expect(body).toContain("t('agents.hud.subagent_running', { n })")
  })

  it('SECURITY: only reads activeTool and runningSubAgents off the response -- never a raw field dump', () => {
    // Card e9504aba's binding constraint (no tool arguments, no transcript quotes) is
    // enforced server-side; this guards the FE side of the same contract -- the response
    // also carries contextTokens/activeModel/truncated, and none of those may be used
    // here (pct/model already come from their own sources; a second reader would be a
    // second source of truth, and `truncated` describes the SCAN, not a thing to show).
    const body = fnBody(APP, 'async function refreshAgentHud()')
    expect(body).not.toMatch(/hudEntry\.contextTokens/)
    expect(body).not.toMatch(/hudEntry\.activeModel/)
    expect(body).not.toMatch(/hudEntry\.truncated/)
  })

  it('the tool/sub-agent slots exist in the shell markup, both starting hidden', () => {
    const body = fnBody(APP, 'function agentHudBlockHtml(hudKey, activeModel)')
    expect(body).toContain('class="agent-hud-row agent-hud-tool-row" hidden')
    expect(body).toContain('class="agent-hud-row agent-hud-subagent-row" hidden')
  })
})

describe('per-agent HUD i18n (rule 12: no hardcoded, HU+EN parity)', () => {
  const KEYS = [
    'agents.hud.context_label',
    'agents.hud.context_disabled',
    'agents.hud.active_model',
    'agents.hud.stale',
    'agents.hud.active_tool',
    'agents.hud.subagent_running',
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
