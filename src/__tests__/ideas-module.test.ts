// String-contract guard for card cb5cef0f (app.js modularisation slice 5/N):
// the Ideas (Ötletláda) section was extracted to web/app-ideas.js.
// Follows the house idiom: source read as a string, asserted against short,
// formatting-proof fragments. No DOM or runtime needed.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const IDEAS = readFileSync(join(__dirname, '../../web/app-ideas.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('Ideas module extraction (card cb5cef0f)', () => {
  it('app-ideas.js exists and contains loadIdeasPage', () => {
    expect(IDEAS).toContain('async function loadIdeasPage()')
  })

  it('app-ideas.js contains renderIdeasList', () => {
    expect(IDEAS).toContain('function renderIdeasList()')
  })

  it('app-ideas.js contains ideaScoreBadge', () => {
    expect(IDEAS).toContain('function ideaScoreBadge(')
  })

  it('app-ideas.js contains openIdeaDetail', () => {
    expect(IDEAS).toContain('async function openIdeaDetail(')
  })

  it('app-ideas.js contains openIdeaBreakdown (AI-to-kanban flow)', () => {
    expect(IDEAS).toContain('async function openIdeaBreakdown(')
  })

  it('app-ideas.js contains setIdeaStatus', () => {
    expect(IDEAS).toContain('async function setIdeaStatus(')
  })

  it('app.js no longer contains loadIdeasPage body -- only the stub comment', () => {
    expect(APP).not.toContain('async function loadIdeasPage()')
    expect(APP).toContain('Moved to app-ideas.js')
  })

  it('app.js no longer contains renderIdeasList', () => {
    expect(APP).not.toContain('function renderIdeasList()')
  })

  it('index.html loads app-ideas.js after app-token-usage.js', () => {
    expect(HTML).toContain('<script src="/app-ideas.js">')
    const tokenUsageIdx = HTML.indexOf('<script src="/app-token-usage.js">')
    const ideasIdx = HTML.indexOf('<script src="/app-ideas.js">')
    expect(ideasIdx).toBeGreaterThan(tokenUsageIdx)
  })

  it('app-ideas.js loads AFTER app.js (app-ideas.js script tag comes after app.js tag)', () => {
    const appJsIdx = HTML.indexOf('<script src="/app.js">')
    const ideasIdx = HTML.indexOf('<script src="/app-ideas.js">')
    expect(ideasIdx).toBeGreaterThan(appJsIdx)
  })

  it('STATUS_COLORS and STATUS_LABELS are defined in app-ideas.js', () => {
    expect(IDEAS).toContain('const STATUS_COLORS')
    expect(IDEAS).toContain('const STATUS_LABELS')
  })

  it('app-ideas.js uses escapeHtml (caller-escape pattern, not raw server data)', () => {
    expect(IDEAS).toContain('escapeHtml(')
  })
})
