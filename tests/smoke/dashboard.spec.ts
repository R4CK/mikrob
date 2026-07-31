/**
 * Dashboard smoke tests.
 *
 * Prerequisites: the dashboard must be running and DASHBOARD_TOKEN must be set.
 *   DASHBOARD_TOKEN=$(cat store/.dashboard-token) npm run smoke
 *
 * What these tests catch: a single JS syntax error or undefined global that
 * silently breaks the entire dashboard (blank page / stuck UI).
 * They are NOT a full functional harness -- they verify the minimum viable
 * page health at the point of merge.
 */

import { test, expect } from '@playwright/test'

const TOKEN = process.env.DASHBOARD_TOKEN || ''

test.describe('Dashboard smoke', () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    ;(page as unknown as { _smokeErrors: string[] })._smokeErrors = errors
  })

  test('loads with token and returns HTTP 200', async ({ page }) => {
    const response = await page.goto(`/?token=${TOKEN}`)
    expect(response?.status()).toBe(200)
  })

  test('navigation sidebar links are visible', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}`)
    const navLinks = page.locator('.sb-link[data-page]')
    await expect(navLinks.first()).toBeVisible()
    const count = await navLinks.count()
    expect(count).toBeGreaterThanOrEqual(4)
  })

  test('switchPage is callable without throwing', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}`)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.evaluate(() => {
      if (typeof (window as unknown as Record<string, unknown>).switchPage !== 'function') {
        throw new Error('switchPage is not a function')
      }
    })
    expect(errors).toHaveLength(0)
  })

  test('no JS errors on page load', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(`/?token=${TOKEN}`)
    // brief wait for any deferred init errors
    await page.waitForTimeout(500)
    expect(errors).toHaveLength(0)
  })

  test('kanban page loads without errors', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(`/?token=${TOKEN}#kanban`)
    await page.waitForTimeout(500)
    expect(errors).toHaveLength(0)
  })

  // Card 2ed90db1 / PR #524 review blocker: "no UI is wired, /api/costs isn't
  // reachable from the dashboard" -- this proves the Costs nav link is real, the
  // page actually renders live data from /api/costs/summary (not dead scaffolding),
  // and no JS error fires.
  //
  // Navigates via the URL hash rather than clicking the sidebar link: the
  // link lives inside the collapsible "STATISZTIKÁK" group, which starts
  // collapsed/invisible on a fresh session (no marveen.sidebarGroups in
  // localStorage yet) until switchPage() auto-expands the active page's
  // group -- clicking it first intermittently timed out with "element is
  // not visible" depending on that default state (found while adding the
  // repos-page smoke test, card 000ec0d0).
  test('costs page loads and renders live summary data without errors', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(`/?token=${TOKEN}#costs`)
    await page.waitForTimeout(500)
    const content = page.locator('#costsContent')
    await expect(content).toBeVisible()
    // The summary always includes a "month" stat (YYYY-MM), regardless of whether
    // any real fixed costs are configured -- proves the fetch to /api/costs/summary
    // actually happened and rendered, not just an empty/loading shell.
    await expect(content).toContainText(/\d{4}-\d{2}/)
    expect(errors).toHaveLength(0)
  })

  // Card 000ec0d0: proves the "Beépített repók" nav link + page are real and
  // wired to the live GET /api/connectors/github-repos endpoint (not dead
  // scaffolding) -- the stat total renders "0" from a real fetch, and the
  // real empty-state message is shown since no repos are registered yet.
  // Navigates via the URL hash (like the kanban test above) rather than
  // clicking the sidebar link directly: the link lives inside the
  // collapsible "RENDSZER" group, which starts collapsed/invisible on a
  // fresh session until switchPage() auto-expands the active page's group --
  // clicking it first would fail Playwright's visibility check.
  test('repos page loads and renders live repo count without errors', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(`/?token=${TOKEN}#repos`)
    await page.waitForTimeout(500)
    const statTotal = page.locator('#reposStatTotal')
    await expect(statTotal).toBeVisible()
    await expect(statTotal).toHaveText(/^\d+$/)
    // The nav link itself must also be visible now (its group auto-expanded
    // for the active page) -- proves the sidebar entry is real, not orphaned.
    await expect(page.locator('.sb-link[data-page="repos"]')).toBeVisible()
    expect(errors).toHaveLength(0)
  })

  // Card f3248478: Claude Limit panel tooltip + editable weekly-threshold sliders.
  // Overview is the default landing page, so no hash navigation needed. Proves the
  // sliders (card e7a26045: redesigned to 2 flat, day-independent levels) and the help
  // modal opens/closes without error. Save stays disabled -- the backend 2-field
  // endpoint (card d08b98f4) doesn't exist yet, this only verifies the layout.
  test('quota threshold panel shows 2 sliders and help modal toggles', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(`/?token=${TOKEN}`)
    await page.waitForTimeout(500)

    const toggle = page.locator('#thresholdToggle')
    await expect(toggle).toBeVisible()
    await toggle.click()
    const body = page.locator('#thresholdBody')
    await expect(body).toBeVisible()
    await expect(page.locator('#thrNewDevStop')).toHaveValue(/^\d+$/)
    await expect(page.locator('#thrNewDevStopVal')).toHaveText(/%$/)
    await expect(page.locator('#thrTestStop')).toHaveValue(/^\d+$/)
    await expect(page.locator('#thresholdSaveBtn')).toBeDisabled()

    const helpBtn = page.locator('#quotaHelpBtn')
    await expect(helpBtn).toBeVisible()
    await helpBtn.click()
    await expect(page.locator('#quotaHelpOverlay')).toHaveClass(/active/)
    await page.locator('#quotaHelpClose').click()
    await expect(page.locator('#quotaHelpOverlay')).not.toHaveClass(/active/)

    expect(errors).toHaveLength(0)
  })

  // Card e7a26045: dragging "New dev stops" above "Testing/review also stops" must
  // cascade the other slider up rather than allow an inverted pair, and pinning a
  // slider at 100% must show the visible+accessible warning.
  test('threshold sliders cascade to stay monotonic and flag a 100% value', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(`/?token=${TOKEN}`)
    await page.waitForTimeout(500)
    await page.locator('#thresholdToggle').click()
    await expect(page.locator('#thresholdBody')).toBeVisible()

    // Drag "new dev stops" above the current "testing also stops" -- the latter must
    // cascade up.
    await page.locator('#thrNewDevStop').fill('99')
    await page.locator('#thrNewDevStop').dispatchEvent('input')
    const newDevStop = Number(await page.locator('#thrNewDevStop').inputValue())
    const testStop = Number(await page.locator('#thrTestStop').inputValue())
    expect(newDevStop).toBeLessThanOrEqual(testStop)

    // Push it to 100 -- the warning icon for that row must become visible (not just
    // present-but-hidden) and it must have a real accessible name, not aria-hidden.
    await page.locator('#thrNewDevStop').fill('100')
    await page.locator('#thrNewDevStop').dispatchEvent('input')
    const warn = page.locator('#thrNewDevStopWarn')
    await expect(warn).toBeVisible()
    await expect(warn).toHaveAttribute('role', 'img')
    await expect(warn).not.toHaveAttribute('aria-hidden', 'true')

    expect(errors).toHaveLength(0)
  })

  // Card e7a26045: the local-LLM info row replaces the removed 3rd slider. today/week
  // counts are real; model/tokens-saved are honest placeholders until the backend
  // (card d08b98f4) ships those fields.
  test('local-LLM info row loads and its help modal toggles', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(`/?token=${TOKEN}`)
    await page.waitForTimeout(500)

    await expect(page.locator('#usageLlmInfo')).toBeVisible()
    await expect(page.locator('#llmInfoToday')).toHaveText(/\d/)
    await expect(page.locator('#llmInfoWeek')).toHaveText(/\d/)

    const llmHelpBtn = page.locator('#llmInfoHelpBtn')
    await expect(llmHelpBtn).toBeVisible()
    await llmHelpBtn.click()
    await expect(page.locator('#llmInfoHelpOverlay')).toHaveClass(/active/)
    await page.locator('#llmInfoHelpClose').click()
    await expect(page.locator('#llmInfoHelpOverlay')).not.toHaveClass(/active/)

    expect(errors).toHaveLength(0)
  })
})
