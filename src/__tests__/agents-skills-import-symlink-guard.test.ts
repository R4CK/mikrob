// Card d2d47a92 WhiteHat F1(b) (comment 24868): POST /api/agents/:name/skills/import extracts an
// uploaded .zip with `unzip -o` straight into the agent's skills dir. If a top-level entry name in
// the archive (e.g. "core-a") already exists as a provisioner symlink into the shared global
// skills catalog, the extraction writes THROUGH that link -- proven live by WhiteHat with a real
// unzip 6.00 PoC -- because the name pre-existed before the import, so the existing
// findSymlinkTaintedEntries(after-diff) check never looks at it (it only inspects NEW entries).
//
// This test provisions a real symlinked skill (matching what skill-map-provisioner.ts creates),
// builds a real .zip whose only entry is that same skill name with different content, imports it
// through the real route handler, and asserts the shared global copy is untouched -- only the
// agent-local copy changed.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, lstatSync, symlinkSync, existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { tryHandleAgentsSkills } from '../web/routes/agents-skills.js'
import { agentDir } from '../web/agent-config.js'
import { scaffoldAgentDir } from '../web/agent-scaffold.js'
import type { RouteContext } from '../web/routes/types.js'

const AGENT = 'skillimporttest-d2d47a92'

function buildZip(entryName: string, skillMdContent: string): Buffer {
  // Build the archive with python3's stdlib zipfile -- unzip is the only archiver binary
  // confirmed present on this host, and it only extracts.
  const stageDir = mkdtempSync(join(tmpdir(), 'skill-import-zip-'))
  const zipPath = join(stageDir, 'skill.zip')
  const py = `
import zipfile
with zipfile.ZipFile(${JSON.stringify(zipPath)}, 'w') as z:
    z.writestr(${JSON.stringify(`${entryName}/SKILL.md`)}, ${JSON.stringify(skillMdContent)})
`
  execFileSync('python3', ['-I', '-c', py])
  const data = readFileSync(zipPath)
  rmSync(stageDir, { recursive: true, force: true })
  return data
}

// Like buildZip but uses rawEntryPath as the literal archive entry path (for ./-prefix tests).
function buildZipRawEntry(rawEntryPath: string, content: string): Buffer {
  const stageDir = mkdtempSync(join(tmpdir(), 'skill-import-zip-'))
  const zipPath = join(stageDir, 'skill.zip')
  const py = `
import zipfile
with zipfile.ZipFile(${JSON.stringify(zipPath)}, 'w') as z:
    z.writestr(${JSON.stringify(rawEntryPath)}, ${JSON.stringify(content)})
`
  execFileSync('python3', ['-I', '-c', py])
  const data = readFileSync(zipPath)
  rmSync(stageDir, { recursive: true, force: true })
  return data
}

function multipartBody(boundary: string, zipData: Buffer): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\nContent-Type: application/zip\r\n\r\n`,
    'binary',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'binary')
  return Buffer.concat([head, zipData, tail])
}

async function importSkillZip(name: string, zipData: Buffer): Promise<{ status: number; body: any }> {
  const boundary = 'testboundary123'
  const body = multipartBody(boundary, zipData)
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
  }
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420/api/agents/${encodeURIComponent(name)}/skills/import`)
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', body)
    ;(req as unknown as EventEmitter).emit('end')
  })
  const handled = await tryHandleAgentsSkills(
    { req, res, path: url.pathname, method: 'POST', url } as unknown as RouteContext,
  )
  expect(handled).toBe(true)
  return { status: out.status || 200, body: out.body }
}

const GLOBAL_SKILL_NAME = `d2d47a92-global-skill-${process.pid}`
const GLOBAL_SKILL_DIR = join(homedir(), '.claude', 'skills', GLOBAL_SKILL_NAME)
const GLOBAL_ORIGINAL_CONTENT = '# global original\n'

beforeAll(() => {
  mkdirSync(GLOBAL_SKILL_DIR, { recursive: true })
  writeFileSync(join(GLOBAL_SKILL_DIR, 'SKILL.md'), GLOBAL_ORIGINAL_CONTENT)
})

