// The reserved sender namespace has to hold at every door into agents/ (card b46a4b7e).
//
// Card 5c5d7bc4 gave the system-directive channel its own sender id and made POST /api/messages
// refuse it, so a shared-token holder cannot CLAIM the id. Cybersec's gate on that card found the
// other half open: nothing stopped anyone from MINTING it. sanitizeAgentName accepts
// `system-directive` (lowercase, one hyphen), and four in-process writers pass an agent's OWN name
// as `from` -- context-guard-runner.ts and context-restart-gate-runner.ts both call
// createAgentMessage(name, MAIN_AGENT_ID, ...). Create an agent by that name and genuine
// from_agent="system-directive" rows exist that sendSystemDirective never wrote, which is exactly
// the one-writer property the rename was bought for.
//
// THREE doors, not the one the finding named: POST /api/agents, the single-agent bundle importer,
// and the fleet bundle importer. All three are in this one file on purpose -- a namespace closure
// split across files is one that gets half-deleted. The 15-line bundle harness is duplicated from
// agent-bundle.test.ts for the same reason.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeAgentName } from '../web/sanitize.js'
import { SYSTEM_DIRECTIVE_SENDER, LEGACY_SYSTEM_SENDER, isReservedSenderId } from '../web/system-directive-id.js'
import {
  importAgentBundle,
  importAllAgentsBundle,
  BUNDLE_SCHEMA_VERSION,
  type BundleManifest,
  type FleetBundleManifest,
} from '../web/agent-bundle.js'

const SRC = join(import.meta.dirname, '..')

function makeAgent(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
}

