// String-contract guard for the "last updated" sidebar badge (card 77be6b51, pairing
// 0898db66). Follows the house idiom (see approvals-ui-contract.test.ts /
// federation-ui-contract.test.ts): the frontend files are read as strings and asserted
// against short, formatting-proof fragments, since app.js is a single global script with
// no module boundary to import a function from directly.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_CORE = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const APP_LAST_UPDATE = readFileSync(join(__dirname, '../../web/app-last-update.js'), 'utf-8')
const APP = APP_CORE + '\n' + APP_LAST_UPDATE
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

function fnBody(source: string, startMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found: ${startMarker}`)
  const nextFn = source.indexOf('\nfunction ', start + startMarker.length)
  const nextAsyncFn = source.indexOf('\nasync function ', start + startMarker.length)
  const candidates = [nextFn, nextAsyncFn].filter((i) => i > start)
  const end = candidates.length ? Math.min(...candidates) : start + 2000
  return source.slice(start, end)
}

describe('last-update sidebar badge UI wiring', () => {
  it('sidebar has the badge element, pinned above the footer icon row', () => {
    expect(HTML).toContain('id="sidebarUpdateBadge"')
    expect(HTML).toContain('id="sidebarUpdateText"')
    const badgeIdx = HTML.indexOf('id="sidebarUpdateBadge"')
    const footerIdx = HTML.indexOf('class="sidebar-footer"')
    expect(badgeIdx).toBeGreaterThan(-1)
    expect(badgeIdx).toBeLessThan(footerIdx)
  })

  it('app.js fetches /api/status and renders its lastUpdate field', () => {
    expect(APP).toMatch(/async function refreshLastUpdateBadge/)
    const body = fnBody(APP, 'async function refreshLastUpdateBadge')
    expect(body).toContain("fetch('/api/status')")
    expect(body).toContain('data.lastUpdate')
    expect(body).toContain('renderLastUpdateBadge')
  })

  it('renderLastUpdateBadge shows the unknown state first, before touching lu fields', () => {
    expect(APP).toMatch(/function renderLastUpdateBadge/)
    const body = fnBody(APP, 'function renderLastUpdateBadge')
    const nullCheckIdx = body.indexOf('!lu || !lu.timestamp')
    const sourceCheckIdx = body.indexOf("lu.source === 'update-history'")
    expect(nullCheckIdx).toBeGreaterThan(-1)
    expect(sourceCheckIdx).toBeGreaterThan(-1)
    expect(nullCheckIdx).toBeLessThan(sourceCheckIdx)
    expect(body).toContain("t('lastUpdate.unknown')")
  })

  it('distinguishes a real recorded update from the built-commit fallback by source', () => {
    const body = fnBody(APP, 'function renderLastUpdateBadge')
    expect(body).toContain("lastUpdate.updated")
    expect(body).toContain("lastUpdate.build")
  })

  it('formats the timestamp in Europe/Budapest local time', () => {
    const body = fnBody(APP, 'function renderLastUpdateBadge')
    expect(body).toContain("timeZone: 'Europe/Budapest'")
  })

  it('refreshLastUpdateBadge is called once on load (no page-scoped gate)', () => {
    expect(APP).toMatch(/refreshLastUpdateBadge\(\)\s*\n/)
  })

  it('.sidebar-update-badge CSS exists', () => {
    expect(CSS).toContain('.sidebar-update-badge')
  })

  it('all lastUpdate.* i18n keys exist in both HU and EN', () => {
    const keys = [
      'lastUpdate.loading',
      'lastUpdate.unknown',
      'lastUpdate.updated',
      'lastUpdate.updatedNoVersion',
      'lastUpdate.build',
      'lastUpdate.buildNoVersion',
      'lastUpdate.shaTitle',
    ]
    for (const key of keys) {
      expect(HU, `HU missing ${key}`).toContain(`'${key}':`)
      expect(EN, `EN missing ${key}`).toContain(`'${key}':`)
    }
  })
})
