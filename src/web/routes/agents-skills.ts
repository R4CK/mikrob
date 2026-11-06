import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, rmSync, statSync, mkdtempSync, cpSync } from 'node:fs'
import { join, posix } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execShellAsync } from '../exec-async.js'
import { logger } from '../../logger.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { agentDir } from '../agent-config.js'
import { generateSkillMd } from '../agent-scaffold.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json } from '../http-helpers.js'
import { sanitizeAgentName, sanitizeSkillName, safeJoin, findSymlinkTaintedEntries, shellEscape } from '../sanitize.js'
import { detachSkillSymlinkIfAny } from '../skill-map-provisioner.js'
import type { RouteContext } from './types.js'

// Marveen's skills live at the global ~/.claude/skills/ path (shared with
// the operator's Claude Code install); sub-agents under their own
// agents/<name>/.claude/skills/. agentDir(MAIN_AGENT_ID) points at the
// non-existent agents/marveen/ folder so we must branch here.
function skillsRootFor(name: string): string {
  return name === MAIN_AGENT_ID
    ? join(homedir(), '.claude', 'skills')
    : join(agentDir(name), '.claude', 'skills')
}
function agentExistsFor(name: string): boolean {
  return name === MAIN_AGENT_ID || existsSync(agentDir(name))
}

