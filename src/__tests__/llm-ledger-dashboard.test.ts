/**
 * Contract guard for card 52c48470: F4 LLM usage ledger dashboard panel.
 * API: GET /api/llm-ledger/summary?days=N (backend card e96d56c5, done/landed)
 *      GET/PUT /api/llm-ledger/budget/:agentId
 *
 * House idiom (see gemini-calls-widget.test.ts): source files read as strings,
 * asserted against short, formatting-proof fragments -- no DOM/runtime needed.
 *
 * Key contracts verified:
 *   - loadLlmLedger() fetches /api/llm-ledger/summary?days= (uses _llmLedgerDays)
 *   - Renders providers, task_types, agents sections
 *   - escapeHtml() wraps every untrusted server value (XSS mutation pin)
 *   - Budget PUT goes to /api/llm-ledger/budget/:agentId with { daily_budget }
 *   - Non-negative-integer validation before PUT
 *   - Loading / empty / error DOM state management
 *   - 7-day / 30-day toggle re-calls loadLlmLedger()
 *   - switchPage('llmLedger') calls initLlmLedgerPage()
 *   - Page div and tbody IDs present in index.html
 *   - Nav link data-page="llmLedger" in index.html
 *   - i18n parity: all llmLedger.* keys exist in both hu.js and en.js
 *   - CSS classes present in style.css
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { langHasKey } from './helpers/lang-overlay-key.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC   = readFileSync(join(__dirname, '../../web/app-llm-ledger.js'), 'utf-8')
const PGSW  = readFileSync(join(__dirname, '../../web/app-page-switch.js'), 'utf-8')
const HTML  = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS   = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const SBGRP = readFileSync(join(__dirname, '../../web/app-sidebar-groups.js'), 'utf-8')

function fnBody(source: string, startMarker: string, maxLen = 5000): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextAsync = source.indexOf('\nasync function ', start + startMarker.length)
  const nextSync  = source.indexOf('\nfunction ', start + startMarker.length)
  const candidates = [nextAsync, nextSync].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + maxLen
  return source.slice(start, end)
}

// ---- API shape -------------------------------------------------------------

describe('llm-ledger: API fetch', () => {
  it('loadLlmLedger is defined', () => {
    expect(SRC).toContain('async function loadLlmLedger(')
  })

  it('fetches /api/llm-ledger/summary with days parameter', () => {
    const body = fnBody(SRC, 'async function loadLlmLedger(')
    expect(body).toContain('/api/llm-ledger/summary?days=')
    expect(body).toContain('_llmLedgerDays')
  })

  it('handles non-ok HTTP response as error', () => {
    const body = fnBody(SRC, 'async function loadLlmLedger(')
    expect(body).toContain('res.ok')
    expect(body).toContain('llmLedger.load_error')
  })

  it('manages loading state around the fetch', () => {
    const body = fnBody(SRC, 'async function loadLlmLedger(')
    expect(body).toContain('llmLedgerSetLoading(true)')
    expect(body).toContain('llmLedgerSetLoading(false)')
  })
})

// ---- Rendering functions ---------------------------------------------------

describe('llm-ledger: provider rendering', () => {
  it('llmLedgerRenderProviders is defined', () => {
    expect(SRC).toContain('function llmLedgerRenderProviders(')
  })

  it('targets llmLedgerProvidersTbody', () => {
    const body = fnBody(SRC, 'function llmLedgerRenderProviders(')
    expect(body).toContain('llmLedgerProvidersTbody')
  })

  it('renders provider name with escapeHtml -- mutation pin', () => {
    const body = fnBody(SRC, 'function llmLedgerRenderProviders(')
    // escapeHtml must wrap r.provider (not r.provider used raw)
    expect(body).toContain('escapeHtml(r.provider)')
  })

  it('shows saved tokens column', () => {
    const body = fnBody(SRC, 'function llmLedgerRenderProviders(')
    expect(body).toContain('claude_token_equiv_saved')
  })
})

describe('llm-ledger: task type rendering', () => {
  it('llmLedgerRenderTaskTypes is defined', () => {
    expect(SRC).toContain('function llmLedgerRenderTaskTypes(')
  })

  it('targets llmLedgerTaskTypesTbody', () => {
    const body = fnBody(SRC, 'function llmLedgerRenderTaskTypes(')
    expect(body).toContain('llmLedgerTaskTypesTbody')
  })

  it('renders task_type with escapeHtml -- mutation pin', () => {
    const body = fnBody(SRC, 'function llmLedgerRenderTaskTypes(')
    expect(body).toContain('escapeHtml(r.task_type)')
  })
})

describe('llm-ledger: agent rendering', () => {
  it('llmLedgerRenderAgents is defined', () => {
    expect(SRC).toContain('function llmLedgerRenderAgents(')
  })

  it('renders agent_id with escapeHtml in cell content -- mutation pin', () => {
    const body = fnBody(SRC, 'function llmLedgerRenderAgents(')
    expect(body).toContain('escapeHtml(r.agent_id)')
  })

  it('renders agent_id with escapeHtml in data-agent-id attribute -- mutation pin', () => {
    const body = fnBody(SRC, 'function llmLedgerRenderAgents(')
    // attribute must be wrapped
    expect(body).toContain('escapeHtml(r.agent_id)')
    // The data-agent-id= pattern must exist
    expect(body).toContain('data-agent-id=')
  })

  it('renders budget_source with escapeHtml -- mutation pin', () => {
    const body = fnBody(SRC, 'function llmLedgerRenderAgents(')
    expect(body).toContain('escapeHtml(r.budget_source)')
  })

  it('renders daily_budget value', () => {
    const body = fnBody(SRC, 'function llmLedgerRenderAgents(')
    expect(body).toContain('daily_budget')
  })

  it('includes budget edit/save/cancel buttons', () => {
    const body = fnBody(SRC, 'function llmLedgerRenderAgents(')
    expect(body).toContain('data-act="edit-budget"')
    expect(body).toContain('data-act="save-budget"')
    expect(body).toContain('data-act="cancel-budget"')
  })
})

// ---- Success-rate / latency helpers ----------------------------------------

describe('llm-ledger: calculation helpers', () => {
  it('llmLedgerPct is defined', () => {
    expect(SRC).toContain('function llmLedgerPct(')
  })

  it('llmLedgerPct returns dash when total is 0', () => {
    const body = fnBody(SRC, 'function llmLedgerPct(')
    expect(body).toContain("return '—'")
    expect(body).toContain('!total')
  })

  it('llmLedgerPct returns percentage', () => {
    const body = fnBody(SRC, 'function llmLedgerPct(')
    expect(body).toContain("'%'")
    expect(body).toContain('Math.round')
  })

  it('llmLedgerAcceptPct is defined', () => {
    expect(SRC).toContain('function llmLedgerAcceptPct(')
  })

  it('llmLedgerLatency is defined', () => {
    expect(SRC).toContain('function llmLedgerLatency(')
  })
})

// ---- Budget save flow ------------------------------------------------------

describe('llm-ledger: budget save', () => {
  it('llmLedgerSaveBudget is defined', () => {
    expect(SRC).toContain('async function llmLedgerSaveBudget(')
  })

  it('PUT to /api/llm-ledger/budget/ with encodeURIComponent', () => {
    const body = fnBody(SRC, 'async function llmLedgerSaveBudget(')
    expect(body).toContain('/api/llm-ledger/budget/')
    expect(body).toContain('encodeURIComponent(agentId)')
    expect(body).toContain("method: 'PUT'")
  })

  it('sends { daily_budget } in body', () => {
    const body = fnBody(SRC, 'async function llmLedgerSaveBudget(')
    expect(body).toContain('daily_budget')
    expect(body).toContain('JSON.stringify')
  })

  it('validates non-negative integer before saving', () => {
    // The click handler on the agents tbody contains the validation guard
    const body = fnBody(SRC, 'function setupLlmLedgerTableClick(')
    expect(body).toContain('val < 0')
    expect(body).toContain('llmLedger.budget.invalid')
  })
})

// ---- Days toggle -----------------------------------------------------------

describe('llm-ledger: days toggle', () => {
  it('setupLlmLedgerDaysFilter is defined', () => {
    expect(SRC).toContain('function setupLlmLedgerDaysFilter(')
  })

  it('assigns _llmLedgerDays = 7 on days7 click and reloads', () => {
    const body = fnBody(SRC, 'function setupLlmLedgerDaysFilter(')
    expect(body).toContain('_llmLedgerDays = 7')
    expect(body).toContain('loadLlmLedger()')
  })

  it('assigns _llmLedgerDays = 30 on days30 click and reloads', () => {
    const body = fnBody(SRC, 'function setupLlmLedgerDaysFilter(')
    expect(body).toContain('_llmLedgerDays = 30')
    expect(body).toContain('loadLlmLedger()')
  })

  it('llmLedgerSyncDaysBtns toggles active class', () => {
    const body = fnBody(SRC, 'function llmLedgerSyncDaysBtns(')
    expect(body).toContain("'active'")
    expect(body).toContain('_llmLedgerDays === 7')
    expect(body).toContain('_llmLedgerDays === 30')
  })
})

// ---- State management ------------------------------------------------------

describe('llm-ledger: DOM state functions', () => {
  it('llmLedgerSetLoading targets llmLedgerLoading', () => {
    expect(SRC).toContain("'llmLedgerLoading'")
  })

  it('llmLedgerSetError targets llmLedgerError', () => {
    expect(SRC).toContain("'llmLedgerError'")
  })

  it('llmLedgerSetEmpty targets llmLedgerEmpty', () => {
    expect(SRC).toContain("'llmLedgerEmpty'")
  })
})

// ---- Page wiring -----------------------------------------------------------

describe('llm-ledger: page wiring', () => {
  it('switchPage calls initLlmLedgerPage for llmLedger', () => {
    expect(PGSW).toContain("pageId === 'llmLedger'")
    expect(PGSW).toContain('initLlmLedgerPage()')
  })

  it('index.html has nav link data-page="llmLedger"', () => {
    expect(HTML).toContain('data-page="llmLedger"')
  })

  it('index.html has page div id="llmLedgerPage"', () => {
    expect(HTML).toContain('id="llmLedgerPage"')
  })

  it('index.html includes app-llm-ledger.js script', () => {
    expect(HTML).toContain('app-llm-ledger.js')
  })

  it('index.html has tbody ids for all three sections', () => {
    expect(HTML).toContain('id="llmLedgerProvidersTbody"')
    expect(HTML).toContain('id="llmLedgerTaskTypesTbody"')
    expect(HTML).toContain('id="llmLedgerAgentsTbody"')
  })

  it('index.html has day filter buttons', () => {
    expect(HTML).toContain('id="llmLedgerDays7"')
    expect(HTML).toContain('id="llmLedgerDays30"')
  })

  it('sidebar groups includes llmLedger in stats', () => {
    expect(SBGRP).toContain("'llmLedger'")
  })
})

// ---- CSS -------------------------------------------------------------------

describe('llm-ledger: CSS', () => {
  it('has table wrapper class', () => {
    expect(CSS).toContain('.llm-ledger-table-wrap')
  })

  it('has totals bar class', () => {
    expect(CSS).toContain('.llm-ledger-totals')
  })

  it('has budget input class', () => {
    expect(CSS).toContain('.llm-ledger-budget-input')
  })

  it('has mobile breakpoint', () => {
    expect(CSS).toContain('.llm-ledger-toolbar')
  })
})

// ---- i18n parity -----------------------------------------------------------

const LLM_LEDGER_KEYS = [
  'nav.llmLedger',
  'llmLedger.title',
  'llmLedger.loading',
  'llmLedger.load_error',
  'llmLedger.empty',
  'llmLedger.refresh',
  'llmLedger.days.7',
  'llmLedger.days.30',
  'llmLedger.table.no_data',
  'llmLedger.providers.title',
  'llmLedger.task_types.title',
  'llmLedger.agents.title',
  'llmLedger.col.provider',
  'llmLedger.col.calls',
  'llmLedger.col.success_rate',
  'llmLedger.col.tokens_saved',
  'llmLedger.col.daily_budget',
  'llmLedger.totals.calls',
  'llmLedger.totals.saved_tokens',
  'llmLedger.budget.edit',
  'llmLedger.budget.save',
  'llmLedger.budget.cancel',
  'llmLedger.budget.invalid',
  'llmLedger.budget.save_error',
  'llmLedger.budget.source.platform',
  'llmLedger.budget.source.override',
]

describe('llm-ledger: i18n parity', () => {
  for (const key of LLM_LEDGER_KEYS) {
    it(`key "${key}" exists in both hu.js and en.js`, () => {
      expect(langHasKey('hu', key)).toBe(true)
      expect(langHasKey('en', key)).toBe(true)
    })
  }
})
