import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Card 00499708 (WhiteHat2 O1 off d95f71c9, comment 17952): scripts/watchdog.sh's sub-agent
// restarter carried only CLAUDE_CODE_DISABLE_AGENT_VIEW=1 while d95f71c9 fixed the SAME missing
// protective env on the three (then four, bf39d8a2) main-agent respawn paths. A watchdog-triggered
// sub-agent restart reopened the 23h feedback-survey freeze / MCP-registration-timeout outage those
// vars exist to prevent. This pins the full set on THIS restarter, matching the existing
// channel-stability-contract.test.ts pattern used for the main-agent paths.

const ROOT = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

// Strip comments so the assertion checks actual code, not the prose explaining it.
const stripBashComments = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')

const REQUIRED_ENV = [
  'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false',
  'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1',
  'CLAUDE_CODE_DISABLE_AGENT_VIEW=1',
  'MCP_SERVER_CONNECTION_BATCH_SIZE=10',
  'MCP_CONNECTION_NONBLOCKING=1',
  'MCP_TIMEOUT=60000',
]

describe('watchdog.sh sub-agent restarter carries the full protective env set (card 00499708)', () => {
  const sh = stripBashComments(read('scripts/watchdog.sh'))
  // Anchored on the unique prefix of the sub-agent restart CMD assignment, not a line number --
  // line numbers drift (the card named :341, the fix landed at :346).
  const cmdLine = sh.split('\n').find((l) => l.trim().startsWith('CMD="${ISO_ENV}export PATH='))

  it('the sub-agent restart CMD line exists', () => {
    expect(cmdLine).toBeTruthy()
  })

  for (const v of REQUIRED_ENV) {
    it(`carries ${v}`, () => {
      expect(cmdLine).toContain(v)
    })
  }

  it('exports the protective env before invoking the claude binary', () => {
    const idx = cmdLine!.indexOf('MCP_SERVER_CONNECTION_BATCH_SIZE')
    const claudeIdx = cmdLine!.indexOf('${CLAUDE_BIN}')
    expect(idx).toBeGreaterThan(-1)
    expect(claudeIdx).toBeGreaterThan(-1)
    expect(idx).toBeLessThan(claudeIdx)
  })
})
