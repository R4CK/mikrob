// Card d2d47a92: skill-map provisioner tests. Disposable fixture AGENT NAMES under the real
// agentDir() (same pattern agent-custom-provider-field.test.ts uses), but a fully fixture-based
// global-skills dir + map + manifest (env overrides, same convention as
// agent-skill-drift-sync.sh's env knobs) -- never reads/writes the live install's actual map,
// manifest or ~/.claude/skills catalog.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { agentDir } from '../web/agent-config.js'

const AGENT1 = 'skillmaptest-d2d47a92-1'
const AGENT2 = 'skillmaptest-d2d47a92-2'
const AGENT3 = 'skillmaptest-d2d47a92-3'
const AGENT4 = 'skillmaptest-d2d47a92-4'

let FIXTURE_ROOT: string
let GLOBAL_SKILLS: string
let MAP_PATH: string
let MANIFEST_PATH: string
let provisionFleetSkills: typeof import('../web/skill-map-provisioner.js')['provisionFleetSkills']

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
})

afterAll(() => {
  delete process.env.SKILL_MAP_PROVISIONER_MAP
  delete process.env.SKILL_MAP_PROVISIONER_MANIFEST
  delete process.env.SKILL_MAP_PROVISIONER_GLOBAL_SKILLS_DIR
  rmSync(FIXTURE_ROOT, { recursive: true, force: true })
})

afterEach(() => {
  for (const a of [AGENT1, AGENT2, AGENT3, AGENT4]) {
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
})
