import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The fork overlay seam (card 241532d8). web/app.js broke Peti's "upstream always
// merges cleanly" rule because the fork had REPLACED loadUpdates() in place while
// upstream kept growing the same function -- three-way divergence on one shared
// function, which helper extraction cannot resolve. The fix is a runtime override:
// app.js keeps upstream's loadUpdates byte-for-byte, and web/fork-updates.js loads
// afterwards and replaces the global.
//
// fork-upstream-conflict-guard.test.ts already proves the merge is clean, but it
// proves it against a MOVING upstream and skips when the network is down. These
// cases pin the local half of the arrangement: that the fork's renderer really did
// leave app.js, that the override is actually wired, and that the route serving the
// overlay cannot be talked into serving anything else.

const WEB = join(__dirname, '..', '..', 'web')
const appJs = readFileSync(join(WEB, 'app.js'), 'utf-8')
const overlay = readFileSync(join(WEB, 'fork-updates.js'), 'utf-8')
const indexHtml = readFileSync(join(WEB, 'index.html'), 'utf-8')

describe('fork overlay seam: the fork renderer left app.js', () => {
  // The whole point of the seam. If someone "fixes" the Updates page by editing
  // app.js again, the merge conflict comes back -- and it comes back silently,
  // because nothing breaks until the next upstream merge.
  it('app.js does not define the fork two-repo renderer', () => {
    expect(appJs).not.toContain('function updatesRepoBlockHtml')
    expect(appJs).not.toContain('function updatesChangesHtml')
  })

  it('app.js loadUpdates renders the upstream single-repo containers, not the fork one', () => {
    const body = appJs.slice(appJs.indexOf('async function loadUpdates()'))
    const loadUpdates = body.slice(0, body.indexOf('\n}\n') + 2)
    expect(loadUpdates).toContain("getElementById('updatesCommitList')")
    expect(loadUpdates).not.toContain('updatesRepos')
    expect(loadUpdates).not.toContain('data.repos')
  })

  it('the fork renderer exists exactly once, in the overlay', () => {
    expect(overlay.match(/function updatesRepoBlockHtml/g)).toHaveLength(1)
    expect(overlay).toContain("getElementById('updatesRepos')")
  })

  // #963 (card ae0f2178): renderUpdatesVersion() is upstream's own function, defined
  // once in app.js. The overlay must CALL it, not redefine it -- a redefinition here
  // would reopen the exact three-way divergence this seam exists to avoid.
  it('app.js still defines renderUpdatesVersion, and the overlay calls it rather than redefining it', () => {
    expect(appJs).toContain('function renderUpdatesVersion(data)')
    expect(overlay).not.toContain('function renderUpdatesVersion')
    expect(overlay).toMatch(/\brenderUpdatesVersion\(data\)/)
  })
})

describe('fork overlay seam: the override is wired', () => {
  it('the overlay replaces the global loadUpdates', () => {
    expect(overlay).toMatch(/window\.loadUpdates\s*=\s*forkLoadUpdates/)
    expect(overlay).toContain('async function forkLoadUpdates()')
  })

  // Order matters and is invisible at runtime until the Updates page is opened:
  // load the overlay first and app.js's own declaration would win instead.
  it('index.html loads the overlay after app.js', () => {
    const app = indexHtml.indexOf('src="/app.js"')
    const fork = indexHtml.indexOf('src="/fork-updates.js"')
    expect(app).toBeGreaterThan(-1)
    expect(fork).toBeGreaterThan(-1)
    expect(fork).toBeGreaterThan(app)
  })
})

describe('fork overlay seam: the serving rule', () => {
  // Mirrors the allowlist in src/web/routes/static.ts. It is a prefix rule so the
  // next overlay needs no route change, which makes the shape check the only thing
  // standing between "/fork-" and the filesystem.
  const OVERLAY_NAME = /^fork-[a-z0-9-]+\.js$/

  it('admits the overlay names the convention produces', () => {
    expect(OVERLAY_NAME.test('fork-updates.js')).toBe(true)
    expect(OVERLAY_NAME.test('fork-local-llm-panel.js')).toBe(true)
  })

  it('rejects traversal and anything that is not an overlay', () => {
    for (const bad of [
      'fork-../app.js',
      'fork-../../store/.dashboard-token',
      'fork-updates.js/../../etc/passwd',
      'fork-.js',
      'fork-updates.ts',
      'fork-Updates.js',
      'fork-updates.js.map',
    ]) {
      expect(OVERLAY_NAME.test(bad), bad).toBe(false)
    }
  })

  it('the route file uses that exact shape check', () => {
    const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'static.ts'), 'utf-8')
    expect(route).toContain(OVERLAY_NAME.source)
  })
})
