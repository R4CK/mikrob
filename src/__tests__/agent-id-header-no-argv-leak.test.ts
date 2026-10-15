import { describe, it, expect } from 'vitest'
import { buildAgentIdHeaderBody } from '../web/agent-scaffold.js'

// Card e73b17ef: upstream's a30553d6 ("Security infra package #1357") shipped
// buildAgentIdHeaderBody() with `-H "Authorization: Bearer $(cat ...)"`, a literal
// curl argv -- readable via /proc/<pid>/cmdline by any other local process on this
// host. This generator renders into every agent's CLAUDE.md (and the main one), so
// the leak shipped fleet-wide and tripped token-in-argv-guard.test.ts 8 times on
// origin/develop, blocking every landing. Pinned here the same way the sibling
// buildSystemDirectiveAuthBody already is (system-directive-auth-section.test.ts).
describe('buildAgentIdHeaderBody does NOT leak the token into curl argv', () => {
  it('reads the Authorization header from stdin, never as a literal -H argument', () => {
    const body = buildAgentIdHeaderBody('agent-a')
    expect(body).toContain("printf 'Authorization: Bearer %s\\n'")
    expect(body).toContain('-H @-')
    expect(body).not.toContain('-H "Authorization: Bearer')
  })

  it('still names the caller in X-Agent-Id, for the agent this was generated for', () => {
    const body = buildAgentIdHeaderBody('agent-a')
    expect(body).toContain('-H "X-Agent-Id: agent-a"')
  })
})
