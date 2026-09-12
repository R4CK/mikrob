// Card fc156856 (Cybersec on the f0389e81 gate): the context7 quarantine grant leaves a trace, and
// a context7 denial says something a reader can act on.
//
// MEDIUM, CWE-778. `main()` wrote an ALLOWED_QUARANTINE line only for the WebFetch/Firecrawl
// quarantine tier. context7 is the OTHER grant a main agent cannot obtain, and it left no trace at
// all -- neither an incident review nor store/fetch-budget.py could see that it had been used, even
// though this file's own header prescribes an audited grant. Measured before the fix: a WebFetch
// quarantine grant moved the log 210 -> 211, a context7 quarantine grant 211 -> 211.
//
// WHY A SUBPROCESS AND NOT egressDecision(). The decision function was already right -- it returns
// the `quarantine-context7` tier. The defect was in what main() DOES with that tier, which no
// importable function exposes. Testing the decision would have kept passing through the whole
// defect; the card says as much ("jelenleg nincs teszt a logolasra, ezert zold a suite most is").
// So this drives the real entry point: JSON on stdin, log on disk, deny payload on stdout.
//
// EGRESS_GATE_SELFTEST=1 prefixes every line this test writes with SELFTEST_, so the lines it adds
// to the shared store/egress-blocked.log are excluded from the operator's counts by construction.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'egress-gate.mjs')
const LOG = join(ROOT, 'store', 'egress-blocked.log')
const QUARANTINE = 'quarantine-reader'

const selftestLines = (): string[] =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf-8').split('\n').filter((l) => l.includes('SELFTEST_'))
    : []

/** Run the hook the way the PreToolUse harness does, and report what it did AND what it recorded. */
function run(toolName: string, toolInput: unknown, agentType?: string) {
  const before = selftestLines().length
  const payload: Record<string, unknown> = { tool_name: toolName, tool_input: toolInput }
  if (agentType !== undefined) payload['agent_type'] = agentType
  const stdout = execFileSync(process.execPath, [HOOK], {
    env: { ...process.env, EGRESS_GATE_SELFTEST: '1' },
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
  const added = selftestLines().slice(before)
  return { decision: stdout.trim() === '' ? 'ALLOW' : 'DENY', message: stdout, added }
}

describe('the context7 quarantine grant is audited (card fc156856)', () => {
  it('a context7 call by the quarantine reader is ALLOWED and RECORDED', () => {
    const r = run('mcp__context7__query-docs', { libraryId: '/vercel/next.js', query: 'routing' }, QUARANTINE)
    expect(r.decision).toBe('ALLOW')
    // The founding defect in one assertion: before the fix this array was empty.
    expect(r.added.length, 'the context7 grant left no trace').toBe(1)
    expect(r.added[0]).toContain('SELFTEST_ALLOWED_QUARANTINE')
    expect(r.added[0]).toContain('quarantine-context7')
    // The tool name stands in for the url, because a context7 call has none -- an empty url=""
    // would read as a missing value rather than an absent one.
    expect(r.added[0]).toContain('mcp__context7__query-docs')
    expect(r.added[0]).toContain(`agent_type="${QUARANTINE}"`)
  })

  it('CONTROL: the WebFetch quarantine grant still records, so the fix did not move the old line', () => {
    const r = run('WebFetch', { url: 'https://hnrss.org/frontpage' }, QUARANTINE)
    expect(r.decision).toBe('ALLOW')
    expect(r.added.length).toBe(1)
    expect(r.added[0]).toContain('quarantine-reader tier')
  })

  it('CONTROL: an ordinary allowlist hit stays QUIET -- the audit is for the grants, not for traffic', () => {
    const r = run('WebFetch', { url: 'https://api.github.com/repos/a/b' })
    expect(r.decision).toBe('ALLOW')
    expect(r.added.length).toBe(0)
  })
})

describe('a context7 denial names a remedy that works (card fc156856, LOW #1)', () => {
  const denial = () => run('mcp__context7__resolve-library-id', { query: 'next.js' })

  it('a main agent is denied', () => {
    expect(denial().decision).toBe('DENY')
  })

  it('it does NOT send the reader to edit the allowlist, which cannot affect this decision', () => {
    // The generic BLOCK_MESSAGE tells the operator to add the URL or domain to the allowlist, and
    // following that here wastes ten minutes on a file with no bearing on an agentType-based tier.
    // The assertion is on the INSTRUCTION, not on the filename: naming the file to say "editing it
    // will not help" is better than silence, because it heads off the attempt.
    const m = denial().message
    expect(m).not.toContain('adja hozzá az URL-t vagy domain-t')
    expect(m).toMatch(/egress-allowlist\.json[^.]*NEM oldja fel/)
    // The FETCH-url protocol is the WebFetch reader's; context7 takes a library question.
    expect(m).not.toContain('FETCH {"url"')
  })

  it('it names the tier, the sub-agent, and that the answer is untrusted content', () => {
    const m = denial().message
    expect(m).toContain('context7')
    expect(m).toContain('quarantine-reader')
    expect(m).toMatch(/adatk[eé]nt/i)
  })

  it('CONTROL: the generic message is still used for an ordinary URL denial', () => {
    const m = run('WebFetch', { url: 'https://hnrss.org/frontpage' }).message
    expect(m).toContain('egress-allowlist.json')
  })
})

describe('the tier is decided by agentType, never by the tool schema (card fc156856, LOW #2)', () => {
  // The header's "these two tools take only free text" measurement was made on the pinned npm dist
  // (@upstash/context7-mcp 4.0.3). What actually runs is declared in a GITIGNORED .mcp.json as a
  // REMOTE http server, which serves its own schema at connect time and can grow a url/action/exec
  // field with nothing on our side changing. That measurement therefore cannot be load-bearing --
  // and it is not: these two cases pin the property that actually protects us.
  const FUTURE = 'mcp__context7__some_tool_that_does_not_exist_yet'

  it('an UNKNOWN context7 tool is still denied to a main agent', () => {
    expect(run(FUTURE, { url: 'https://evil.example/exfil', actions: [{ type: 'executeJavascript' }] }).decision)
      .toBe('DENY')
  })

  it('...and still allowed to the quarantine reader, on the namespace alone', () => {
    const r = run(FUTURE, { anything: 'at all' }, QUARANTINE)
    expect(r.decision).toBe('ALLOW')
    expect(r.added.length).toBe(1)
  })
})
