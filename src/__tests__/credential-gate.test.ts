import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// CREDGATE1003 (card 42d952bc): scripts/hooks/credential-gate.py has no vitest wrapper, so its own
// 593-line python suite (scripts/__tests__/credential-gate.test.py, including the fork-only
// test_fork_mcp_send_classification pin) only runs when someone invokes it by hand (Cybersec F1,
// comment 27301). This file makes it a CI gate, same shape as email-approval-gate.test.ts.
const ROOT = join(__dirname, '..', '..')

describe('credential gate (CREDGATE1003)', () => {
  it('the python suite passes (detection, ack/shared/alias, fail-closed, fork mcp-send reuse)', () => {
    const res = spawnSync('python3', [join(ROOT, 'scripts', '__tests__', 'credential-gate.test.py')], {
      encoding: 'utf-8',
      timeout: 120_000,
    })
    if (res.status !== 0) {
      console.error(res.stdout)
      console.error(res.stderr)
    }
    expect(res.status).toBe(0)
  }, 130_000)
})