afterAll(() => {
  rmSync(GLOBAL_SKILL_DIR, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(agentDir(AGENT), { recursive: true, force: true })
})

describe('POST /api/agents/:name/skills/import -- symlink write-through guard (card d2d47a92 F1b)', () => {
  it('importing a zip whose entry name matches a provisioned symlink never touches the shared global skill', async () => {
    mkdirSync(agentDir(AGENT), { recursive: true })
    scaffoldAgentDir(AGENT)
    const skillsDir = join(agentDir(AGENT), '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    symlinkSync(GLOBAL_SKILL_DIR, join(skillsDir, GLOBAL_SKILL_NAME))
    expect(lstatSync(join(skillsDir, GLOBAL_SKILL_NAME)).isSymbolicLink()).toBe(true)

    const zip = buildZip(GLOBAL_SKILL_NAME, 'ATTACKER-OR-STALE-OVERWRITE\n')
    await importSkillZip(AGENT, zip)

    // The route's own before/after name-diff (separate, pre-existing behavior, not part of this
    // card) reports "no valid skill found" whenever the archive's top-level name already existed
    // -- true for a real dir too, not just a symlink -- but the extraction itself still runs
    // unconditionally before that check. What matters for this card is where the bytes land.
    // The shared global copy, read by EVERY agent, must be exactly as it was.
    expect(readFileSync(join(GLOBAL_SKILL_DIR, 'SKILL.md'), 'utf-8')).toBe(GLOBAL_ORIGINAL_CONTENT)
    // The agent's own copy should have the imported content instead.
    expect(readFileSync(join(skillsDir, GLOBAL_SKILL_NAME, 'SKILL.md'), 'utf-8')).toBe('ATTACKER-OR-STALE-OVERWRITE\n')
    expect(lstatSync(join(skillsDir, GLOBAL_SKILL_NAME)).isSymbolicLink()).toBe(false)
  })

  // N1 regression: a zip entry with a leading ./ prefix (e.g. ./skill-name/SKILL.md) must be
  // normalised before name extraction so detach fires on the real skill directory, not on '.'
  // (which is the skillsDir itself -- a no-op). Without the fix, unzip -o writes through the
  // provisioned symlink and poisons the shared global skill. Red on 8e01778a0, green on fix.
  it('importing a zip with a ./-prefixed entry path still detaches the symlink and never touches the global skill (N1)', async () => {
    mkdirSync(agentDir(AGENT), { recursive: true })
    scaffoldAgentDir(AGENT)
    const skillsDir = join(agentDir(AGENT), '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    symlinkSync(GLOBAL_SKILL_DIR, join(skillsDir, GLOBAL_SKILL_NAME))

    // Archive entry is literally "./<name>/SKILL.md" -- the bypass
    const zip = buildZipRawEntry(`./${GLOBAL_SKILL_NAME}/SKILL.md`, 'ATTACKER-DOTSLASH\n')
    await importSkillZip(AGENT, zip)

    expect(readFileSync(join(GLOBAL_SKILL_DIR, 'SKILL.md'), 'utf-8')).toBe(GLOBAL_ORIGINAL_CONTENT)
    expect(lstatSync(join(skillsDir, GLOBAL_SKILL_NAME)).isSymbolicLink()).toBe(false)
  })

  // N1 variant: a/../b style segment -- entry normalises away the dot-segment, traversal check
  // still fires because .. remains after normalization.
  it('importing a zip with a ../ traversal entry is rejected (N1 variant)', async () => {
    mkdirSync(agentDir(AGENT), { recursive: true })
    scaffoldAgentDir(AGENT)
    const zip = buildZipRawEntry(`../escape-${GLOBAL_SKILL_NAME}/SKILL.md`, 'BAD\n')
    const { status } = await importSkillZip(AGENT, zip)
    expect(status).toBe(400)
  })

  // N1 variant: absolute path entry must be rejected.
  it('importing a zip with an absolute entry path is rejected (N1 variant)', async () => {
    mkdirSync(agentDir(AGENT), { recursive: true })
    scaffoldAgentDir(AGENT)
    const zip = buildZipRawEntry(`/etc/skill-${GLOBAL_SKILL_NAME}/SKILL.md`, 'BAD\n')
    const { status } = await importSkillZip(AGENT, zip)
    expect(status).toBe(400)
  })

  // N2 regression (B1): detachSkillSymlinkIfAny on a FOREIGN symlink (pointing outside the
  // global skills catalog) must NOT copy the target -- it creates an empty dir instead.
  // Without the fix, an agent-bundle import with a foreign symlink in skillsDir causes the
  // target tree (potentially sensitive) to be duplicated into the agent dir.
  it('detaching a foreign symlink creates an empty dir without copying target (N2 / B1)', async () => {
    mkdirSync(agentDir(AGENT), { recursive: true })
    scaffoldAgentDir(AGENT)
    const skillsDir = join(agentDir(AGENT), '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })

    // A foreign dir (outside ~/.claude/skills) with a secret file
    const foreignDir = mkdtempSync(join(tmpdir(), 'foreign-skill-'))
    const secretFile = join(foreignDir, 'secret.txt')
    writeFileSync(secretFile, 'TOP-SECRET\n')
    // Plant a foreign symlink in the agent skillsDir
    const foreignLinkName = `d2d47a92-foreign-${process.pid}`
    symlinkSync(foreignDir, join(skillsDir, foreignLinkName))

    const zip = buildZip(foreignLinkName, 'IMPORT-CONTENT\n')
    await importSkillZip(AGENT, zip)

    // secret.txt must NOT be in the agent's skill dir after detach
    expect(existsSync(join(skillsDir, foreignLinkName, 'secret.txt'))).toBe(false)
    // The link itself is gone (replaced with a real dir)
    expect(lstatSync(join(skillsDir, foreignLinkName)).isSymbolicLink()).toBe(false)

    rmSync(foreignDir, { recursive: true, force: true })
  })
})
