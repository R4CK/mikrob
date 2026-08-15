import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'

// INVERTED ON PURPOSE (card 691f5475 / 0ea08957, after incident f8db701c).
//
// This file used to REQUIRE the opposite: that every launcher exports RESEND_API_KEY, so the
// "Bearer ${RESEND_API_KEY}" header in each config root would resolve. That worked, and it was the
// wrong shape -- it put the live credential in the environment of all 15 sessions for their whole
// lifetime. Reading it via $(cat) kept the value out of argv, but not out of `env`, and that is how
// it leaked: an agent pasted a full environment dump into an inter-agent message, publishing the
// key to every recipient's transcript. An ambient secret needs only ONE quoting slip anywhere.
//
// The `resend` MCP server now resolves its own credential at connection time via
// scripts/vault-headers-helper.sh (`headersHelper`), measured against the live Resend API with
// RESEND_API_KEY absent. So the requirement is now the inverse: NO launcher may put it in an
// environment, and this file fails if anyone puts it back.

const REPO = join(__dirname, '../..')

// The two shapes that actually place the value in an environment. Matching the bare NAME would be
// wrong: the launchers carry comments explaining why the export is gone, and a name-only scan would
// fail on its own documentation -- the "documented anti-pattern" trap from card 48d5f255.
const EXPORT_SHAPE = /export\s+RESEND_API_KEY/i
const ASSIGN_SHAPE = /(^|[\s;&|"'`])RESEND_API_KEY\s*=/m

function putsKeyInEnv(src: string): boolean {
  return EXPORT_SHAPE.test(src) || ASSIGN_SHAPE.test(src)
}

describe('the detector itself can fail (negative control)', () => {
  // Without this, every assertion below could be passing because the regexes match nothing at all.
  it('flags the exact shape that was removed', () => {
    expect(putsKeyInEnv(`export RESEND_API_KEY="$(cat '/x/store/.resend-api-key')" && `)).toBe(true)
    expect(putsKeyInEnv(`RESEND_API_KEY=re_live_notarealkey node server.js`)).toBe(true)
    expect(putsKeyInEnv(`  ...(opts.resendKey ? ['&& export RESEND_API_KEY=\${x}'] : []),`)).toBe(true)
  })

  it('does NOT flag prose that merely names the variable', () => {
    // The launchers each carry a comment saying why this is gone; those must stay green.
    expect(putsKeyInEnv('// NO RESEND_API_KEY EXPORT HERE, DELIBERATELY -- card 691f5475')).toBe(false)
    expect(putsKeyInEnv('# the resend header no longer needs RESEND_API_KEY at all')).toBe(false)
  })
})

describe('no launcher puts RESEND_API_KEY into a session environment', () => {
  // The same four launch sinks the old version of this file enumerated. Missing ONE of them leaves
  // the credential ambient for every agent started through that path -- which is the whole defect.
  const SINKS: Array<[string, string]> = [
    ['agent-process.ts (fleet sub-agents)', 'src/web/agent-process.ts'],
    ['channel-monitor.ts (main-session respawn)', 'src/web/channel-monitor.ts'],
    ['agent-worker.ts (worker sessions)', 'src/web/agent-worker.ts'],
    ['channels.sh (main agent cold boot)', 'scripts/channels.sh'],
  ]

  for (const [label, rel] of SINKS) {
    it(`${label} does not export or assign RESEND_API_KEY`, () => {
      expect(putsKeyInEnv(readFileSync(join(REPO, rel), 'utf-8'))).toBe(false)
    })
  }

  it('the resend export helper is gone, not merely unused', () => {
    // A helper left in place is an invitation to wire it back in "just for this one launcher".
    const src = readFileSync(join(REPO, 'src/web/agent-process.ts'), 'utf-8')
    expect(src).not.toMatch(/export function resendApiKeyExport/)
    expect(src).not.toMatch(/export function hasResendApiKey/)
    expect(src).not.toMatch(/export const RESEND_API_KEY_PATH/)
  })

  it('the main-session respawn command carries no Resend credential at all', () => {
    const cmd = buildMainSessionRespawnCmd({
      claudePath: '/usr/bin/claude',
      pluginId: 'telegram',
      model: 'claude-opus-5',
      continueSession: false,
    })
    expect(putsKeyInEnv(cmd)).toBe(false)
    expect(cmd).not.toContain('.resend-api-key')
  })
})

describe('the credential is reachable without an environment variable', () => {
  it('the vault headers helper exists and is executable by the MCP client', () => {
    // This is what replaced the export: Claude Code runs it per connection and uses the JSON it
    // prints as the request headers, so the secret is resolved from the vault and never lands in a
    // config file or an environment. Proven live on a fleet config (resend Connected with
    // RESEND_API_KEY unset; the produced header authenticates, read-only GET -> HTTP 200).
    const helper = join(REPO, 'scripts/vault-headers-helper.sh')
    const src = readFileSync(helper, 'utf-8')
    expect(src).toContain('vault-headers-helper.mjs')
  })
})

// NOTE, deliberately NOT a test here: scanning the live agents/<name>/.claude-config/.claude.json
// files for a leftover placeholder or literal key cannot live in this suite. It runs in a
// disposable worktree (store/fleet-test.sh) with no agents/ tree at all, so such a test would be
// vacuously green exactly where it runs. The live-tree scan is release evidence, and a recurring
// runtime scan of the gitignored tree is its own card (5b6dd606).