// Pull the `description:` field out of a skill's SKILL.md YAML frontmatter so
// the dashboard can show what each skill does. Best-effort: single-line value,
// quotes trimmed, capped so a malformed file can't bloat the response.
function readSkillDescription(skillDir: string): string {
  try {
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
    const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const block = fm ? fm[1] : md.slice(0, 600)
    const m = block.match(/^description:\s*(.+)$/m)
    if (!m) return ''
    return m[1].trim().replace(/^["']|["']$/g, '').slice(0, 300)
  } catch {
    return ''
  }
}

type AgentSkill = {
  name: string
  hasSkillMd: boolean
  description: string
  source: 'agent' | 'global'
  deletable: boolean
}

// List the skill directories under `dir`, tagging each with where it came from
// and whether it can be deleted from this agent's view.
function scanSkillDir(dir: string, source: 'agent' | 'global', deletable: boolean): AgentSkill[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => { try { return statSync(join(dir, f)).isDirectory() } catch { return false } })
    .map((f) => ({
      name: f,
      hasSkillMd: existsSync(join(dir, f, 'SKILL.md')),
      description: readSkillDescription(join(dir, f)),
      source,
      deletable,
    }))
}

// Card 45a45700 (WhiteHat2 msg 15251, d2d47a92 follow-up) L1: the traversal check used
// entry.includes('..') as a SUBSTRING match, so a legitimate filename like "SKILL..md" was
// rejected (400) even though it has no '..' PATH SEGMENT. Reject only when a '/'-split segment
// is exactly '..', matching what unzip itself treats as a parent-directory reference.
function hasTraversalSegment(entry: string): boolean {
  return entry.split('/').some((seg) => seg === '..')
}

// Card 45a45700 L2 (WhiteHat NO-GO 25187's sturdier fix): the old guard trusted that `unzip -Z1`'s
// listing (what we validated) and what `unzip -o` actually writes to disk always agree. Instead of
// extracting straight into the live skillsDir -- which can hold a provisioner-managed symlink
// (skill-map-provisioner.ts) -- extract into a FRESH, disposable staging dir first. Because the
// staging dir never pre-existed and holds nothing of ours, the write-through-symlink class of bug
// cannot happen during extraction itself, regardless of whether the listing and the physical
// write agree. Only a staging tree that re-validates clean (every top-level name was one the
// listing actually promised, nothing inside it is a symlink) is moved into skillsDir afterward.
export function validateStagingTree(
  stagingDir: string,
  expectedTopLevel: Set<string>,
): { ok: true } | { ok: false; reason: string } {
  let actualTopLevel: string[]
  try { actualTopLevel = readdirSync(stagingDir) } catch { return { ok: false, reason: 'staging dir unreadable' } }
  for (const name of actualTopLevel) {
    if (!expectedTopLevel.has(name)) return { ok: false, reason: `extraction produced an entry the checked listing never promised: ${name}` }
  }
  const tainted = findSymlinkTaintedEntries(stagingDir, actualTopLevel)
  if (tainted.length > 0) return { ok: false, reason: `symlink entries: ${tainted.join(', ')}` }
  return { ok: true }
}

// Moves every validated top-level entry out of the staging dir and into skillsDir, one name at a
// time. detachSkillSymlinkIfAny runs first so a provisioner-managed (or foreign) symlink at the
// destination is converted to a real, agent-local directory before anything is written into it --
// the merge that follows can then only ever land inside that real directory, never through a link.
export function moveStagingIntoSkillsDir(stagingDir: string, skillsDir: string): string[] {
  const moved: string[] = []
  for (const name of readdirSync(stagingDir)) {
    const target = join(skillsDir, name)
    detachSkillSymlinkIfAny(target)
    mkdirSync(target, { recursive: true })
    cpSync(join(stagingDir, name), target, { recursive: true, force: true })
    moved.push(name)
  }
  return moved
}

export async function tryHandleAgentsSkills(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  const skillImportMatch = path.match(/^\/api\/agents\/([^/]+)\/skills\/import$/)
  if (skillImportMatch && method === 'POST') {
    const name = sanitizeAgentName(decodeURIComponent(skillImportMatch[1]))
    if (!name) { json(res, { error: 'Invalid agent name' }, 400); return true }
    if (!agentExistsFor(name)) { json(res, { error: 'Agent not found' }, 404); return true }

    const body = await readBody(req)
    const contentType = req.headers['content-type'] || ''
    const { file } = parseMultipart(body, contentType)
    if (!file) { json(res, { error: 'No file uploaded' }, 400); return true }

    const skillsDir = skillsRootFor(name)
    mkdirSync(skillsDir, { recursive: true })

    const tmpPath = join(skillsDir, `_import_${randomUUID()}.zip`)
    const before = new Set(readdirSync(skillsDir))
    let stagingDir: string | null = null
    try {
      writeFileSync(tmpPath, file.data)
      const listOutput = await execShellAsync(`unzip -Z1 ${shellEscape(tmpPath)} 2>&1`, { timeoutMs: 5000 })
      // Card d2d47a92 / WhiteHat NO-GO 25187: the check and the extraction must judge the SAME
      // string. Reject on the raw (slash-normalised only, NOT path-normalised) string first, so
      // any '..' PATH SEGMENT the archive actually carries is caught before extraction ever runs.
      const rawEntries = listOutput.split('\n').map((l) => l.trim()).filter(Boolean)
        .map((e) => e.replace(/\\/g, '/'))
      for (const entry of rawEntries) {
        // Card 45a45700 L1: exact-segment check (hasTraversalSegment), not entry.includes('..')
        // -- a legitimate filename like "SKILL..md" contains the substring '..' but carries no
        // '..' path segment, and must be accepted.
        if (entry === '.' || hasTraversalSegment(entry) || entry.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(entry)) {
          unlinkSync(tmpPath)
          json(res, { error: 'Invalid skill file: path traversal detected' }, 400)
          return true
        }
      }
      // Only AFTER the traversal check passes do we normalise (strips leading ./, resolves
      // a/./b) to compute the expected top-level directory names -- normalising here is safe
      // because every entry already proved '..'-free above.
      const entries = rawEntries.map((e) => posix.normalize(e))
      const expectedTopLevel = new Set(entries.map((e) => e.split('/')[0]).filter(Boolean))

      // Card 45a45700 L2: extract into a fresh staging dir, not the live skillsDir, so the
      // write-through-symlink class of bug cannot happen during extraction itself.
      stagingDir = mkdtempSync(join(tmpdir(), 'skill-import-staging-'))
      await execShellAsync(`unzip -o ${shellEscape(tmpPath)} -d ${shellEscape(stagingDir)}`, { timeoutMs: 10000 })
      unlinkSync(tmpPath)

      const validation = validateStagingTree(stagingDir, expectedTopLevel)
      if (!validation.ok) {
        rmSync(stagingDir, { recursive: true, force: true })
        logger.warn({ name, reason: validation.reason }, 'skill-map-provisioner: staging validation rejected the extracted archive')
        json(res, { error: 'Invalid skill file: extraction did not match the checked listing' }, 400)
        return true
      }

      // Only a validated staging tree is moved into skillsDir, one top-level name at a time,
      // detaching any symlink at the destination first (handles both the pre-existing-symlink
      // and foreign-symlink cases the same way the old direct-extract flow did).
      const moved = moveStagingIntoSkillsDir(stagingDir, skillsDir)
      rmSync(stagingDir, { recursive: true, force: true })
      stagingDir = null

      const newlyCreated = moved.filter((f) => !before.has(f))
      const extracted = moved.filter(f => {
        const p = join(skillsDir, f)
        try { return statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md')) } catch { return false }
      })
      if (extracted.length === 0) {
        for (const f of newlyCreated) {
          try { rmSync(join(skillsDir, f), { recursive: true, force: true }) } catch { /* best effort */ }
        }
        json(res, { error: 'No valid skill (SKILL.md) found in archive' }, 400)
        return true
      }

      logger.info({ name, skills: extracted }, 'Skill(s) imported')
      json(res, { ok: true, imported: extracted })
      return true
    } catch (err) {
      try { unlinkSync(tmpPath) } catch { /* ignored */ }
      if (stagingDir) { try { rmSync(stagingDir, { recursive: true, force: true }) } catch { /* ignored */ } }
      try {
        const leftover = readdirSync(skillsDir).filter(f => !before.has(f))
        for (const f of leftover) {
          try { rmSync(join(skillsDir, f), { recursive: true, force: true }) } catch { /* best effort */ }
        }
      } catch { /* dir gone or unreadable; nothing to do */ }
      logger.error({ err }, 'Failed to import skill')
      json(res, { error: 'Failed to extract .skill file' }, 500)
      return true
    }
  }

  const skillActionMatch = path.match(/^\/api\/agents\/([^/]+)\/skills\/([^/]+)$/)
  if (skillActionMatch && method === 'DELETE') {
    const name = sanitizeAgentName(decodeURIComponent(skillActionMatch[1]))
    const skillName = sanitizeSkillName(decodeURIComponent(skillActionMatch[2]))
    if (!name || !skillName) { json(res, { error: 'Invalid agent or skill name' }, 400); return true }
    if (!agentExistsFor(name)) { json(res, { error: 'Agent not found' }, 404); return true }
    let skillDir: string
    try {
      skillDir = safeJoin(skillsRootFor(name), skillName)
    } catch {
      json(res, { error: 'Invalid skill path' }, 400)
      return true
    }
    if (!existsSync(skillDir)) { json(res, { error: 'Skill not found' }, 404); return true }
    rmSync(skillDir, { recursive: true, force: true })
    json(res, { ok: true })
    return true
  }

  const skillsMatch = path.match(/^\/api\/agents\/([^/]+)\/skills$/)
  if (skillsMatch && method === 'GET') {
    const name = decodeURIComponent(skillsMatch[1])
    if (!agentExistsFor(name)) { json(res, { error: 'Agent not found' }, 404); return true }
    const globalRoot = join(homedir(), '.claude', 'skills')
    let skills: AgentSkill[]
    if (name === MAIN_AGENT_ID) {
      // The main agent's skill root IS the global ~/.claude/skills dir; these
      // skills physically live there and are deletable from this view.
      skills = scanSkillDir(skillsRootFor(name), 'global', true)
    } else {
      // Sub-agents own a small agents/<name>/.claude/skills set (deletable) but
      // at runtime ALSO inherit every global ~/.claude/skills entry. The old
      // endpoint only scanned the agent-local dir, so the tab looked empty even
      // though the agent had ~36 inherited skills available. List both; the
      // inherited ones are not deletable from a single agent's view (they are
      // shared) and a local skill shadows a global one of the same name.
      const local = scanSkillDir(skillsRootFor(name), 'agent', true)
      const localNames = new Set(local.map((s) => s.name))
      const inherited = scanSkillDir(globalRoot, 'global', false).filter((s) => !localNames.has(s.name))
      skills = [...local, ...inherited]
    }
    json(res, skills)
    return true
  }

  if (skillsMatch && method === 'POST') {
    const agentName = decodeURIComponent(skillsMatch[1])
    if (!agentExistsFor(agentName)) { json(res, { error: 'Agent not found' }, 404); return true }
    const body = await readBody(req)
    const { name: rawSkillName, description } = JSON.parse(body.toString()) as { name: string; description: string }
    const skillName = sanitizeSkillName(rawSkillName || '')
    if (!skillName) { json(res, { error: 'Skill name is required' }, 400); return true }
    if (!description) { json(res, { error: 'Skill description is required' }, 400); return true }

    const skillDir = join(skillsRootFor(agentName), skillName)
    if (existsSync(skillDir)) { json(res, { error: 'Skill already exists' }, 409); return true }
    mkdirSync(skillDir, { recursive: true })

    try {
      const skillMd = await generateSkillMd(skillName, description)
      atomicWriteFileSync(join(skillDir, 'SKILL.md'), skillMd)
    } catch (err) {
      rmSync(skillDir, { recursive: true, force: true })
      json(res, { error: 'Failed to generate skill' }, 500)
      return true
    }

    json(res, { ok: true, name: skillName })
    return true
  }

  return false
}
