// store/vendor-skill.sh --dest (card da47b612, plan-grilling change 2): a skill vendored for ONE
// agent must land in that agent's skills dir and leave the GLOBAL ~/.claude/skills untouched.
//
// WHY THIS MATTERS. Every skill in ~/.claude/skills is offered to EVERY agent's session context.
// Before --dest the script could only write there, so vendoring a per-agent toolset (e.g. 14
// security skills for cybersec + cybered) would have fanned them out to the whole fleet -- the
// grilling verdict named this as the single most likely failure of the import.
//
// END TO END, same harness as vendor-skill-no-git.test.ts: the script is copied into a sandbox (so
// its store/adopted/ clone cache is isolated), HOME points into the sandbox (so the DEFAULT global
// dir is a sandbox dir we can count), and the upstream is a real local git repo (no network).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let sandbox: string
let upstreamRepo: string
let home: string
let globalSkills: string

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

// CLAUDE_SKILLS_DIR is deliberately removed: the point is to prove the DEFAULT global dir
// (derived from HOME) stays untouched, not a dir an inherited env var happens to name.
function envFor(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extra }
  if (!('CLAUDE_SKILLS_DIR' in extra)) delete env.CLAUDE_SKILLS_DIR
  return env
}

function runVendor(args: string[], extra: Record<string, string> = {}) {
  return spawnSync('bash', [join(sandbox, 'vendor-skill.sh'), '--repo', upstreamRepo, ...args], {
    cwd: sandbox,
    encoding: 'utf-8',
    env: envFor(extra),
  })
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'vendor-skill-dest-'))
  copyFileSync(join(ROOT, 'store', 'vendor-skill.sh'), join(sandbox, 'vendor-skill.sh'))

  home = join(sandbox, 'home')
  globalSkills = join(home, '.claude', 'skills')
  // A pre-existing global skill, so "unchanged" is measured against a non-empty baseline.
  mkdirSync(join(globalSkills, 'already-there'), { recursive: true })
  writeFileSync(join(globalSkills, 'already-there', 'SKILL.md'), '# existing\n')

  upstreamRepo = join(sandbox, 'upstream-repo')
  mkdirSync(join(upstreamRepo, 'skills', 'fake-sec-skill'), { recursive: true })
  git(['init', '-q', '-b', 'main'], upstreamRepo)
  git(['config', 'user.email', 'a@b'], upstreamRepo)
  git(['config', 'user.name', 't'], upstreamRepo)
  writeFileSync(join(upstreamRepo, 'skills', 'fake-sec-skill', 'SKILL.md'), '# fake sec skill\n')
  writeFileSync(join(upstreamRepo, 'LICENSE'), 'Apache License 2.0 (test fixture)\n')
  git(['add', '.'], upstreamRepo)
  git(['commit', '-q', '-m', 'one'], upstreamRepo)
})

afterAll(() => { rmSync(sandbox, { recursive: true, force: true }) })

describe('vendor-skill.sh --dest (card da47b612)', () => {
  it('vendors into --dest and leaves the global skills dir byte-for-byte untouched', () => {
    const before = readdirSync(globalSkills).sort()
    const dest = join(sandbox, 'agent-skills')
    const r = runVendor(['--name', 'fake-sec-skill', '--subdir', 'skills/fake-sec-skill', '--dest', dest])
    expect(r.status).toBe(0)

    expect(existsSync(join(dest, 'fake-sec-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dest, 'fake-sec-skill', 'VENDORED.md'))).toBe(true)
    expect(existsSync(join(dest, 'fake-sec-skill', 'UPSTREAM-LICENSE'))).toBe(true)
    expect(readdirSync(globalSkills).sort()).toEqual(before)
    expect(existsSync(join(globalSkills, 'fake-sec-skill'))).toBe(false)
  })

  it('the recorded re-vendor command carries --dest, so a re-vendor goes back to the same place', () => {
    const dest = join(sandbox, 'agent-skills')
    const vendored = readFileSync(join(dest, 'fake-sec-skill', 'VENDORED.md'), 'utf-8')
    expect(vendored).toContain(`--dest ${dest}`)
  })

  it('--dest wins over an inherited CLAUDE_SKILLS_DIR', () => {
    const envDir = join(sandbox, 'env-skills')
    const dest = join(sandbox, 'dest-wins')
    const r = runVendor(
      ['--name', 'fake-sec-skill', '--subdir', 'skills/fake-sec-skill', '--dest', dest],
      { CLAUDE_SKILLS_DIR: envDir },
    )
    expect(r.status).toBe(0)
    expect(existsSync(join(dest, 'fake-sec-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(envDir, 'fake-sec-skill'))).toBe(false)
  })

  it('an explicit but empty --dest is refused instead of falling back to the global dir', () => {
    const before = readdirSync(globalSkills).sort()
    const r = runVendor(['--name', 'fake-sec-skill', '--subdir', 'skills/fake-sec-skill', '--dest', ''])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--dest needs a directory')
    expect(readdirSync(globalSkills).sort()).toEqual(before)
  })

  it('a trailing --dest with no value is refused the same way', () => {
    const before = readdirSync(globalSkills).sort()
    const r = runVendor(['--name', 'fake-sec-skill', '--subdir', 'skills/fake-sec-skill', '--dest'])
    expect(r.status).toBe(2)
    expect(readdirSync(globalSkills).sort()).toEqual(before)
  })

  it('CONTROL: without --dest the default is unchanged -- it still vendors into the global dir', () => {
    const r = runVendor(['--name', 'fake-sec-skill', '--subdir', 'skills/fake-sec-skill'])
    expect(r.status).toBe(0)
    expect(existsSync(join(globalSkills, 'fake-sec-skill', 'SKILL.md'))).toBe(true)
  })
})
