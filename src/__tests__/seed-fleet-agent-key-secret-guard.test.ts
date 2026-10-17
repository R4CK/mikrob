// Card c188f357 (RedHat F-N1 on 9c7ad372): the agent-key-secret-guard PreToolUse hook
// (scripts/hooks/agent-key-secret-guard.py, card 9c7ad372 O5) is wired into every LIVE agent's
// settings.json at dashboard boot (ensureAgentKeySecretGuard, src/web.ts) and into every freshly
// scaffolded sub-agent (injectAgentKeySecretGuard) -- but a FRESH install provisions a brand-new
// agent straight from seed-fleet-agents/<name>/.claude/settings.json, before the dashboard ever
// boots against it. Measured on this checkout: zero of the 14 seed templates that already carry
// a "Bash" PreToolUse matcher (git-protect-guard.py's own group) also carry agent-key-secret-guard
// -- the exact gap F-N1 names ("ma nincs bekötve az ügynökök settings.json-jába"). Same class of
// drift card 7b12182a fixed for shared-memory-inject.py's --agent flag: the live migration exists,
// but a fresh install never runs it, so the seed template itself must also carry the entry.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SEED_ROOT = join(import.meta.dirname, '..', '..', 'seed-fleet-agents')

// Every seed agent whose settings.json already carries a "Bash" PreToolUse matcher group
// (git-protect-guard.py's own group, present on all but 2 of the 16 seed dirs -- those 2 are
// out of this card's scope, same surgical-change discipline as 7b12182a's own fix).
const SEED_AGENTS = [
  'backend', 'backend2', 'cybersec', 'fron-ted', 'fron-teddy', 'fullstack',
  'jogasz', 'marketing', 'penzugy', 'qa', 'qa2', 'videooo',
] as const

describe('seed-fleet-agents carry the agent-key-secret-guard hook (card c188f357, RedHat F-N1)', () => {
  for (const agent of SEED_AGENTS) {
    it(`${agent}: seed settings.json wires agent-key-secret-guard.py as a Bash PreToolUse hook`, () => {
      const p = join(SEED_ROOT, agent, '.claude', 'settings.json')
      expect(existsSync(p)).toBe(true)
      const settings = JSON.parse(readFileSync(p, 'utf-8')) as {
        hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> }
      }
      const ptu = settings.hooks?.PreToolUse ?? []
      const found = ptu.some(
        (group) =>
          group.matcher === 'Bash' &&
          (group.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes('agent-key-secret-guard.py')),
      )
      expect(found).toBe(true)
    })
  }
})
