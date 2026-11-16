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

// Card e3cf26d0: isDegradedOrchestratorBlocking()/degradedOrchestratorRefusal() no longer take a
// path (RedHat/WhiteHat LOW, see degraded-orchestrator-guard.ts's own comment) -- these drive
// them the same way every real caller does, via the env override, for the tests below that need
// a specific fixture FILE that exists (not the missing-file case, which has its own dedicated
// tests above/below using the genuine no-override default).
function withEnvOverride<T>(path: string, fn: () => T): T {
  const prev = process.env.DEGRADED_ORCHESTRATOR_SWITCH
  process.env.DEGRADED_ORCHESTRATOR_SWITCH = path
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.DEGRADED_ORCHESTRATOR_SWITCH
    else process.env.DEGRADED_ORCHESTRATOR_SWITCH = prev
  }
}

describe('readDegradedOrchestratorState (card d5638d28)', () => {
  it('missing file = off (Kesz, ha #1)', () => {
    withSwitchFile(null, (path) => {
      expect(readDegradedOrchestratorState(path)).toBe('off')
    })
    // isDegradedOrchestratorBlocking() itself (no path param, card e3cf26d0) against the
    // genuine default-missing case is covered by the dedicated test below.
  })

  it('{"enabled": true} = on', () => {
    withSwitchFile('{"enabled": true}', (path) => {
      expect(readDegradedOrchestratorState(path)).toBe('on')
      expect(withEnvOverride(path, () => isDegradedOrchestratorBlocking())).toBe(true)
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
      expect(withEnvOverride(path, () => isDegradedOrchestratorBlocking())).toBe(true)
    })
  })

  // Round 2 (CYBERED NO-GO 32207 F3, MikroB Fix-Direction 32209 #3): the ONE switch-file contract
  // is now stricter than "parsed?.enabled === true ? on : off" -- only {"enabled": true|false}
  // with a real JSON boolean is valid; EVERYTHING else that parses (wrong shape, wrong type,
  // extra/typo key) is 'unreadable' (blocks), not 'off'. The old behaviour silently read every one
  // of these as OFF, which is exactly the split RedHat measured against the bash land guard.
  it('{} (missing the enabled key) is now invalid shape -> unreadable (blocks), not off', () => {
    withSwitchFile('{}', (path) => {
      expect(readDegradedOrchestratorState(path)).toBe('unreadable')
      expect(withEnvOverride(path, () => isDegradedOrchestratorBlocking())).toBe(true)
    })
  })

  it('a typo key ({"Enabled": true}) is invalid shape -> unreadable', () => {
    withSwitchFile('{"Enabled": true}', (path) => {
      expect(readDegradedOrchestratorState(path)).toBe('unreadable')
    })
  })

  it('an extra key alongside enabled is invalid shape -> unreadable', () => {
    withSwitchFile('{"enabled": false, "note": "why"}', (path) => {
      expect(readDegradedOrchestratorState(path)).toBe('unreadable')
    })
  })

  it.each([
    ['true', 'true'],
    ['[]', '[]'],
    ['"on"', '"on"'],
    ['1', '1'],
    ['null', 'null'],
  ])('a bare top-level %s (not an {enabled} object) is invalid shape -> unreadable', (_label, json) => {
    withSwitchFile(json, (path) => {
      expect(readDegradedOrchestratorState(path)).toBe('unreadable')
    })
  })

  it('{"enabled": "true"} (string, not boolean) is invalid shape -> unreadable', () => {
    withSwitchFile('{"enabled": "true"}', (path) => {
      expect(readDegradedOrchestratorState(path)).toBe('unreadable')
    })
  })

  it('{"enabled": 1} (number, not boolean) is invalid shape -> unreadable', () => {
    withSwitchFile('{"enabled": 1}', (path) => {
      expect(readDegradedOrchestratorState(path)).toBe('unreadable')
    })
  })

  it('the only two valid shapes still read exactly as their boolean says', () => {
    withSwitchFile('{"enabled": true}', (path) => expect(readDegradedOrchestratorState(path)).toBe('on'))
    withSwitchFile('{"enabled": false}', (path) => expect(readDegradedOrchestratorState(path)).toBe('off'))
  })

  // Round 4 (CYBERED NO-GO 32270 Finding 1, MikroB decision 32246(b)): an EXPLICIT
  // DEGRADED_ORCHESTRATOR_SWITCH override that resolves to nothing is a caller-controlled
  // misconfiguration, not evidence the owner turned degraded mode off -- same posture as the bash
  // land guard already has. Unlike every other test in this file (which pass an explicit `path`
  // argument, keeping the old missing-path-is-off behaviour on purpose), this one drives the env
  // var directly with NO path argument, the exact shape every real caller (routes, agent-process)
  // actually uses.
  it('an env-override path that does not exist is unreadable (blocks), NOT off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'degraded-guard-override-missing-'))
    const missingPath = join(dir, 'does-not-exist.json')
    const prev = process.env.DEGRADED_ORCHESTRATOR_SWITCH
    process.env.DEGRADED_ORCHESTRATOR_SWITCH = missingPath
    try {
      expect(readDegradedOrchestratorState()).toBe('unreadable')
      expect(isDegradedOrchestratorBlocking()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.DEGRADED_ORCHESTRATOR_SWITCH
      else process.env.DEGRADED_ORCHESTRATOR_SWITCH = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Card e3cf26d0 (WhiteHat LOW-1 on d5638d28): every test above either passes an explicit
  // `path` or sets the env override -- nothing ever exercised the GENUINE production default
  // (no override, no explicit path argument, the real degradedOrchestratorSwitchPath()). A
  // mutant that made that branch 'unreadable' too (same as the override-missing rule) stayed
  // green, because nothing asserted the Kesz-ha-#1 contract against the literal default path.
  // Safe to run for real: fleet-test.sh builds a throwaway checkout (no CLAUDECLAW_ENV_DIR state
  // of its own), so PROJECT_ROOT/store/degraded-orchestrator-enabled.json never exists there --
  // this reads it, never writes it.
  it('the genuine default path (no override, no explicit path arg) missing is OFF (Kesz, ha #1)', () => {
    const prev = process.env.DEGRADED_ORCHESTRATOR_SWITCH
    delete process.env.DEGRADED_ORCHESTRATOR_SWITCH
    try {
      expect(readDegradedOrchestratorState()).toBe('off')
      expect(isDegradedOrchestratorBlocking()).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.DEGRADED_ORCHESTRATOR_SWITCH
      else process.env.DEGRADED_ORCHESTRATOR_SWITCH = prev
    }
  })

  // MUTATION PIN: an explicit `path` ARGUMENT that is missing stays OFF even while
  // DEGRADED_ORCHESTRATOR_SWITCH happens to be set in the environment to something else -- the
  // override rule above must key off "was the env var used" (no argument given), not "is the env
  // var merely set somewhere" while a caller also passed its own path.
  it('an explicit path argument that is missing stays OFF even with an unrelated env override set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'degraded-guard-explicit-missing-'))
    const explicitMissingPath = join(dir, 'also-does-not-exist.json')
    const envPath = join(dir, 'env-path-irrelevant.json')
    const prev = process.env.DEGRADED_ORCHESTRATOR_SWITCH
    process.env.DEGRADED_ORCHESTRATOR_SWITCH = envPath
    try {
      expect(readDegradedOrchestratorState(explicitMissingPath)).toBe('off')
    } finally {
      if (prev === undefined) delete process.env.DEGRADED_ORCHESTRATOR_SWITCH
      else process.env.DEGRADED_ORCHESTRATOR_SWITCH = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('degradedOrchestratorRefusal (card d5638d28)', () => {
  it('refuses when degraded is on and no force-actor bypass is given', () => {
    withSwitchFile('{"enabled": true}', (path) => {
      const refusal = withEnvOverride(path, () => degradedOrchestratorRefusal('kanban move to done', false, undefined))
      expect(refusal).not.toBeNull()
      expect(refusal).toContain('d5638d28')
    })
  })

  it('refuses even with force:true when the actor is NOT the owner-bypass allowlist', () => {
    withSwitchFile('{"enabled": true}', (path) => {
      expect(
        withEnvOverride(path, () => degradedOrchestratorRefusal('agent start', true, 'degraded-orchestrator-loop')),
      ).not.toBeNull()
    })
  })

  it('passes for the owner bypass (force:true, actor:"mikrob") even while degraded', () => {
    withSwitchFile('{"enabled": true}', (path) => {
      expect(withEnvOverride(path, () => degradedOrchestratorRefusal('agent start', true, 'mikrob'))).toBeNull()
    })
  })

  // Genuine default (no env override, no explicit path -- card e3cf26d0 dropped the path
  // parameter from this function), NOT a fixture file simulating "off": the real missing-default
  // contract is what matters here, same reasoning as the dedicated LOW-1 test above.
  it('passes when degraded is off, regardless of actor', () => {
    const prev = process.env.DEGRADED_ORCHESTRATOR_SWITCH
    delete process.env.DEGRADED_ORCHESTRATOR_SWITCH
    try {
      expect(degradedOrchestratorRefusal('kanban move to done', false, 'some-other-agent')).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.DEGRADED_ORCHESTRATOR_SWITCH
      else process.env.DEGRADED_ORCHESTRATOR_SWITCH = prev
    }
  })

  it('refuses fail-closed on an unreadable file even for a non-owner actor', () => {
    withSwitchFile('{garbage', (path) => {
      expect(withEnvOverride(path, () => degradedOrchestratorRefusal('marveen-land', false, 'fullstack'))).not.toBeNull()
    })
  })
})