function packAgentBundle(stageRoot: string, agentName: string): Buffer {
  const manifest: BundleManifest = { schemaVersion: BUNDLE_SCHEMA_VERSION, agentName, includesSecrets: false }
  writeFileSync(join(stageRoot, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const out = join(stageRoot, '..', 'bundle.tar.gz')
  execFileSync('tar', ['-czf', out, '-C', stageRoot, 'manifest.json', 'agent'])
  return readFileSync(out)
}

function packFleetBundle(stageRoot: string, agentNames: string[]): Buffer {
  const manifest: FleetBundleManifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    kind: 'fleet',
    agents: agentNames,
    includesSecrets: false,
  }
  writeFileSync(join(stageRoot, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const out = join(stageRoot, '..', 'fleet.tar.gz')
  execFileSync('tar', ['-czf', out, '-C', stageRoot, 'manifest.json', 'agents'])
  return readFileSync(out)
}

// The predicate is what all three doors delegate to, so its behaviour on the names
// sanitizeAgentName can actually PRODUCE is the substance of the fix.
describe('a display name can sanitize straight INTO the reserved id', () => {
  it.each([
    ['system-directive', SYSTEM_DIRECTIVE_SENDER],
    ['System-Directive', SYSTEM_DIRECTIVE_SENDER],
    ['  SYSTEM-DIRECTIVE  ', SYSTEM_DIRECTIVE_SENDER],
    ['System--Directive', SYSTEM_DIRECTIVE_SENDER],
    ['-system-directive-', SYSTEM_DIRECTIVE_SENDER],
    ['Sÿstem-Dïrective', SYSTEM_DIRECTIVE_SENDER],
    ['System', LEGACY_SYSTEM_SENDER],
  ])('%j sanitizes to %j, and that is reserved', (raw, expected) => {
    const name = sanitizeAgentName(raw)
    expect(name).toBe(expected)
    expect(isReservedSenderId(name)).toBe(true)
  })

  // The check has to run on the SANITIZED name. The predicate is case-insensitive, so a pure
  // case variant is caught even raw -- but anything needing a CHARACTER change is not, and a
  // guard reading the raw value would wave all of these through into agents/.
  it('the RAW forms are not reserved -- a guard before sanitization would miss them', () => {
    for (const raw of ['  SYSTEM-DIRECTIVE  ', 'System--Directive', 'Sÿstem-Dïrective', '-system-directive-']) {
      expect(isReservedSenderId(raw), raw).toBe(false)
    }
    // ...whereas casing alone is already covered by the predicate itself.
    expect(isReservedSenderId('System-Directive')).toBe(true)
  })

  // MEASURED, and it surprised the author of this file: sanitizeAgentName DELETES a space
  // (`[^a-z0-9-]` is removed, not replaced), so a space-separated display name does not reach the
  // reserved id at all -- `System Directive` becomes `systemdirective`. Recorded rather than
  // assumed, because the natural assumption is the opposite. It is also why the guard belongs on
  // the sanitized value: should anyone ever change spaces to map to hyphens, this spelling starts
  // reaching the reserved id and the guard catches it with no further change.
  it('a SPACE-separated form does not reach the reserved id today', () => {
    expect(sanitizeAgentName('System Directive')).toBe('systemdirective')
    expect(isReservedSenderId('systemdirective')).toBe(false)
  })

  it('does not swallow ordinary agent names', () => {
    for (const raw of ['Backend', 'Fron Ted', 'systematic', 'subsystem', 'system-directives']) {
      expect(isReservedSenderId(sanitizeAgentName(raw)), raw).toBe(false)
    }
  })
})

// Door 1. Source-level, matching agent-create-no-destructive-rollback.test.ts's stated reason: the
// handler awaits real Claude Code CLI calls and writes to the live agents directory, so a runtime
// harness would either mock the thing under test or touch the real fleet. What is asserted is the
// property that matters and the one a refactor could silently lose -- that the guard runs BEFORE
// anything is created, not merely that the call appears somewhere in the file.
describe('door 1: POST /api/agents', () => {
  const route = readFileSync(join(SRC, 'web', 'routes', 'agents.ts'), 'utf-8')

  it('rejects the reserved name with the shared predicate', () => {
    expect(route).toContain('isReservedSenderId(name)')
    expect(route).toContain("from '../system-directive-id.js'")
  })

  it('the guard runs BEFORE scaffoldAgentDir -- a 400 after creation is not a rejection', () => {
    const guard = route.indexOf('isReservedSenderId(name)')
    const scaffold = route.indexOf('scaffoldAgentDir(name)')
    expect(guard).toBeGreaterThan(-1)
    expect(scaffold).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(scaffold)
  })

  it('says what to do about it, not just that it failed (CLAUDE.md rule 12)', () => {
    expect(route).toContain('reserved for in-process system senders')
    expect(route).toContain('pick another name')
  })
})

// Doors 2 and 3. These run for real: a bundle is attacker-authored end to end, so the manifest
// name and the ?name= override are exactly as untrusted as a POST body.
describe('doors 2 and 3: the bundle importers', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'reserved-name-test-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  const stage = (agentName: string): string => {
    const stageRoot = join(tmp, 'stage', agentName)
    makeAgent(join(stageRoot, 'agent'), { 'agent-config.json': '{"model":"claude-sonnet-5"}' })
    return stageRoot
  }

  it('the single importer REFUSES a bundle whose manifest names the reserved id', () => {
    const bundle = packAgentBundle(stage(SYSTEM_DIRECTIVE_SENDER), SYSTEM_DIRECTIVE_SENDER)
    const dest = join(tmp, 'install')
    expect(() =>
      importAgentBundle(bundle, { resolveDest: (n) => join(dest, n) })
    ).toThrow(/reserved for in-process system senders/)
    expect(existsSync(join(dest, SYSTEM_DIRECTIVE_SENDER))).toBe(false)
  })

  it('the single importer refuses the ?name= OVERRIDE too, whatever the manifest said', () => {
    const bundle = packAgentBundle(stage('harmless'), 'harmless')
    const dest = join(tmp, 'install')
    expect(() =>
      importAgentBundle(bundle, { overrideName: 'System-Directive', resolveDest: (n) => join(dest, n) })
    ).toThrow(/reserved for in-process system senders/)
    expect(existsSync(join(dest, SYSTEM_DIRECTIVE_SENDER))).toBe(false)
  })

  it('the single importer still imports an ORDINARY name -- the guard did not close the door', () => {
    const bundle = packAgentBundle(stage('harmless'), 'harmless')
    const dest = join(tmp, 'install')
    const r = importAgentBundle(bundle, { resolveDest: (n) => join(dest, n) })
    expect(r.name).toBe('harmless')
    expect(existsSync(join(dest, 'harmless'))).toBe(true)
  })

  it('the fleet importer SKIPS the reserved name and still imports the rest', () => {
    // Skipping rather than throwing is the deliberate choice: one poisoned name in a fleet
    // bundle must not cost the operator every other agent in it.
    const agentsRoot = join(tmp, 'fleet', 'agents')
    for (const n of [SYSTEM_DIRECTIVE_SENDER, LEGACY_SYSTEM_SENDER, 'harmless']) {
      makeAgent(join(agentsRoot, n), { 'agent-config.json': '{"model":"claude-sonnet-5"}' })
    }
    const bundle = packFleetBundle(join(tmp, 'fleet'), [SYSTEM_DIRECTIVE_SENDER, LEGACY_SYSTEM_SENDER, 'harmless'])
    const dest = join(tmp, 'install')
    const r = importAllAgentsBundle(bundle, { resolveDest: (n) => join(dest, n) })

    expect(r.imported.map((a) => a.name)).toEqual(['harmless'])
    expect(r.skipped.map((s) => s.name).sort()).toEqual([LEGACY_SYSTEM_SENDER, SYSTEM_DIRECTIVE_SENDER].sort())
    for (const s of r.skipped) expect(s.reason).toBe('reserved name')
    expect(existsSync(join(dest, 'harmless'))).toBe(true)
    expect(existsSync(join(dest, SYSTEM_DIRECTIVE_SENDER))).toBe(false)
    expect(existsSync(join(dest, LEGACY_SYSTEM_SENDER))).toBe(false)
  })
})

// The reason the namespace matters at all, pinned so a future reader does not have to take the
// comment's word for it: these writers really do put an agent's own name in `from`.
describe('why minting the id matters: in-process writers use the agent NAME as `from`', () => {
  it.each(['context-guard-runner.ts', 'context-restart-gate-runner.ts'])(
    '%s writes createAgentMessage(name, ...)',
    (file) => {
      const src = readFileSync(join(SRC, 'web', file), 'utf-8')
      expect(src).toMatch(/createAgentMessage\(\s*name\s*,/)
    },
  )
})

// Door 5: the SHIPPED SEED FLEET (card 54fd9c02, Cybersec's finding attached to b46a4b7e's GO).
//
// The doors above all sit in the TypeScript layer. install-linux.sh:1534-1543 and the identical
// block in install-macos.sh:1055 do not go through any of them: they `cp -r` every
// seed-fleet-agents/*/ directory into agents/ with nothing but an already-exists skip. A commit
// that added a seed-fleet-agents/system-directive/ directory would create agents/system-directive
// on the next fresh install, past all four TS guards, and listAllAgentNames() hands that directory
// name back VERBATIM -- readdirSync with no sanitization -- which is precisely the value
// context-guard-runner.ts then passes as `from` to createAgentMessage. Minting, not claiming.
//
// The guard is therefore on the CORPUS, not on the shell. That is Cybersec's point and it is the
// stronger placement for two reasons: shell cannot call isReservedSenderId, and a corpus check
// covers both installers plus any third one that ever ships, without naming any of them. It also
// moves the check from install time (on a stranger's machine, unobserved) to commit time.
describe('door 5: the seed fleet shipped in the repo', () => {
  const SEED_FLEET = join(SRC, '..', 'seed-fleet-agents')

  function seedDirNames(): string[] {
    return readdirSync(SEED_FLEET).filter((f) => {
      try { return statSync(join(SEED_FLEET, f)).isDirectory() } catch { return false }
    })
  }

  // Both forms, and the RAW one is the load-bearing half -- measured, not assumed:
  // listAllAgentNames() in agent-config.ts returns readdirSync entries as they are, so the
  // directory name IS the agent name. isReservedSenderId lower-cases, so a `System-Directive`
  // directory is caught here without a sanitize step. The sanitized form is the cheap second
  // half: it costs one call and catches the spellings this file already documents as reaching
  // the reserved id only after normalization (`System--Directive`, `-system-directive-`),
  // should anything downstream ever start normalizing a directory name into an id.
  function reservedAmong(names: readonly string[]): string[] {
    return names.filter((n) => isReservedSenderId(n) || isReservedSenderId(sanitizeAgentName(n)))
  }

  it('the corpus is real -- an empty or moved directory must not read as "all clean"', () => {
    // Without this, deleting seed-fleet-agents/ or renaming it turns the guard below into a
    // permanent pass. That failure mode is invisible: zero offenders looks the same whether the
    // corpus is clean or absent.
    expect(existsSync(SEED_FLEET), `${SEED_FLEET} is missing -- the installers seed from it`).toBe(true)
    expect(seedDirNames().length).toBeGreaterThan(0)
  })

  it('CONTROL: the check fires on the case it exists for', () => {
    // The founding case, run against the check itself before trusting its silence.
    expect(reservedAmong(['backend', SYSTEM_DIRECTIVE_SENDER, 'qa'])).toEqual([SYSTEM_DIRECTIVE_SENDER])
    expect(reservedAmong([LEGACY_SYSTEM_SENDER])).toEqual([LEGACY_SYSTEM_SENDER])
    expect(reservedAmong(['System-Directive'])).toEqual(['System-Directive'])
    expect(reservedAmong(['System--Directive'])).toEqual(['System--Directive'])
    // ...and it does not flag the ordinary fleet, or the near-misses the predicate must let by.
    expect(reservedAmong(['backend2', 'fron-ted', 'systematic', 'subsystem', 'system-directives'])).toEqual([])
  })

  it('no shipped seed directory is a reserved sender id', () => {
    expect(
      reservedAmong(seedDirNames()),
      'These ship in seed-fleet-agents/ and the installers cp -r them into agents/ by name, with ' +
        'no validation -- creating an agent inside the in-process sender namespace on every fresh ' +
        'install. Rename the directory. Do NOT relax the reserved set to accommodate it.',
    ).toEqual([])
  })

  it('both installers still seed from THIS directory', () => {
    // The corpus check is only as good as the claim that it is the corpus the installers copy.
    // If an installer switches to another seed path, this guard would keep passing over a
    // directory nobody installs any more, which is the silent version of not existing.
    for (const script of ['install-linux.sh', 'install-macos.sh']) {
      const src = readFileSync(join(SRC, '..', script), 'utf-8')
      expect(src, script).toMatch(/SEED_FLEET_DIR=.*\/seed-fleet-agents/)
    }
  })
})
