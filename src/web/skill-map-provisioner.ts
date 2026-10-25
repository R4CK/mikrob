// Card d2d47a92: assemble each agent's .claude/skills/ set at start from ONE machine-readable map
// (store/skill-role-map.json), instead of hand-copied seed-fleet-agents folders that drift --
// fleet-wide skills (caveman, unlazy, sp-using-superpowers) measured (e060a794 E3/E4) to never
// reach any agent because nobody added them to any agent's seed source.
//
// This is a DIFFERENT gap than store/agent-skill-drift-sync.sh closes: drift-sync keeps an
// ALREADY-ASSIGNED skill's live copy in sync with its canonical content (stale/diverged) and fills
// a clone-family's missing-but-assigned-to-a-sibling skill. It says nothing about a skill that was
// never assigned to any family member in the first place -- that assignment is this module's job.
//
// Mechanism: symlink, not copy, so a fixed global skill (~/.claude/skills/<name>) reaches every
// agent immediately, matching the pattern already used for the isolated Claude config dir
// (provisionIsolatedConfigDir in agent-process.ts). NEVER touch a pre-existing REAL directory under
// agents/<name>/.claude/skills/<skill> -- that is either the one-time seed-fleet-agents copy or a
// hand-patched live skill (CLAUDE.md "Skill patch (runtime javitas)" convention), and this
// provisioner must never clobber either. Only a symlink this module itself created may be removed,
// tracked in a manifest, so that removing a name from the map actually removes the link next start
// instead of leaving an orphan.
import { existsSync, readFileSync, mkdirSync, lstatSync, symlinkSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import { agentDir } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'

// Overridable the same way agent-skill-drift-sync.sh's env knobs are, so a test never touches the
// live install's map/manifest/global skills catalog.
const SKILL_ROLE_MAP_PATH = process.env.SKILL_MAP_PROVISIONER_MAP ?? join(PROJECT_ROOT, 'store', 'skill-role-map.json')
const MANIFEST_PATH = process.env.SKILL_MAP_PROVISIONER_MANIFEST ?? join(PROJECT_ROOT, 'store', 'skill-map-provisioner-manifest.json')
const GLOBAL_SKILLS_DIR = process.env.SKILL_MAP_PROVISIONER_GLOBAL_SKILLS_DIR ?? join(homedir(), '.claude', 'skills')

interface SkillRoleMap {
  'fleet-core': string[]
  roles: Record<string, string[]>
}

interface Manifest {
  // agent name -> skill names whose symlink THIS provisioner created (not pre-existing real dirs)
  [agent: string]: string[]
}

function readSkillRoleMap(): SkillRoleMap | null {
  try {
    const raw = JSON.parse(readFileSync(SKILL_ROLE_MAP_PATH, 'utf-8')) as Record<string, unknown>
    const fleetCore = Array.isArray(raw['fleet-core']) ? (raw['fleet-core'] as string[]) : []
    const roles = (raw.roles && typeof raw.roles === 'object' ? raw.roles : {}) as Record<string, string[]>
    return { 'fleet-core': fleetCore, roles }
  } catch (err) {
    logger.warn({ err }, 'skill-map-provisioner: could not read/parse skill-role-map.json, skipping')
    return null
  }
}

function readManifest(): Manifest {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest
  } catch {
    return {}
  }
}

function writeManifest(m: Manifest): void {
  try { atomicWriteFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\n') }
  catch (err) { logger.warn({ err }, 'skill-map-provisioner: could not write manifest') }
}

export interface ProvisionResult {
  created: string[]
  removed: string[]
  skippedRealDir: string[]
  skippedMissingSource: string[]
}

// Idempotent, best-effort, never throws -- a map/manifest problem degrades to "nothing changes
// this run" (same fail-open posture as provisionIsolatedConfigDir), never a launch failure.
export function provisionFleetSkills(name: string): ProvisionResult {
  const result: ProvisionResult = { created: [], removed: [], skippedRealDir: [], skippedMissingSource: [] }
  const map = readSkillRoleMap()
  if (!map) return result

  const dir = agentDir(name)
  if (!existsSync(dir)) return result
  const skillsDir = join(dir, '.claude', 'skills')
  try { mkdirSync(skillsDir, { recursive: true }) } catch { return result }

  const wanted = Array.from(new Set([...map['fleet-core'], ...(map.roles[name] ?? [])]))

  const manifest = readManifest()
  const previouslyCreated = new Set(manifest[name] ?? [])
  const nowCreated: string[] = []

  for (const skill of wanted) {
    const target = join(skillsDir, skill)
    let st: ReturnType<typeof lstatSync> | null = null
    try { st = lstatSync(target) } catch { st = null }

    if (st) {
      if (st.isSymbolicLink()) { nowCreated.push(skill); continue } // already provisioned, idempotent
      result.skippedRealDir.push(skill) // pre-existing real dir (seed or hand-patched) -- never touch
      continue
    }

    const source = join(GLOBAL_SKILLS_DIR, skill)
    if (!existsSync(join(source, 'SKILL.md'))) {
      result.skippedMissingSource.push(skill)
      continue
    }
    try {
      symlinkSync(source, target)
      nowCreated.push(skill)
      result.created.push(skill)
    } catch (err) {
      logger.warn({ err, name, skill }, 'skill-map-provisioner: symlink failed')
    }
  }

  // Remove links THIS provisioner made for a skill no longer in the map, but only if the target is
  // still a symlink (defense in depth: if something replaced it with a real dir since, leave it).
  const nowCreatedSet = new Set(nowCreated)
  for (const skill of previouslyCreated) {
    if (nowCreatedSet.has(skill)) continue
    const target = join(skillsDir, skill)
    try {
      if (lstatSync(target).isSymbolicLink()) {
        unlinkSync(target)
        result.removed.push(skill)
      }
    } catch { /* already gone */ }
  }

  manifest[name] = nowCreated
  writeManifest(manifest)
  return result
}

// Used by store/agent-skill-drift-sync.sh's consistency with this provisioner: true if the given
// agent+skill path is a symlink this provisioner (or an equivalent manual setup) created, so a
// caller elsewhere can skip it rather than risk writing through the link into the shared global
// skill. Exported for the TS test suite; the shell tool re-derives the same check with `test -L`.
export function isProvisionerManagedSkillLink(name: string, skill: string): boolean {
  try { return lstatSync(join(agentDir(name), '.claude', 'skills', skill)).isSymbolicLink() }
  catch { return false }
}

// For the consistency-check script (design item 4): list every skill name across ALL agent
// directories whose CLAUDE.md is expected to reference it, so an external script can diff against
// the map without re-implementing the fs walk here. Exported for testability.
export function listGlobalSkillNames(): string[] {
  try { return readdirSync(GLOBAL_SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) }
  catch { return [] }
}
