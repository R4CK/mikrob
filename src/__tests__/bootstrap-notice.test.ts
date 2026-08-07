// Card 62631948: the dashboard startup line used to print
// `http://127.0.0.1:<port>/?token=<DASHBOARD_TOKEN>` to stderr. Writing it to stderr instead of
// through pino did not keep it out of the logs -- a service manager captures stderr as well
// (systemd journal, launchd StandardErrorPath), so a root-equivalent credential was persisted
// wherever the service log goes.
//
// Two layers, because the unit test alone would not have caught the original bug: the renderer
// cannot leak a token it is never given, so a SOURCE guard is what actually holds the line.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderBootstrapNotice } from '../web/bootstrap-notice.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('the startup notice tells the operator how to log in', () => {
  const notice = renderBootstrapNotice(3420, '/opt/marveen/store/.dashboard-token')

  it('gives the dashboard URL', () => {
    expect(notice).toContain('http://127.0.0.1:3420/')
  })

  it('points at the token FILE instead of embedding the token', () => {
    expect(notice).toContain('cat /opt/marveen/store/.dashboard-token')
  })

  it('carries no query string at all, so no credential can ride along', () => {
    expect(notice).not.toContain('?')
    expect(notice).not.toMatch(/token=/)
  })

  it('says why the token is absent, so nobody "helpfully" puts it back', () => {
    expect(notice.toLowerCase()).toContain('stderr')
  })
})

describe('SOURCE GUARD: no startup path builds a URL carrying the dashboard token', () => {
  // The renderer is pure and token-free by construction; this is the check that would have
  // failed BEFORE the fix, and the one that fails again if someone reintroduces the shortcut.
  const webTs = readFileSync(join(REPO_ROOT, 'src', 'web.ts'), 'utf8')

  it('src/web.ts never interpolates DASHBOARD_TOKEN into a URL', () => {
    expect(webTs).not.toMatch(/token=\$\{\s*DASHBOARD_TOKEN\s*\}/)
  })

  it('src/web.ts never writes DASHBOARD_TOKEN to a stream', () => {
    const emitting = webTs
      .split('\n')
      .filter((l) => /DASHBOARD_TOKEN/.test(l))
      .filter((l) => /(process\.(stdout|stderr)\.write|console\.(log|error|warn)|logger\.(info|warn|error|debug))/.test(l))
    expect(emitting, `these lines emit the dashboard token:\n${emitting.join('\n')}`).toEqual([])
  })

  it('the startup line comes from the reviewed renderer', () => {
    expect(webTs).toContain('renderBootstrapNotice(')
  })
})

describe('the browser can still authenticate without the URL that used to carry the token', () => {
  // Removing the `?token=` startup URL removes the ONLY login path a plain browser had: the paste
  // overlay was gated on an installed PWA, and the fallback was an alert() telling the user to
  // find the `?token=` line in the server log. That line no longer exists, so the gate had to go
  // or a desktop user would be locked out with instructions to look for nothing.
  const appJs = readFileSync(join(REPO_ROOT, 'web', 'app.js'), 'utf8')

  it('offers the token paste field on auth failure regardless of display mode', () => {
    const handler = appJs.slice(appJs.indexOf('async function handleAuthFailure'), appJs.indexOf('async function handleAuthFailure') + 2000)
    expect(handler).toContain('showStandaloneTokenPrompt(TOKEN_KEY)')
    expect(handler).not.toMatch(/if\s*\(\s*isStandalone\s*\)/)
  })

  it('no longer sends the user to the server log for a "?token=" line', () => {
    expect(appJs).not.toContain('look for "Dashboard access URL"')
  })

  it('tells the user where the token actually lives', () => {
    expect(appJs).toContain('cat store/.dashboard-token')
  })
})
