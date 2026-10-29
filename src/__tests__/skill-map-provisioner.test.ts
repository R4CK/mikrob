// Card d2d47a92: skill-map provisioner tests. Disposable fixture AGENT NAMES under the real
// agentDir() (same pattern agent-custom-provider-field.test.ts uses), but a fully fixture-based
// global-skills dir + map + manifest (env overrides, same convention as
// agent-skill-drift-sync.sh's env knobs) -- never reads/writes the live install's actual map,
// manifest or ~/.claude/skills catalog.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { agentDir } from '../web/agent-config.js'

const AGENT1 = 'skillmaptest-d2d47a92-1'
const AGENT2 = 'skillmaptest-d2d47a92-2'
const AGENT3 = 'skillmaptest-d2d47a92-3'
const AGENT4 = 'skillmaptest-d2d47a92-4'
const AGENT5 = 'skillmaptest-d2d47a92-5'
const AGENT6 = 'skillmaptest-d2d47a92-6'
const AGENT7 = 'skillmaptest-d2d47a92-7'

let FIXTURE_ROOT: string
let GLOBAL_SKILLS: string
let MAP_PATH: string
let MANIFEST_PATH: string
let provisionFleetSkills: typeof import('../web/skill-map-provisioner.js')['provisionFleetSkills']
let detachSkillSymlinkIfAny: typeof import('../web/skill-map-provisioner.js')['detachSkillSymlinkIfAny']

function baseMap(): Record<string, unknown> {
  return {
    'fleet-core': ['core-a', 'core-b'],
    roles: { [AGENT1]: ['role-x', 'removed-later'], [AGENT3]: ['role-x', 'removed-later'] },
  }
}

function writeMap(map: Record<string, unknown>): void {
  writeFileSync(MAP_PATH, JSON.stringify(map))
}

beforeAll(async () => {
  FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'skill-map-provisioner-test-'))
  GLOBAL_SKILLS = join(FIXTURE_ROOT, 'global-skills')
  MAP_PATH = join(FIXTURE_ROOT, 'skill-role-map.json')
  MANIFEST_PATH = join(FIXTURE_ROOT, 'manifest.json')

  for (const skill of ['core-a', 'core-b', 'role-x', 'removed-later']) {
    mkdirSync(join(GLOBAL_SKILLS, skill), { recursive: true })
    writeFileSync(join(GLOBAL_SKILLS, skill, 'SKILL.md'), `# ${skill}\n`)
  }
  writeMap(baseMap())

  process.env.SKILL_MAP_PROVISIONER_MAP = MAP_PATH
  process.env.SKILL_MAP_PROVISIONER_MANIFEST = MANIFEST_PATH
  process.env.SKILL_MAP_PROVISIONER_GLOBAL_SKILLS_DIR = GLOBAL_SKILLS

  const mod = await import('../web/skill-map-provisioner.js')
  provisionFleetSkills = mod.provisionFleetSkills
  detachSkillSymlinkIfAny = mod.detachSkillSymlinkIfAny
})

afterAll(() => {
  delete process.env.SKILL_MAP_PROVISIONER_MAP
  delete process.env.SKILL_MAP_PROVISIONER_MANIFEST
  delete process.env.SKILL_MAP_PROVISIONER_GLOBAL_SKILLS_DIR
  rmSync(FIXTURE_ROOT, { recursive: true, force: true })
})

afterEach(() => {
  for (const a of [AGENT1, AGENT2, AGENT3, AGENT4, AGENT5, AGENT6, AGENT7]) {
    rmSync(agentDir(a), { recursive: true, force: true })
  }
  writeMap(baseMap())
})

