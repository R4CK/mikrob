// String-contract guard for card fa28ae18 (app.js modularisation slice 6/N):
// the Approvals section was extracted to web/app-approvals.js.
// House idiom: source read as string, asserted against formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const APPROVALS = readFileSync(join(__dirname, '../../web/app-approvals.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('Approvals module extraction (card fa28ae18)', () => {
  it('app-approvals.js exists and contains loadApprovalsPage', () => {
    expect(APPROVALS).toContain('async function loadApprovalsPage()')
  })

  it('app-approvals.js contains _renderApprovalsTable', () => {
    expect(APPROVALS).toContain('function _renderApprovalsTable()')
  })

  it('app-approvals.js contains _resolveApproval (approve/reject action)', () => {
    expect(APPROVALS).toContain('async function _resolveApproval(')
  })

  it('app-approvals.js contains _updateCountdowns (live countdown timer)', () => {
    expect(APPROVALS).toContain('function _updateCountdowns()')
  })

  it('app.js no longer contains loadApprovalsPage body -- only the stub comment', () => {
    expect(APP).not.toContain('async function loadApprovalsPage()')
    expect(APP).toContain('Moved to app-approvals.js')
  })

  it('app.js no longer contains _renderApprovalsTable', () => {
    expect(APP).not.toContain('function _renderApprovalsTable()')
  })

  it('index.html loads app-approvals.js after app-ideas.js', () => {
    expect(HTML).toContain('<script src="/app-approvals.js">')
    const ideasIdx = HTML.indexOf('<script src="/app-ideas.js">')
    const approvalsIdx = HTML.indexOf('<script src="/app-approvals.js">')
    expect(approvalsIdx).toBeGreaterThan(ideasIdx)
  })

  it('app-approvals.js uses escapeHtml and escapeAttr for user-facing data', () => {
    expect(APPROVALS).toContain('escapeHtml(')
    expect(APPROVALS).toContain('escapeAttr(')
  })

  it('app-approvals.js uses i18n t() for all user-facing strings', () => {
    expect(APPROVALS).toContain("t('approvals.")
  })
})
