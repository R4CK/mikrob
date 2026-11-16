// Card d5638d28: structural refusal guard for the degraded-orchestrator kill switch. MikroB
// decision (inter-agent msg 19506) demanded the "no done/land/agent-start while degraded"
// restriction be enforced AT THE ENDPOINTS, not trusted to the loop's own self-restraint -- this
// pins the shared decision function three call sites (kanban move, agent start, marveen-land.sh's
// bash port) all rely on.
import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readDegradedOrchestratorState,
  isDegradedOrchestratorBlocking,
  degradedOrchestratorRefusal,
} from '../degraded-orchestrator-guard.js'

function withSwitchFile(contents: string | null, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'degraded-guard-'))
  const path = join(dir, 'degraded-orchestrator-enabled.json')
  try {
    if (contents !== null) writeFileSync(path, contents)
    fn(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('readDegradedOrchestratorState (card d5638d28)', () => {
  it('missing file = off (Kesz, ha #1)', () => {
    withSwitchFile(null, (path) => {
      expect(readDegradedOrchestratorState(path)).toBe('off')
      expect(isDegradedOrchestratorBlocking(path)).toBe(false)
    })
  })

  it('{"enabled": true} = on', () => {
    withSwitchFile('{"enabled": true}', (path) => {
      expect(readDegradedOrchestratorState(path)).toBe('on')
      expect(isDegradedOrchestratorBlocking(path)).toBe(true)
    })
  })

  it('{"enabled": false} = off', () => {
    withSwitchFile('{"enabled": false}', (path) => {
      expect(readDegradedOrchestratorState(path)).toBe('off')
    })
  })

  it('malformed JSON fails CLOSED (unreadable -> blocking), not open (MikroB msg 19506)', () => {
    withSwitchFile('{not valid json', (path) => {
      expect(readDegradedOrchestratorState(path)).toBe('unreadable')
      expect(isDegradedOrchestratorBlocking(path)).toBe(true)
    })
  })

  it('valid JSON missing the enabled key = off (absence of the flag, not corruption)', () => {
    withSwitchFile('{}', (path) => {
      expect(readDegradedOrchestratorState(path)).toBe('off')
    })
  })
})

describe('degradedOrchestratorRefusal (card d5638d28)', () => {
  it('refuses when degraded is on and no force-actor bypass is given', () => {
    withSwitchFile('{"enabled": true}', (path) => {
      const refusal = degradedOrchestratorRefusal('kanban move to done', false, undefined, path)
      expect(refusal).not.toBeNull()
      expect(refusal).toContain('d5638d28')
    })
  })

  it('refuses even with force:true when the actor is NOT the owner-bypass allowlist', () => {
    withSwitchFile('{"enabled": true}', (path) => {
      expect(degradedOrchestratorRefusal('agent start', true, 'degraded-orchestrator-loop', path)).not.toBeNull()
    })
  })

  it('passes for the owner bypass (force:true, actor:"mikrob") even while degraded', () => {
    withSwitchFile('{"enabled": true}', (path) => {
      expect(degradedOrchestratorRefusal('agent start', true, 'mikrob', path)).toBeNull()
    })
  })

  it('passes when degraded is off, regardless of actor', () => {
    withSwitchFile(null, (path) => {
      expect(degradedOrchestratorRefusal('kanban move to done', false, 'some-other-agent', path)).toBeNull()
    })
  })

  it('refuses fail-closed on an unreadable file even for a non-owner actor', () => {
    withSwitchFile('{garbage', (path) => {
      expect(degradedOrchestratorRefusal('marveen-land', false, 'fullstack', path)).not.toBeNull()
    })
  })
})
