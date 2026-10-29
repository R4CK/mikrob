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
import { existsSync, readFileSync, mkdirSync, lstatSync, symlinkSync, unlinkSync, readdirSync, realpathSync, cpSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
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

// Card d2d47a92 WhiteHat F3 (comment 24868): a bare skill name is used to join() a filesystem
// path, so a map entry like "../escape-skill" creates agents/<name>/.claude/escape-skill outside
// the skills dir entirely (P4). The map is a merged-by-card tracked file, not an attacker-reachable
// input, but it is still text anyone can merge wrong -- reject anything that is not a plain,
// single-component, lowercase skill-folder name at the point the map is read, so a bad entry never
// reaches join()/symlinkSync() at all.
const SKILL_NAME_RX = /^[a-z0-9][a-z0-9._-]*$/

function isUnderGlobalSkillsDir(resolvedPath: string): boolean {
  const base = resolve(GLOBAL_SKILLS_DIR)
  return resolvedPath === base || resolvedPath.startsWith(base + sep)
}

// Card d2d47a92 WhiteHat F2 (comment 24868): provisionFleetSkills is documented never-throws but
// is called from startAgentProcessUnlocked with no try/catch -- a single malformed line in the
// tracked skill-role-map.json (a non-string in "fleet-core", or roles[agent] not an array) threw
// (TypeError / "not iterable") and blocked the start of EVERY agent, not just the mis-mapped one.
// Filtering invalid entries here, with a warn instead of a throw, is what makes "never throws" true.
function sanitizedSkillNames(raw: unknown, context: string): string[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) logger.warn({ context }, 'skill-map-provisioner: expected an array in skill-role-map.json, skipping entry')
    return []
  }
  const out: string[] = []
  for (const v of raw) {
    if (typeof v === 'string' && SKILL_NAME_RX.test(v)) { out.push(v); continue }
    logger.warn({ context, value: v }, 'skill-map-provisioner: invalid skill name in skill-role-map.json, skipping')
  }
  return out
}

function readSkillRoleMap(): SkillRoleMap | null {
  try {
    const raw = JSON.parse(readFileSync(SKILL_ROLE_MAP_PATH, 'utf-8')) as Record<string, unknown>
    const fleetCore = sanitizedSkillNames(raw['fleet-core'], 'fleet-core')
    const rolesRaw = (raw.roles && typeof raw.roles === 'object' ? raw.roles as Record<string, unknown> : {})
    const roles: Record<string, string[]> = {}
    for (const [role, list] of Object.entries(rolesRaw)) {
      roles[role] = sanitizedSkillNames(list, `roles.${role}`)
    }
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
      if (st.isSymbolicLink()) {
        // Card d2d47a92 WhiteHat F4 (comment 24868): any pre-existing symlink used to be adopted
        // into the manifest unconditionally (nowCreated.push), even one planted by something else
        // and pointing outside GLOBAL_SKILLS_DIR, or a dangling one -- this provisioner would then
        // "manage" (and later unlink) a link it never created and does not own. Only treat it as
        // already-provisioned if it actually resolves under our own global catalog.
        let real: string | null = null
        try { real = realpathSync(target) } catch { real = null }
        if (real && isUnderGlobalSkillsDir(real)) {
          nowCreated.push(skill) // already provisioned, idempotent
        } else {
          logger.warn({ name, skill, target, real }, 'skill-map-provisioner: existing symlink is not provisioner-managed, leaving untouched')
          result.skippedRealDir.push(skill)
        }
        continue
      }
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
    if (!SKILL_NAME_RX.test(skill)) {
      logger.warn({ name, skill }, 'skill-map-provisioner: invalid skill name in manifest, skipping removal')
      continue
    }
    const target = join(skillsDir, skill)
    try {
      if (!lstatSync(target).isSymbolicLink()) continue
      // F4, same rule as adoption above: only remove it if it still resolves under our own
      // global catalog -- never blindly unlink a link that was swapped for something else since.
      const real = realpathSync(target)
      if (!isUnderGlobalSkillsDir(real)) continue
      unlinkSync(target)
      result.removed.push(skill)
    } catch { /* already gone, or a dangling link -- not ours to clean up blindly */ }
  }

  manifest[name] = nowCreated
  writeManifest(manifest)
  return result
}

// Card d2d47a92 WhiteHat F1 HIGH (comment 24868): a provisioned agent skill is a symlink into the
// shared global catalog, so a PRE-EXISTING write path that targets
// agents/<name>/.claude/skills/<skill>/... (fleet-transfer.ts's agent-skills import,
// routes/agents-skills.ts's zip-skill import) would write THROUGH the link into
// ~/.claude/skills/<skill>, silently poisoning every agent (and MikroB) that shares it -- proven
// live with both an atomicWriteFileSync and an `unzip -o` onto a provisioned name. Every such
// writer must call this FIRST: if the target is currently a symlink, detach it into a real,
// agent-local copy so the write that follows lands only in that agent's own copy. A real
// directory, or a path that does not exist yet, is left for the caller's own mkdir to handle.
export function detachSkillSymlinkIfAny(skillDir: string): void {
  let st: ReturnType<typeof lstatSync> | null = null
  try { st = lstatSync(skillDir) } catch { return }
  if (!st.isSymbolicLink()) return
  let real: string | null = null
  try { real = realpathSync(skillDir) } catch { real = null } // dangling link
  unlinkSync(skillDir)
  mkdirSync(skillDir, { recursive: true })
  // N2: only copy the symlink target when it resolves into the global skills catalog.
  // A foreign symlink (pointing outside the catalog) gets an empty dir instead -- copying an
  // arbitrary tree would silently duplicate potentially sensitive content into the agent dir.
  if (real && isUnderGlobalSkillsDir(real)) {
    try { cpSync(real, skillDir, { recursive: true }) } catch (err) { logger.warn({ err, skillDir, real }, 'skill-map-provisioner: could not copy symlink target before detach') }
    logger.warn({ skillDir, real }, 'skill-map-provisioner: detached a symlink before write, converted to a real agent-local copy so the write cannot land outside the agent directory')
  } else {
    logger.warn({ skillDir, real }, 'skill-map-provisioner: detached a FOREIGN symlink (target outside global catalog) -- empty dir created, target not copied')
  }
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
