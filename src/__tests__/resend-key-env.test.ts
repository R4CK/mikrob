import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasResendApiKey, resendApiKeyExport, RESEND_API_KEY_PATH } from '../web/agent-process.js'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'

// Card 8c2bae37. The live Resend API key sat in plaintext in the `resend` MCP
// server's Authorization header inside every agent's
// agents/<name>/.claude-config/.claude.json, the shared ~/.claude.json those
// are seeded from, and the worker config dirs -- a credential usable from
// anywhere any copy of those files travelled (backup, support bundle, a copied
// home dir). The fix keeps the header but makes it a "Bearer ${RESEND_API_KEY}"
// placeholder, which Claude Code expands from the environment when it connects
// the MCP server; the key itself lives 0600 in store/.resend-api-key and each
// launcher reads it at launch time via $(cat).
//
// Rotation (step (a) of the card) was explicitly dropped by Peti on
// 2026-08-13; these tests cover step (b) only.

const dir = mkdtempSync(join(tmpdir(), 'resend-key-'))
const KEY_FILE = join(dir, '.resend-api-key')
const ABSENT = join(dir, 'no-such-key-file')

describe('resend key env export helper', () => {
  it('emits no export at all when the key file is absent', () => {
    // A launcher on an install without the key must be byte-identical to the
    // pre-change one. Claude Code then leaves the header unexpanded and says so
    // (`Missing environment variables: RESEND_API_KEY`), and the Resend calls
    // fail -- specifically NOT a fallback to some baked-in key.
    expect(hasResendApiKey(ABSENT)).toBe(false)
    expect(resendApiKeyExport(' && ', ABSENT)).toBe('')
  })

  it('treats an empty / whitespace-only key file as absent', () => {
    const blank = join(dir, '.blank-key')
    writeFileSync(blank, '  \n')
    expect(hasResendApiKey(blank)).toBe(false)
    expect(resendApiKeyExport(' && ', blank)).toBe('')
  })

  it('exports the key by $(cat) reference, never the value itself', () => {
    writeFileSync(KEY_FILE, 're_TESTKEY_notarealkey\n')
    const snippet = resendApiKeyExport(' && ', KEY_FILE)
    // The whole point: the secret must not appear in the command string we
    // build, so it cannot land in argv / `ps` / a logged command.
    expect(snippet).not.toContain('re_TESTKEY_notarealkey')
    expect(snippet).toContain(`$(cat '${KEY_FILE}')`)
    expect(snippet).toContain('export RESEND_API_KEY=')
  })

  it('appends the separator the caller chains with', () => {
    writeFileSync(KEY_FILE, 're_TESTKEY_notarealkey\n')
    expect(resendApiKeyExport(' && ', KEY_FILE).endsWith(' && ')).toBe(true)
    expect(resendApiKeyExport('; ', KEY_FILE).endsWith('; ')).toBe(true)
    expect(resendApiKeyExport('', KEY_FILE).endsWith('\')"')).toBe(true)
  })
})

describe('every launcher that starts a claude session supplies RESEND_API_KEY', () => {
  // Four launch sinks read a config root carrying the placeholder. Missing the
  // export in any ONE of them means agents started through that path silently
  // lose Resend (unexpanded header -> 401), which is exactly the kind of
  // partial rollout that looks fine until the one broken path is used.
  const SINKS: Array<[string, string]> = [
    ['agent-process.ts (fleet sub-agents)', 'src/web/agent-process.ts'],
    ['channel-monitor.ts (main-session respawn)', 'src/web/channel-monitor.ts'],
    ['agent-worker.ts (worker sessions)', 'src/web/agent-worker.ts'],
    ['channels.sh (main agent cold boot)', 'scripts/channels.sh'],
  ]

  for (const [label, rel] of SINKS) {
    it(`${label} references RESEND_API_KEY and reads it via $(cat)`, () => {
      const src = readFileSync(join(__dirname, '../..', rel), 'utf-8')
      expect(src).toContain('RESEND_API_KEY')
      expect(src).toMatch(/\$\(cat\s+/)
    })
  }

  it('the main-session respawn command carries the export when the key is present', () => {
    const withKey = buildMainSessionRespawnCmd({
      claudePath: '/usr/bin/claude',
      pluginId: 'telegram',
      model: 'claude-opus-5',
      continueSession: false,
      resendKey: true,
    })
    expect(withKey).toContain('export RESEND_API_KEY="$(cat ')
    expect(withKey).toContain(RESEND_API_KEY_PATH)

    const withoutKey = buildMainSessionRespawnCmd({
      claudePath: '/usr/bin/claude',
      pluginId: 'telegram',
      model: 'claude-opus-5',
      continueSession: false,
    })
    expect(withoutKey).not.toContain('RESEND_API_KEY')
  })
})

// NOTE, deliberately NOT a test here: scanning the live agents/<name>/
// .claude-config/.claude.json files for a leftover literal key cannot live in
// this suite. The suite runs in a disposable worktree (store/fleet-test.sh)
// that has no agents/ tree at all, so such a test would be vacuously green
// exactly where it runs. The live-tree scan is done as release evidence, and a
// recurring runtime scan of the gitignored tree is its own card (5b6dd606).
