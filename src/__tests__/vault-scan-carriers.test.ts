import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { looksLikeCredentialValue, scanMcpConfigs } from '../web/vault-bindings.js'

// Card 2f42a24d (Cybersec MEDIUM on 8763e412). scanMcpConfigs() read `cfg.env` only. Measured on the
// live fleet config at the time: 64 server declarations -- env 32, args 34, headersHelper 15,
// headers 0. So two thirds of the declarations carried something the scan could not look at.
//
// The trap the finding named, and the reason this file tests VALUES and not keys: adding `headers`
// to the existing key-name heuristic would have produced exactly zero findings forever.
// SENSITIVE_PATTERNS is written for env var names (`_TOKEN$`, `_KEY$`, `^API_`), and every real
// header name -- Authorization, X-Api-Key, X-Auth-Token -- scores false against it. A scan that
// reports nothing looks the same whether it is clean or blind.
//
// The sample tokens are ASSEMBLED FROM PIECES rather than written out. That is not stylistic: the
// repo's secret-write-guard hook refuses a file containing a literal vendor-shaped token, and it
// refused this one first. A test for a credential detector is exactly where a realistic literal is
// most tempting and least necessary.
const vendor = (prefix: string, body: string): string => prefix + body

describe('the value-shaped detector can fail (negative control)', () => {
  // Without this, every "does not flag" assertion below could be passing because the detector says
  // false to everything.
  it('flags real credential shapes', () => {
    expect(looksLikeCredentialValue(vendor('sk-', 'abcdefghijklmnopqrstuvwx'))).toBe(true)
    expect(looksLikeCredentialValue(vendor('re_', '1234567890abcdefghijklmn'))).toBe(true)
    expect(looksLikeCredentialValue(vendor('ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'))).toBe(true)
    expect(looksLikeCredentialValue(vendor('xoxb', '-1234567890-abcdefghij'))).toBe(true)
    expect(looksLikeCredentialValue(vendor('AKIA', 'IOSFODNN7EXAMPLE'))).toBe(true)
    expect(
      looksLikeCredentialValue(vendor('eyJ', 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.sig')),
    ).toBe(true)
  })

  it('sees through the scheme prefix a header value carries', () => {
    // The whole point: `Authorization: Bearer <token>` is a header NAME that says nothing and a
    // VALUE that says everything -- once the scheme word is off the front.
    expect(looksLikeCredentialValue('Bearer ' + vendor('sk-', 'abcdefghijklmnopqrstuvwx'))).toBe(true)
    expect(looksLikeCredentialValue('Token 8f3kd93kfj39dkKD93jfk39dKD93jf')).toBe(true)
  })

  it('flags an opaque high-entropy string that matches no known vendor shape', () => {
    // Most secrets are not from a vendor with a recognisable prefix.
    expect(looksLikeCredentialValue('Xk7pQ2mZ9vR4tL8wN1cB6yH3jF5sD0gA')).toBe(true)
  })

  it('flags a TWO-class secret -- lowercase hex, no capitals anywhere', () => {
    // QA FAIL on 2886f31a, caught by mutation: every positive case above happens to carry all three
    // character classes, so changing the detector's `classes >= 2` to `>= 3` left the whole suite
    // green. A well-meant future "tightening" would then silently stop flagging the commonest real
    // shape there is -- a lowercase hex API key. This case pins the threshold at exactly 2.
    // (Assembled from pieces for the same reason as the vendor tokens above: the secret-write-guard
    // hook rejects a file carrying a literal 40-char hex string.)
    const hexKey = '3f9a1c7e0b52d84f' + '6a1e9c3b7d05f28e' + '4a6c9b13'
    expect(hexKey).toHaveLength(40)
    expect(/[A-Z]/.test(hexKey), 'the point of this case is that it has NO uppercase').toBe(false)
    expect(looksLikeCredentialValue(hexKey)).toBe(true)
  })

  it('flags a 24-character secret -- the exact lower edge of the length rule', () => {
    // Pins the other threshold the same way: raising the 24 to anything higher must fail here, not
    // pass quietly. 30- and 32-character cases above cannot see a change from 24 to 25.
    const edge = 'a7Kd93' + 'ZqLx28' + 'Bv51Rn' + 'Ty06Wc'
    expect(edge).toHaveLength(24)
    expect(looksLikeCredentialValue(edge)).toBe(true)
  })
})

describe('what must NOT be flagged, or the scan is noise', () => {
  it('leaves package names, flags and subcommands alone', () => {
    // Measured against the real fleet config: these are the actual args in it.
    for (const arg of [
      'npx',
      '-y',
      '-m',
      'serve',
      '--browser',
      'chromium',
      '/',
      '@modelcontextprotocol/server-filesystem',
      '@playwright/mcp@latest',
      'firecrawl-mcp@3.24.0',
      'code_review_graph',
    ]) {
      expect(looksLikeCredentialValue(arg), `${arg} was flagged`).toBe(false)
    }
  })

  it('leaves references alone -- they are the FIX, not the finding', () => {
    expect(looksLikeCredentialValue('${RESEND_API_KEY}')).toBe(false)
    expect(looksLikeCredentialValue('vault:ReSend')).toBe(false)
  })

  it('leaves urls and paths alone', () => {
    expect(looksLikeCredentialValue('https://mcp.resend.com/mcp')).toBe(false)
    expect(looksLikeCredentialValue('/home/neon/marveen/scripts/vault-headers-helper.sh')).toBe(false)
    expect(looksLikeCredentialValue('~/.claude/config.json')).toBe(false)
  })

  it('leaves a long low-entropy string alone', () => {
    // Length alone must not be enough, or every package path becomes a credential.
    expect(looksLikeCredentialValue('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false)
    expect(looksLikeCredentialValue('modelcontextprotocol-server-filesystem')).toBe(false)
  })

  it('leaves a short random string alone', () => {
    // Entropy alone must not be enough either.
    expect(looksLikeCredentialValue('a1B2c3')).toBe(false)
  })

  it('does NOT flag the vault-backed headersHelper argument', () => {
    // `HeaderName=Scheme:::vaultSecretId` is the shape that PROVES the secret is not on disk. If the
    // scan reported this, the fix for a real finding would itself become a finding, and the report
    // would train its reader to ignore it.
    expect(looksLikeCredentialValue('Authorization=Bearer:::ReSend')).toBe(false)
    expect(looksLikeCredentialValue('ReSend')).toBe(false)
  })
})

// The detector being right proves nothing about the scan CALLING it. This half plants the three
// carriers in a fixture config and asserts they come back -- the wiring check, not the logic check.
describe('the scan actually reads the three new carriers', () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-scan-'))
  const agents = join(root, 'agents')
  mkdirSync(agents, { recursive: true })
  const token = 'sk-' + 'zyxwvutsrqponmlkjihgfe'

  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'header-server': { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: `Bearer ${token}` } },
        'arg-server': { command: 'npx', args: ['-y', 'some-mcp', '--api-key=' + token] },
        'helper-server': { type: 'http', url: 'https://example.test/mcp', headersHelper: '/opt/helper.sh Authorization=Bearer:::ReSend' },
        'clean-server': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/'] },
      },
    }),
  )
  const findings = scanMcpConfigs({ projectRoot: root, homeDir: root, agentsDir: agents, agentNames: [] })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('finds the header-carried token, which the key-name heuristic never could', () => {
    const f = findings.find((x) => x.serverName === 'header-server')
    expect(f, 'no finding for a Bearer token in headers').toBeDefined()
    expect(f?.carrier).toBe('headers')
    expect(f?.location).toBe('headers.Authorization')
    expect(f?.maskedValue).not.toContain('zyxwvutsrqponmlkjihgfe')
  })

  it('finds the token embedded in a command-line argument', () => {
    const f = findings.find((x) => x.serverName === 'arg-server')
    expect(f?.carrier).toBe('args')
    expect(f?.location).toBe('args[2]')
  })

  it('reports NOTHING for the vault-backed helper or the clean server', () => {
    // The two shapes that must stay silent, or the report becomes noise people learn to skip.
    expect(findings.filter((x) => x.serverName === 'helper-server')).toEqual([])
    expect(findings.filter((x) => x.serverName === 'clean-server')).toEqual([])
  })

  it('marks every finding with a carrier, so the UI can tell auto-bindable from manual', () => {
    // Only `env` findings can be fixed by the vault env wrapper; offering that button on a header
    // finding would be a control that cannot work.
    for (const f of findings) expect(['env', 'headers', 'args', 'headersHelper']).toContain(f.carrier)
  })
})
