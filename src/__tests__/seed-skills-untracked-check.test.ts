// Card f39dd8fb: install-macos.sh/install-linux.sh used to `cp -r` seed-skills/<skill>/ straight
// from disk into a new install's ~/.claude/skills/, so anything physically sitting there shipped
// verbatim -- untracked scratch files, gitignored build debris. The concrete find was
// seed-skills/ui-ux-pro-max/scripts/__pycache__/*.pyc, gitignored, with another machine's HOME
// path baked into it -- exactly the shape the HOME_PATH_RX guard forbids in shipped templates, and
// invisible to it because that guard runs against a checked-out git ref (fleet-test.sh), which by
// construction never has an untracked file.
//
// This is the DETECTION half of the fix: store/seed-skills-untracked-check.sh inspects the LIVE
// checkout instead of a git ref, and must be run from doctor.sh, never from fleet-test.sh's
// isolated worktree (there is nothing untracked there to find). The SHIP half (install-*.sh now
// copying from `git archive` instead of disk) is not separately unit-testable without executing a
// real install; this test covers the detector plus its wiring into doctor.sh as the consumer.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'seed-skills-untracked-check.sh')
const DOCTOR = join(ROOT, 'scripts', 'doctor.sh')

function git(repo: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'seed-skills-check-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  mkdirSync(join(dir, 'seed-skills', 'demo-skill'), { recursive: true })
  writeFileSync(join(dir, 'seed-skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\n---\nbody\n')
  git(dir, 'add', 'seed-skills/demo-skill/SKILL.md')
  git(dir, 'commit', '-q', '-m', 'seed demo-skill')
  return dir
}

function run(repo: string) {
  return spawnSync('bash', [SCRIPT], { encoding: 'utf-8', env: { ...process.env, MARVEEN_REPO: repo } })
}

describe('seed-skills-untracked-check.sh is syntactically valid', () => {
  it('bash -n passes', () => {
    const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)
  })
})

describe('seed-skills-untracked-check.sh finds what cp -r would silently ship (card f39dd8fb)', () => {
  it('a clean seed-skills/ tree reports CLEAN, exit 0', () => {
    const repo = freshRepo()
    const r = run(repo)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('CLEAN')
  })

  it('a plain untracked file is flagged, exit 1', () => {
    const repo = freshRepo()
    writeFileSync(join(repo, 'seed-skills', 'demo-skill', 'scratch.txt'), 'oops\n')
    const r = run(repo)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('seed-skills/demo-skill/scratch.txt')
  })

  it('a GITIGNORED file is ALSO flagged -- this is the real pyc shape, .gitignore does not protect against cp -r', () => {
    const repo = freshRepo()
    writeFileSync(join(repo, '.gitignore'), '__pycache__/\n')
    mkdirSync(join(repo, 'seed-skills', 'demo-skill', '__pycache__'))
    writeFileSync(join(repo, 'seed-skills', 'demo-skill', '__pycache__', 'core.pyc'), 'binary-ish\n')
    const r = run(repo)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('__pycache__')
  })

  it('git add-ing the file makes it CLEAN again -- proves the fix path, not just the detection', () => {
    const repo = freshRepo()
    writeFileSync(join(repo, 'seed-skills', 'demo-skill', 'scratch.txt'), 'oops\n')
    expect(run(repo).status).toBe(1)
    git(repo, 'add', 'seed-skills/demo-skill/scratch.txt')
    git(repo, 'commit', '-q', '-m', 'actually belongs')
    const r = run(repo)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('CLEAN')
  })

  it('an untracked file OUTSIDE seed-skills/ is ignored -- this guard is scoped, not a repo-wide untracked scan', () => {
    const repo = freshRepo()
    writeFileSync(join(repo, 'unrelated-scratch.txt'), 'not seed-skills\n')
    const r = run(repo)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('CLEAN')
  })

  it('a non-git directory errors closed rather than reporting false CLEAN', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-skills-not-a-repo-'))
    mkdirSync(join(dir, 'seed-skills'))
    const r = run(dir)
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('ERROR:not-a-git-repo')
  })
})

describe('seed-skills-untracked-check.sh has a real consumer (card f39dd8fb)', () => {
  // A detector nothing calls is decoration, not a guard. doctor.sh is the sanctioned place: the
  // repo's own vitest guards run against a checked-out git ref where an untracked file cannot
  // exist by construction, so this MUST run against the live tree instead.
  it('doctor.sh invokes it', () => {
    const text = readFileSync(DOCTOR, 'utf-8')
    expect(text).toContain('store/seed-skills-untracked-check.sh')
  })
})