describe('provisionFleetSkills (card d2d47a92)', () => {
  it('1: every map entry resolves to a real global skill with SKILL.md (fixture precondition)', () => {
    const map = JSON.parse(readFileSync(MAP_PATH, 'utf-8'))
    for (const s of [...(map['fleet-core'] as string[]), ...(map.roles[AGENT1] as string[])]) {
      expect(existsSync(join(GLOBAL_SKILLS, s, 'SKILL.md'))).toBe(true)
    }
  })

  it('2: after provisioning, a symlink exists for every fleet-core + role skill', () => {
    mkdirSync(agentDir(AGENT1), { recursive: true })
    const result = provisionFleetSkills(AGENT1)
    const skillsDir = join(agentDir(AGENT1), '.claude', 'skills')
    for (const s of ['core-a', 'core-b', 'role-x', 'removed-later']) {
      expect(lstatSync(join(skillsDir, s)).isSymbolicLink()).toBe(true)
    }
    expect(result.created.sort()).toEqual(['core-a', 'core-b', 'removed-later', 'role-x'])
  })

  it('3: a pre-existing REAL (non-symlink) directory with the same name is left untouched', () => {
    mkdirSync(agentDir(AGENT2), { recursive: true })
    const skillsDir = join(agentDir(AGENT2), '.claude', 'skills')
    mkdirSync(join(skillsDir, 'core-a'), { recursive: true })
    writeFileSync(join(skillsDir, 'core-a', 'SKILL.md'), 'HAND-PATCHED, DO NOT TOUCH\n')

    const result = provisionFleetSkills(AGENT2)

    expect(lstatSync(join(skillsDir, 'core-a')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(skillsDir, 'core-a', 'SKILL.md'), 'utf-8')).toBe('HAND-PATCHED, DO NOT TOUCH\n')
    expect(result.skippedRealDir).toContain('core-a')
  })

  it('4: removing a skill from the map removes ONLY its provisioner-created link on the next run', () => {
    mkdirSync(agentDir(AGENT3), { recursive: true })
    const skillsDir = join(agentDir(AGENT3), '.claude', 'skills')

    provisionFleetSkills(AGENT3)
    expect(lstatSync(join(skillsDir, 'removed-later')).isSymbolicLink()).toBe(true)

    writeMap({ 'fleet-core': ['core-a', 'core-b'], roles: { [AGENT3]: ['role-x'] } })

    const result = provisionFleetSkills(AGENT3)
    expect(existsSync(join(skillsDir, 'removed-later'))).toBe(false)
    expect(lstatSync(join(skillsDir, 'role-x')).isSymbolicLink()).toBe(true)
    expect(result.removed).toEqual(['removed-later'])
  })

  it('a skill named in the map with no matching global SKILL.md is reported, not crashed on', () => {
    mkdirSync(agentDir(AGENT4), { recursive: true })
    writeMap({ 'fleet-core': ['core-a', 'does-not-exist'], roles: {} })
    const result = provisionFleetSkills(AGENT4)
    expect(result.skippedMissingSource).toContain('does-not-exist')
  })

  // Card d2d47a92 WhiteHat F2 (comment 24868): a malformed map entry used to throw out of
  // provisionFleetSkills (TypeError / "not iterable"), and the caller (startAgentProcessUnlocked)
  // has no try/catch around it -- one bad line blocked every agent's start, not just this one's.
  describe('F2: malformed map entries never throw', () => {
    it('a non-string in fleet-core is skipped, not thrown on', () => {
      mkdirSync(agentDir(AGENT5), { recursive: true })
      writeMap({ 'fleet-core': ['core-a', null, 123, {}], roles: {} })
      let result: ReturnType<typeof provisionFleetSkills> | undefined
      expect(() => { result = provisionFleetSkills(AGENT5) }).not.toThrow()
      expect(result!.created).toEqual(['core-a'])
    })

    it('roles[agent] not being an array is skipped, not thrown on', () => {
      mkdirSync(agentDir(AGENT5), { recursive: true })
      writeMap({ 'fleet-core': ['core-a'], roles: { [AGENT5]: 5 } })
      let result: ReturnType<typeof provisionFleetSkills> | undefined
      expect(() => { result = provisionFleetSkills(AGENT5) }).not.toThrow()
      expect(result!.created).toEqual(['core-a'])
    })
  })

  // Card d2d47a92 WhiteHat F3 (comment 24868), matching WhiteHat's own P4 probe: a map entry like
  // "../escape-skill" joined straight into the skills dir creates a directory OUTSIDE it
  // (agents/<name>/.claude/escape-skill), reading from a matching "../escape-skill" source outside
  // the global catalog too -- both sides of join() escape. A global/outside skill named
  // escape-skill must actually exist for this to be non-vacuous (without one, the old code also
  // "passes" only because the source lookup fails first, not because traversal is blocked).
  it('F3: a path-traversal skill name in the map is rejected, never reaches the filesystem', () => {
    const outsideGlobalSkills = join(FIXTURE_ROOT, 'escape-skill')
    mkdirSync(outsideGlobalSkills, { recursive: true })
    writeFileSync(join(outsideGlobalSkills, 'SKILL.md'), '# escape\n')
    try {
      mkdirSync(agentDir(AGENT5), { recursive: true })
      writeMap({ 'fleet-core': ['core-a', '../escape-skill'], roles: {} })
      const result = provisionFleetSkills(AGENT5)
      expect(result.created).toEqual(['core-a'])
      expect(existsSync(join(agentDir(AGENT5), '.claude', 'escape-skill'))).toBe(false)
    } finally {
      rmSync(outsideGlobalSkills, { recursive: true, force: true })
    }
  })

  // Card d2d47a92 WhiteHat F4 (comment 24868): a pre-existing symlink used to be adopted into the
  // manifest unconditionally, even one pointing outside the global catalog (planted by something
  // else) or dangling -- this provisioner would then "manage" and later delete a link it never
  // created.
  describe('F4: foreign/dangling symlinks are never adopted or removed', () => {
    it('a symlink pointing OUTSIDE the global skills dir is left alone, not adopted', () => {
      mkdirSync(agentDir(AGENT6), { recursive: true })
      const skillsDir = join(agentDir(AGENT6), '.claude', 'skills')
      mkdirSync(skillsDir, { recursive: true })
      const outsideTarget = mkdtempSync(join(tmpdir(), 'foreign-skill-'))
      writeFileSync(join(outsideTarget, 'SKILL.md'), '# foreign\n')
      symlinkSync(outsideTarget, join(skillsDir, 'core-a'))

      const result = provisionFleetSkills(AGENT6)

      expect(lstatSync(join(skillsDir, 'core-a')).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(skillsDir, 'core-a', 'SKILL.md'), 'utf-8')).toBe('# foreign\n')
      expect(result.created).not.toContain('core-a')

      // Run again with core-a removed from the map: since it was never adopted, it must survive.
      writeMap({ 'fleet-core': ['core-b'], roles: {} })
      provisionFleetSkills(AGENT6)
      expect(existsSync(join(skillsDir, 'core-a'))).toBe(true)
      rmSync(outsideTarget, { recursive: true, force: true })
    })
  })

  // Card d2d47a92 WhiteHat F1 HIGH (comment 24868): a provisioned agent skill is a symlink into
  // the shared global catalog -- any write THROUGH it (fleet import, zip-skill import) silently
  // poisons every agent sharing that global skill. detachSkillSymlinkIfAny must convert it to a
  // real, agent-local copy before the caller writes.
  describe('F1: detachSkillSymlinkIfAny converts a provisioned symlink before write', () => {
    it('a symlinked skill dir becomes a real dir with the global content copied in, global untouched', () => {
      mkdirSync(agentDir(AGENT7), { recursive: true })
      provisionFleetSkills(AGENT7)
      const skillsDir = join(agentDir(AGENT7), '.claude', 'skills')
      const target = join(skillsDir, 'core-a')
      expect(lstatSync(target).isSymbolicLink()).toBe(true)

      detachSkillSymlinkIfAny(target)

      expect(lstatSync(target).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(target, 'SKILL.md'), 'utf-8')).toBe('# core-a\n')
      // Simulate the caller's write that follows detach: must land only in the agent-local copy.
      writeFileSync(join(target, 'SKILL.md'), 'AGENT-LOCAL OVERWRITE\n')
      expect(readFileSync(join(GLOBAL_SKILLS, 'core-a', 'SKILL.md'), 'utf-8')).toBe('# core-a\n')
    })

    it('a real (non-symlink) dir is left untouched', () => {
      mkdirSync(agentDir(AGENT7), { recursive: true })
      const skillsDir = join(agentDir(AGENT7), '.claude', 'skills')
      mkdirSync(join(skillsDir, 'already-real'), { recursive: true })
      writeFileSync(join(skillsDir, 'already-real', 'SKILL.md'), 'REAL\n')
      detachSkillSymlinkIfAny(join(skillsDir, 'already-real'))
      expect(readFileSync(join(skillsDir, 'already-real', 'SKILL.md'), 'utf-8')).toBe('REAL\n')
    })

    it('a path that does not exist yet is a no-op', () => {
      mkdirSync(agentDir(AGENT7), { recursive: true })
      const target = join(agentDir(AGENT7), '.claude', 'skills', 'not-there-yet')
      expect(() => detachSkillSymlinkIfAny(target)).not.toThrow()
      expect(existsSync(target)).toBe(false)
    })
  })
})
